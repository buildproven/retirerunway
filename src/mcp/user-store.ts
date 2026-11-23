// Local store for one user's retirement facts (REQ-MCP-10..15), and the
// DataStore contract it shares with the GitHub repo store in
// src/mcp/git-store.ts (REQ-MCP-17..21). The data
// lives on the user's machine under $RETIRE_RUNWAY_DATA_DIR (default
// ~/.retire-runway), never inside the package or repo (NFR-02 local-first):
//
//   profile.json              { version: 1, updatedAt, profile }
//   snapshots/<asOf>.json     { version: 1, portfolio }   (account numbers removed)
//
// Directories the store creates are mode 700 and files mode 600. Each file is written to a
// unique temporary file and renamed into place, so a reader never sees a
// half-written file and a failed write leaves the old file intact.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { fileURLToPath } from 'node:url'
import * as z from 'zod'
import { isCalendarDate } from '../engine/alerts'
import {
  isBrokerageLinkName,
  matchAccountType,
  matchAssetClass,
} from '../engine/csv-parser'
import type { Account, Portfolio, UserProfile } from '../engine/types'
import {
  SECTION_KEYS,
  applySectionUpdate,
  emptySections,
  migrateSingleText,
} from './plan-notes'
import type { NoteSections, SectionKey } from './plan-notes'
import { MAX_NOTES_LENGTH, portfolioSchema, userProfileSchema } from './schemas'

const DATA_DIR_ENV = 'RETIRE_RUNWAY_DATA_DIR'
export const PROFILE_FILE = 'profile.json'
/** Plan notes in sections, saved with save_plan_notes. */
export const NOTES_FILE = 'notes.json'
/** notes.json in sections; version 1 held one text (migrated on read). */
const NOTES_FILE_VERSION = 2
export const SNAPSHOT_DIR = 'snapshots'
const FILE_VERSION = 1
const PACKAGE_NAME = 'retire-runway'
export const SNAPSHOT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/
// Temporary files from an interrupted write: `.<name>.<pid>.<uuid>.tmp`.
const TEMPORARY_FILE = /^\..+\.\d+\.[0-9a-f-]{36}\.tmp$/

/** A store failure the tools report as a field-level error. */
export class UserStoreError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
    this.name = 'UserStoreError'
  }
}

export interface SavedProfile {
  readonly file: string
  readonly updatedAt: string
  readonly profile: UserProfile
}

export interface SavedNotes {
  readonly file: string
  readonly sections: NoteSections
  /** True when the file still holds one text from before sections. */
  readonly migratedFromSingleText: boolean
}

export interface NotesSectionSave {
  readonly section: SectionKey
  readonly text: string
  readonly expectedRevision: number
  readonly updatedAt: string
}

export type NotesSaveResult =
  | {
      readonly ok: true
      readonly notes: SavedNotes
      readonly section: SectionKey
      readonly revision: number
    }
  | {
      readonly ok: false
      readonly section: SectionKey
      readonly currentRevision: number
    }

export interface SavedSnapshot {
  readonly file: string
  readonly asOfDate: string
  readonly portfolio: Portfolio
}

export interface DeleteReport {
  readonly removed: string[]
  readonly kept: string[]
}

/**
 * Where one user's saved data lives, behind which the tools read and write
 * it (REQ-MCP-21): the local folder (UserStore) or a private GitHub repo
 * folder (GitStore). Both hold the same files: profile.json and
 * snapshots/<asOf>.json. Failures the user can act on are UserStoreErrors.
 */
export interface DataStore {
  /** Names the data location in tool output, e.g. { dataDir }. */
  readonly location: Readonly<Record<string, string>>
  saveProfile(profile: UserProfile, updatedAt: string): Promise<SavedProfile>
  readProfile(): Promise<SavedProfile | undefined>
  saveSnapshot(portfolio: Portfolio): Promise<SavedSnapshot>
  /**
   * Replaces one notes section when its revision is `expectedRevision`,
   * else reports the current revision and writes nothing.
   */
  saveNotesSection(update: NotesSectionSave): Promise<NotesSaveResult>
  readNotes(): Promise<SavedNotes | undefined>
  /** Every dated snapshot, newest first. */
  listSnapshots(): Promise<SavedSnapshot[]>
  newestSnapshot(): Promise<SavedSnapshot | undefined>
  /** Removes only the files the store owns and reports what it kept. */
  deleteAll(): Promise<DeleteReport>
}

const profileFileSchema = z.strictObject({
  version: z.literal(FILE_VERSION),
  updatedAt: z.iso.datetime(),
  profile: userProfileSchema,
})

// Version 1: one text, read and split into sections by its headings.
const singleTextNotesSchema = z.strictObject({
  version: z.literal(FILE_VERSION),
  updatedAt: z.iso.datetime(),
  notes: z.string().max(MAX_NOTES_LENGTH),
})

const noteSectionSchema = z.strictObject({
  text: z.string().max(MAX_NOTES_LENGTH),
  revision: z.number().int().min(0),
  updatedAt: z.iso.datetime().nullable(),
})

const sectionedNotesSchema = z.strictObject({
  version: z.literal(NOTES_FILE_VERSION),
  sections: z.strictObject(
    Object.fromEntries(
      SECTION_KEYS.map(key => [key, noteSectionSchema])
    ) as Record<SectionKey, typeof noteSectionSchema>
  ),
})

const snapshotFileSchema = z.strictObject({
  version: z.literal(FILE_VERSION),
  portfolio: portfolioSchema,
})

function isPackageManifest(path: string): boolean {
  if (!existsSync(path)) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    // A malformed package.json in an ancestor directory is not this package.
    if (error instanceof SyntaxError) return false
    throw error
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    'name' in parsed &&
    parsed.name === PACKAGE_NAME
  )
}

let packageRoot: string | undefined | null = null

/**
 * The nearest directory at or above this module (src/mcp in a checkout, or
 * node_modules/.cache/retire-runway-mcp for the bundle) that holds this
 * package's package.json.
 */
function findPackageRoot(): string | undefined {
  if (packageRoot !== null) return packageRoot
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (isPackageManifest(join(dir, 'package.json'))) break
    const parent = dirname(dir)
    if (parent === dir) {
      packageRoot = undefined
      return packageRoot
    }
    dir = parent
  }
  packageRoot = realpathSync.native(dir)
  return packageRoot
}

/** The real path of `path`, resolving symlinks in the part of it that exists. */
function realPathOfExisting(path: string): string {
  let existing = path
  const missing: string[] = []
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    missing.unshift(basename(existing))
    existing = parent
  }
  return join(realpathSync.native(existing), ...missing)
}

function isInside(path: string, dir: string): boolean {
  const offset = relative(dir, path)
  return (
    offset === '' ||
    (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  )
}

/**
 * The data directory for `env`: $RETIRE_RUNWAY_DATA_DIR with a leading `~`
 * expanded, or ~/.retire-runway when it is unset or empty. Throws a
 * UserStoreError for a relative path or a path inside the package.
 */
export function resolveDataDir(
  env: Readonly<Record<string, string | undefined>>,
  root: string | undefined = findPackageRoot()
): string {
  const configured = env[DATA_DIR_ENV]
  let dir: string
  if (configured === undefined || configured === '') {
    dir = join(homedir(), '.retire-runway')
  } else if (configured === '~' || /^~[\\/]/.test(configured)) {
    dir = join(homedir(), configured.slice(1))
  } else if (isAbsolute(configured)) {
    dir = resolve(configured)
  } else {
    throw new UserStoreError(
      DATA_DIR_ENV,
      `${DATA_DIR_ENV} must be an absolute path, got "${configured}"`
    )
  }
  if (root !== undefined) {
    if (isInside(realPathOfExisting(dir), realpathSync.native(root))) {
      throw new UserStoreError(
        DATA_DIR_ENV,
        `${DATA_DIR_ENV} (${dir}) is inside the retire-runway package or repo directory; user data must live outside it, for example in ~/.retire-runway`
      )
    }
  }
  return dir
}

// An account-number-like token at a word start: optional mask prefix (`#`,
// `*`, `.`), up to two letters (Fidelity `Z`), then digits, mask characters
// and hyphens. A token counts as an account number when it has at least four
// digits, so plan names such as `401k` and `403b` stay. Any other run of four
// or more digits (`Account12345`) goes too.
const ACCOUNT_NUMBER_TOKEN =
  /(?<![A-Za-z\d])[#*.]*[A-Za-z]{0,2}[\dXx*][\dXx*-]*/g

/** The account name with every account number removed. */
export function removeAccountNumbers(name: string): string {
  return name
    .replace(ACCOUNT_NUMBER_TOKEN, token =>
      (token.match(/\d/g)?.length ?? 0) >= 4 ? ' ' : token
    )
    .replace(/\d{4,}/g, ' ')
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-#:,]+|[\s\-#:,]+$/g, '')
}

/**
 * The portfolio as stored in a snapshot: account names without account
 * numbers, and positional IDs instead of content-hash IDs (those hash the
 * account name, so they would let the number be recovered).
 */
export function snapshotPortfolio(
  portfolio: { readonly name: string; readonly accounts: readonly Account[] },
  asOfDate: string
): Portfolio {
  const used = new Set<string>()
  const accounts: Account[] = portfolio.accounts.map((account, index) => {
    const base = removeAccountNumbers(account.name) || `Account ${index + 1}`
    let name = base
    for (let count = 2; used.has(name); count += 1) name = `${base} (${count})`
    used.add(name)
    return {
      ...account,
      id: `account-${index + 1}`,
      name,
      holdings: account.holdings.map((holding, holdingIndex) => ({
        ...holding,
        id: `holding-${index + 1}-${holdingIndex + 1}`,
      })),
    }
  })
  return {
    id: `snapshot-${asOfDate}`,
    name: portfolio.name,
    accounts,
    asOfDate,
  }
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

function parseJson(text: string, label: string, field: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new UserStoreError(field, `${label} is not valid JSON (${reason})`)
  }
}

async function readJsonFile(
  path: string,
  label: string,
  field: string
): Promise<unknown> {
  return parseJson(await readFile(path, 'utf8'), label, field)
}

/** The text a store writes for `value`. */
export function fileText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** The profile.json contents for a profile saved at `updatedAt`. */
export function profileFile(profile: UserProfile, updatedAt: string): unknown {
  return { version: FILE_VERSION, updatedAt, profile }
}

/** The notes.json contents for the given sections. */
export function notesFile(sections: NoteSections): unknown {
  return { version: NOTES_FILE_VERSION, sections }
}

/** The saved plan notes in notes.json text, or a field error naming the file. */
export function parseNotesText(text: string): SavedNotes {
  return parseNotes(parseJson(text, NOTES_FILE, 'notes'))
}

function parseNotes(raw: unknown): SavedNotes {
  const sectioned = sectionedNotesSchema.safeParse(raw)
  if (sectioned.success) {
    return {
      file: NOTES_FILE,
      sections: sectioned.data.sections,
      migratedFromSingleText: false,
    }
  }
  const single = singleTextNotesSchema.safeParse(raw)
  if (single.success) {
    return {
      file: NOTES_FILE,
      sections: migrateSingleText(single.data.notes, single.data.updatedAt),
      migratedFromSingleText: true,
    }
  }
  throw new UserStoreError(
    'notes',
    `${NOTES_FILE} is not saved plan notes (${describeIssues(sectioned.error)}); call save_plan_notes again`
  )
}

/**
 * Applies one section save to the notes read from a store (or empty notes):
 * the result to write, or the conflict to report.
 */
export function updateNotes(
  current: SavedNotes | undefined,
  update: NotesSectionSave
): NotesSaveResult {
  const applied = applySectionUpdate(
    current?.sections ?? emptySections(),
    update.section,
    update.text,
    update.expectedRevision,
    update.updatedAt
  )
  if (!applied.ok) {
    return {
      ok: false,
      section: update.section,
      currentRevision: applied.currentRevision,
    }
  }
  return {
    ok: true,
    section: update.section,
    revision: applied.revision,
    notes: {
      file: NOTES_FILE,
      sections: applied.sections,
      migratedFromSingleText: false,
    },
  }
}

/** The snapshot file path and contents, or a field error for a bad date. */
export function snapshotFile(portfolio: Portfolio): {
  file: string
  value: unknown
} {
  if (!isCalendarDate(portfolio.asOfDate)) {
    throw new UserStoreError(
      'asOfDate',
      'Must be a real calendar date (YYYY-MM-DD)'
    )
  }
  return {
    file: `${SNAPSHOT_DIR}/${portfolio.asOfDate}.json`,
    value: { version: FILE_VERSION, portfolio },
  }
}

/** The saved profile in profile.json text, or a field error naming the file. */
export function parseProfileText(text: string): SavedProfile {
  return parseProfile(parseJson(text, PROFILE_FILE, 'profile'))
}

function parseProfile(raw: unknown): SavedProfile {
  const parsed = profileFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new UserStoreError(
      'profile',
      `${PROFILE_FILE} is not a saved profile (${describeIssues(parsed.error)}); call save_profile again`
    )
  }
  return {
    file: PROFILE_FILE,
    updatedAt: parsed.data.updatedAt,
    profile: parsed.data.profile,
  }
}

/** The snapshot in snapshots/<asOfDate>.json text, or a field error naming the file. */
export function parseSnapshotText(
  text: string,
  asOfDate: string
): SavedSnapshot {
  const file = `${SNAPSHOT_DIR}/${asOfDate}.json`
  return parseSnapshot(parseJson(text, file, 'portfolio'), asOfDate)
}

function parseSnapshot(raw: unknown, asOfDate: string): SavedSnapshot {
  const file = `${SNAPSHOT_DIR}/${asOfDate}.json`
  const parsed = snapshotFileSchema.safeParse(raw)
  if (!parsed.success) {
    throw new UserStoreError(
      'portfolio',
      `${file} is not a saved snapshot (${describeIssues(parsed.error)}); import it again with import_positions and save: true`
    )
  }
  if (parsed.data.portfolio.asOfDate !== asOfDate) {
    throw new UserStoreError(
      'portfolio',
      `${file} holds a portfolio dated ${parsed.data.portfolio.asOfDate}, not ${asOfDate}`
    )
  }
  return {
    file,
    asOfDate,
    portfolio: reclassifyHoldings(parsed.data.portfolio),
  }
}

/**
 * The portfolio with each holding's asset class from the current
 * classification rules, so a snapshot saved before a rule fix (BUI-1939)
 * reads back corrected. A holding no rule matches keeps its saved class.
 * Account types are re-derived the same way for the rules added since
 * snapshots were first saved: an import gave an NQDC plan (before BUI-1940)
 * and a Fidelity BrokerageLink window (a workplace plan, not a taxable
 * account) the fallback type `brokerage`, so a `brokerage` account whose name
 * matches either rule reads with that rule's type. Every other saved type is
 * kept, because the older rules already set it at import or the user chose it.
 * The file is not rewritten.
 */
function rederivedAccountType(account: Account): Account['accountType'] {
  if (account.accountType !== 'brokerage') return account.accountType
  const matched = matchAccountType(account.name)
  if (matched === 'nqdc') return 'nqdc'
  if (isBrokerageLinkName(account.name) && matched !== undefined) return matched
  return account.accountType
}

function reclassifyHoldings(portfolio: Portfolio): Portfolio {
  return {
    ...portfolio,
    accounts: portfolio.accounts.map(account => ({
      ...account,
      accountType: rederivedAccountType(account),
      holdings: account.holdings.map(holding => ({
        ...holding,
        assetClass:
          matchAssetClass(holding.symbol, holding.name) ?? holding.assetClass,
      })),
    })),
  }
}

/** The snapshot dates among file names, newest first. */
export function snapshotDates(names: readonly string[]): string[] {
  return names
    .map(name => SNAPSHOT_FILE.exec(name)?.[1])
    .filter(
      (date): date is string => date !== undefined && isCalendarDate(date)
    )
    .sort()
    .reverse()
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/** The store over one data directory. Reads never create anything. */
export class UserStore implements DataStore {
  constructor(readonly dir: string) {}

  get location(): Readonly<Record<string, string>> {
    return { dataDir: this.dir }
  }

  /** Opens the store at the data directory the environment names. */
  static fromEnv(
    env: Readonly<Record<string, string | undefined>> = process.env
  ): UserStore {
    return new UserStore(resolveDataDir(env))
  }

  /**
   * Creates `path` and any missing parents with mode 700 (the umask can only
   * remove bits). An existing directory keeps its mode, so a data directory
   * set to a shared folder such as ~ is never re-permissioned.
   */
  private async ensureDir(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }

  private async writeAtomic(
    relativePath: string,
    value: unknown
  ): Promise<void> {
    const target = join(this.dir, relativePath)
    await this.ensureDir(this.dir)
    await this.ensureDir(dirname(target))
    const temporary = join(
      dirname(target),
      `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(temporary, fileText(value), {
        mode: 0o600,
        flag: 'wx',
      })
      await chmod(temporary, 0o600)
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
  }

  async saveProfile(
    profile: UserProfile,
    updatedAt: string
  ): Promise<SavedProfile> {
    await this.writeAtomic(PROFILE_FILE, profileFile(profile, updatedAt))
    return { file: PROFILE_FILE, updatedAt, profile }
  }

  async readProfile(): Promise<SavedProfile | undefined> {
    let raw: unknown
    try {
      raw = await readJsonFile(
        join(this.dir, PROFILE_FILE),
        PROFILE_FILE,
        'profile'
      )
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    return parseProfile(raw)
  }

  async saveSnapshot(portfolio: Portfolio): Promise<SavedSnapshot> {
    const { file, value } = snapshotFile(portfolio)
    await this.writeAtomic(file, value)
    return { file, asOfDate: portfolio.asOfDate, portfolio }
  }

  async saveNotesSection(update: NotesSectionSave): Promise<NotesSaveResult> {
    const result = updateNotes(await this.readNotes(), update)
    if (result.ok) {
      await this.writeAtomic(NOTES_FILE, notesFile(result.notes.sections))
    }
    return result
  }

  async readNotes(): Promise<SavedNotes | undefined> {
    let raw: unknown
    try {
      raw = await readJsonFile(join(this.dir, NOTES_FILE), NOTES_FILE, 'notes')
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    return parseNotes(raw)
  }

  /** The dated snapshot files, newest first. */
  private async snapshotDates(): Promise<string[]> {
    let names: string[]
    try {
      names = await readdir(join(this.dir, SNAPSHOT_DIR))
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
    return snapshotDates(names)
  }

  private async readSnapshot(asOfDate: string): Promise<SavedSnapshot> {
    const file = `${SNAPSHOT_DIR}/${asOfDate}.json`
    const raw = await readJsonFile(join(this.dir, file), file, 'portfolio')
    return parseSnapshot(raw, asOfDate)
  }

  async listSnapshots(): Promise<SavedSnapshot[]> {
    const dates = await this.snapshotDates()
    return Promise.all(dates.map(date => this.readSnapshot(date)))
  }

  async newestSnapshot(): Promise<SavedSnapshot | undefined> {
    const [newest] = await this.snapshotDates()
    return newest === undefined ? undefined : this.readSnapshot(newest)
  }

  /**
   * Removes the files this store owns (profile.json, notes.json, dated snapshots and
   * temporary files from interrupted writes) and the snapshots directory
   * once empty. Anything else is kept and reported, so a data directory set
   * to a shared folder by mistake loses nothing that is not RetireRunway's.
   */
  async deleteAll(): Promise<DeleteReport> {
    const removed: string[] = []
    const kept: string[] = []
    let entries: string[]
    try {
      entries = (await readdir(this.dir)).sort()
    } catch (error) {
      if (isMissing(error)) return { removed, kept }
      throw error
    }
    for (const entry of entries) {
      const path = join(this.dir, entry)
      const info = await lstat(path)
      if (entry === SNAPSHOT_DIR && info.isDirectory()) {
        const inner = (await readdir(path)).sort()
        let left = 0
        for (const name of inner) {
          const innerInfo = await lstat(join(path, name))
          if (
            innerInfo.isFile() &&
            (SNAPSHOT_FILE.test(name) || TEMPORARY_FILE.test(name))
          ) {
            await unlink(join(path, name))
            removed.push(`${SNAPSHOT_DIR}/${name}`)
          } else {
            kept.push(`${SNAPSHOT_DIR}/${name}`)
            left += 1
          }
        }
        if (left === 0) await rmdir(path)
      } else if (
        info.isFile() &&
        (entry === PROFILE_FILE ||
          entry === NOTES_FILE ||
          TEMPORARY_FILE.test(entry))
      ) {
        await unlink(path)
        removed.push(entry)
      } else {
        kept.push(entry)
      }
    }
    return { removed, kept }
  }
}
