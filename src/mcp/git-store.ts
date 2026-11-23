// Saved user data in a private GitHub repo folder (REQ-MCP-17..21), for a
// server with no disk the owner's data can live on. It holds the same layout
// as the local folder store (src/mcp/user-store.ts):
//
//   <RETIRE_RUNWAY_DATA_PATH>/profile.json
//   <RETIRE_RUNWAY_DATA_PATH>/snapshots/<asOf>.json
//
// in the repo $RETIRE_RUNWAY_DATA_REPO (owner/repo), read and written through
// the GitHub contents API with an installation token of the GitHub App
// $RETIRE_RUNWAY_GITHUB_APP_ID, narrowed to that repo (src/mcp/github-app-token.ts,
// REQ-STORE-APP-1..5). Each write is one
// commit named `data: <tool> <file>`. A write sends the sha it read, so it
// never replaces a file another writer changed: on a 409 (or a 422 for a
// missing sha) it retries once with the same sha, which succeeds only when the
// branch moved and the file did not, and otherwise reports the conflict.
// Error text names the repo path and status and never holds the token.
import type {
  DataStore,
  DeleteReport,
  NotesSaveResult,
  NotesSectionSave,
  SavedNotes,
  SavedProfile,
  SavedSnapshot,
} from './user-store'
import {
  NOTES_FILE,
  PROFILE_FILE,
  SNAPSHOT_DIR,
  SNAPSHOT_FILE,
  UserStore,
  UserStoreError,
  fileText,
  notesFile,
  parseNotesText,
  parseProfileText,
  updateNotes,
  parseSnapshotText,
  profileFile,
  snapshotDates,
  snapshotFile,
} from './user-store'
import type { Portfolio, UserProfile } from '../engine/types'
import {
  APP_ID_ENV,
  APP_KEY_ENV,
  GitHubAppTokenError,
  createAppTokenSource,
} from './github-app-token'
import type { TokenSource } from './github-app-token'

const REPO_ENV = 'RETIRE_RUNWAY_DATA_REPO'
const PATH_ENV = 'RETIRE_RUNWAY_DATA_PATH'
const GIT_ENV = [REPO_ENV, PATH_ENV, APP_ID_ENV, APP_KEY_ENV] as const

const API = 'https://api.github.com'
const API_VERSION = '2022-11-28'
// The contents API lists at most 1,000 entries of a directory.
const LISTING_LIMIT = 1000
const DETAIL_LIMIT = 200
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

/**
 * The part of a fetch Response the store reads. A Response satisfies it; a
 * reply with only `json()` (a test double, a proxy client) is read too.
 */
interface FetchReply {
  readonly status?: number
  readonly ok?: boolean
  readonly text?: () => Promise<string>
  readonly json?: () => Promise<unknown>
}

type Fetch = (input: string, init: RequestInit) => Promise<FetchReply>

export interface GitStoreOptions {
  /** `owner/repo` of a private repo. */
  readonly repo: string
  /** Folder inside the repo, e.g. `retire-runway`. */
  readonly path: string
  /** A fixed token, or the GitHub App source that mints one per hour. */
  readonly token: string | TokenSource
  /** The tool writing, named in each commit message. */
  readonly tool: string
  readonly fetch?: Fetch
}

interface Reply {
  readonly method: string
  readonly status: number
  readonly body: unknown
}

interface RepoFile {
  readonly text: string
  readonly sha: string
}

interface DirEntry {
  readonly name: string
  /** `file` or `dir`; undefined when the listing leaves it out. */
  readonly type?: string
  readonly sha?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function dirEntry(value: unknown): DirEntry | undefined {
  if (!isRecord(value)) return undefined
  const { name, type, sha } = value
  if (typeof name !== 'string') return undefined
  return {
    name,
    ...(typeof type === 'string' ? { type } : {}),
    ...(typeof sha === 'string' ? { sha } : {}),
  }
}

/** The data folder as path segments; throws for an empty or escaping path. */
function folderSegments(path: string): string[] {
  const segments = path.split('/').filter(segment => segment !== '')
  if (segments.length === 0 || segments.some(s => s === '.' || s === '..')) {
    throw new UserStoreError(
      PATH_ENV,
      `${PATH_ENV} must name a folder inside the repo, such as retire-runway, got "${path}"`
    )
  }
  return segments
}

function fieldFor(file: string): string {
  if (file === PROFILE_FILE) return 'profile'
  if (file.startsWith(SNAPSHOT_DIR)) return 'portfolio'
  return PATH_ENV
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

function statusHint(status: number, method: string): string {
  if (status === 401) {
    return `; GitHub refused the token, call again for a new one, then check ${APP_ID_ENV} and ${APP_KEY_ENV}`
  }
  if (status === 404 && method !== 'GET') {
    return '; the repo does not exist or the GitHub App cannot write to it (it needs Contents: read and write)'
  }
  if (status === 403 || status === 429) {
    return '; the GitHub App lacks access to the repo contents or the GitHub rate limit is reached'
  }
  return ''
}

/** The store over one folder of a private GitHub repo. */
export class GitStore implements DataStore {
  readonly repo: string
  readonly path: string
  private readonly segments: string[]
  private readonly auth: string | TokenSource
  /** Every token this store sent, so error text can redact each one. */
  private readonly tokens = new Set<string>()
  private readonly tool: string
  private readonly fetchImpl: Fetch

  constructor(options: GitStoreOptions) {
    const [, name] = options.repo.split('/')
    if (!REPO_PATTERN.test(options.repo) || name === '.' || name === '..') {
      throw new UserStoreError(
        REPO_ENV,
        `${REPO_ENV} must be owner/repo, got "${options.repo}"`
      )
    }
    this.repo = options.repo
    this.segments = folderSegments(options.path)
    this.path = this.segments.join('/')
    this.auth = options.token
    if (typeof options.token === 'string' && options.token !== '') {
      this.tokens.add(options.token)
    }
    this.tool = options.tool
    // Resolved per call, so the global fetch in place at call time is used.
    this.fetchImpl =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  get location(): Readonly<Record<string, string>> {
    return { dataRepo: this.repo, dataPath: this.path }
  }

  /** `owner/repo/folder/file`, as error text names it. */
  private where(file: string): string {
    return file === ''
      ? `${this.repo}/${this.path}`
      : `${this.repo}/${this.path}/${file}`
  }

  private redact(text: string): string {
    let redacted = text
    for (const token of this.tokens) {
      redacted = redacted.split(token).join('[redacted]')
    }
    return redacted
  }

  /** The token to send; a minting failure names the setting to check. */
  private async currentToken(): Promise<string> {
    if (typeof this.auth === 'string') return this.auth
    let token: string
    try {
      token = await this.auth.token()
    } catch (error) {
      if (!(error instanceof GitHubAppTokenError)) throw error
      throw new UserStoreError(error.field, error.message)
    }
    this.tokens.add(token)
    return token
  }

  private detail(body: unknown): string {
    const message =
      isRecord(body) && typeof body.message === 'string'
        ? body.message
        : typeof body === 'string'
          ? body
          : ''
    const flat = this.redact(message).replace(/\s+/g, ' ').trim()
    if (flat === '') return ''
    return ` (${flat.length > DETAIL_LIMIT ? `${flat.slice(0, DETAIL_LIMIT)}…` : flat})`
  }

  private statusError(
    field: string,
    where: string,
    reply: Reply
  ): UserStoreError {
    return new UserStoreError(
      field,
      `GitHub returned ${reply.status} for ${where}${this.detail(reply.body)}${statusHint(reply.status, reply.method)}`
    )
  }

  private async request(
    method: string,
    url: string,
    where: string,
    field: string,
    body?: Record<string, unknown>
  ): Promise<Reply> {
    const token = await this.currentToken()
    let response: FetchReply
    let parsed: unknown
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'retire-runway-mcp',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      parsed = await this.readBody(response)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new UserStoreError(
        field,
        `could not reach GitHub for ${where} (${this.redact(reason)})`
      )
    }
    const status =
      typeof response.status === 'number'
        ? response.status
        : response.ok === true
          ? 200
          : 500
    // A revoked token is not reused: the next call mints a new one.
    if (status === 401 && typeof this.auth !== 'string') this.auth.forget(token)
    return { method, status, body: parsed }
  }

  /** The reply body as JSON, or as text when it is not JSON (a proxy error page). */
  private async readBody(response: FetchReply): Promise<unknown> {
    if (typeof response.text === 'function') {
      const text = await response.text()
      if (text === '') return undefined
      try {
        return JSON.parse(text)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return text
      }
    }
    if (typeof response.json === 'function') return response.json()
    return undefined
  }

  private contentsUrl(file: string): string {
    const segments = [...this.segments, ...file.split('/').filter(Boolean)]
    return `${API}/repos/${this.repo}/contents/${segments.map(encodeURIComponent).join('/')}`
  }

  private async getFile(file: string): Promise<RepoFile | undefined> {
    const field = fieldFor(file)
    const where = this.where(file)
    const reply = await this.request(
      'GET',
      this.contentsUrl(file),
      where,
      field
    )
    if (reply.status === 404) return undefined
    if (!isSuccess(reply.status)) throw this.statusError(field, where, reply)
    const body = reply.body
    if (
      !isRecord(body) ||
      (body.type !== undefined && body.type !== 'file') ||
      typeof body.sha !== 'string'
    ) {
      throw new UserStoreError(field, `${where} is not a file`)
    }
    // Over 1 MB GitHub sends no content and encoding `none`.
    if (body.encoding === 'none' || typeof body.content !== 'string') {
      throw new UserStoreError(
        field,
        `${where} is too large for the GitHub contents API (over 1 MB), so it cannot be read`
      )
    }
    return {
      text: Buffer.from(body.content, 'base64').toString('utf8'),
      sha: body.sha,
    }
  }

  /** The entries of a folder in the data folder, or none when it is missing. */
  private async listDir(dir: string): Promise<DirEntry[]> {
    const field = fieldFor(dir)
    const where = this.where(dir)
    const reply = await this.request('GET', this.contentsUrl(dir), where, field)
    if (reply.status === 404) return []
    if (!isSuccess(reply.status)) throw this.statusError(field, where, reply)
    if (!Array.isArray(reply.body)) {
      throw new UserStoreError(field, `${where} is not a folder`)
    }
    if (reply.body.length >= LISTING_LIMIT) {
      throw new UserStoreError(
        field,
        `${where} holds ${LISTING_LIMIT} or more entries, the most the GitHub contents API lists, so the list may be incomplete`
      )
    }
    const entries: DirEntry[] = []
    for (const value of reply.body) {
      const entry = dirEntry(value)
      if (entry === undefined) {
        throw new UserStoreError(
          field,
          `GitHub listed ${where} in an unknown form`
        )
      }
      entries.push(entry)
    }
    return entries.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    )
  }

  private isConflict(reply: Reply): boolean {
    if (reply.status === 409) return true
    return (
      reply.status === 422 &&
      isRecord(reply.body) &&
      typeof reply.body.message === 'string' &&
      /\bsha\b/i.test(reply.body.message)
    )
  }

  /**
   * One commit that writes or deletes `file`, expected at `sha` (absent for a
   * new file). Retries once with the same sha on a conflict, then reports it.
   */
  private async commit(
    method: 'PUT' | 'DELETE',
    file: string,
    sha: string | undefined,
    content?: string
  ): Promise<void> {
    const field = fieldFor(file)
    const where = this.where(file)
    const body: Record<string, unknown> = {
      message: `data: ${this.tool} ${file}`,
      ...(content === undefined
        ? {}
        : { content: Buffer.from(content, 'utf8').toString('base64') }),
      ...(sha === undefined ? {} : { sha }),
    }
    for (let attempt = 1; ; attempt += 1) {
      const reply = await this.request(
        method,
        this.contentsUrl(file),
        where,
        field,
        body
      )
      if (isSuccess(reply.status)) return
      if (!this.isConflict(reply)) throw this.statusError(field, where, reply)
      if (attempt === 2) {
        throw new UserStoreError(
          field,
          `${where} changed while ${this.tool} was writing it (GitHub returned ${reply.status} twice); nothing was overwritten, call ${this.tool} again`
        )
      }
    }
  }

  private async writeFile(file: string, value: unknown): Promise<void> {
    const current = await this.getFile(file)
    await this.commit('PUT', file, current?.sha, fileText(value))
  }

  async saveProfile(
    profile: UserProfile,
    updatedAt: string
  ): Promise<SavedProfile> {
    await this.writeFile(PROFILE_FILE, profileFile(profile, updatedAt))
    return { file: PROFILE_FILE, updatedAt, profile }
  }

  async readProfile(): Promise<SavedProfile | undefined> {
    const current = await this.getFile(PROFILE_FILE)
    return current === undefined ? undefined : parseProfileText(current.text)
  }

  async saveSnapshot(portfolio: Portfolio): Promise<SavedSnapshot> {
    const { file, value } = snapshotFile(portfolio)
    await this.writeFile(file, value)
    return { file, asOfDate: portfolio.asOfDate, portfolio }
  }

  async saveNotesSection(update: NotesSectionSave): Promise<NotesSaveResult> {
    // Write against the sha read here, so a change another chat made since
    // (a GitHub 409) overwrites nothing.
    const current = await this.getFile(NOTES_FILE)
    const result = updateNotes(
      current === undefined ? undefined : parseNotesText(current.text),
      update
    )
    if (result.ok) {
      await this.commit(
        'PUT',
        NOTES_FILE,
        current?.sha,
        fileText(notesFile(result.notes.sections))
      )
    }
    return result
  }

  async readNotes(): Promise<SavedNotes | undefined> {
    const current = await this.getFile(NOTES_FILE)
    return current === undefined ? undefined : parseNotesText(current.text)
  }

  private async dates(): Promise<string[]> {
    const entries = await this.listDir(SNAPSHOT_DIR)
    return snapshotDates(
      entries.filter(entry => entry.type !== 'dir').map(entry => entry.name)
    )
  }

  private async readSnapshot(asOfDate: string): Promise<SavedSnapshot> {
    const file = `${SNAPSHOT_DIR}/${asOfDate}.json`
    const current = await this.getFile(file)
    if (current === undefined) {
      throw new UserStoreError(
        'portfolio',
        `${this.where(file)} was listed but is gone; call the tool again`
      )
    }
    return parseSnapshotText(current.text, asOfDate)
  }

  async listSnapshots(): Promise<SavedSnapshot[]> {
    const dates = await this.dates()
    return Promise.all(dates.map(date => this.readSnapshot(date)))
  }

  async newestSnapshot(): Promise<SavedSnapshot | undefined> {
    const [newest] = await this.dates()
    return newest === undefined ? undefined : this.readSnapshot(newest)
  }

  /**
   * Removes profile.json, notes.json and the dated snapshots, one commit each. Any other
   * file in the folder is kept and reported, as the folder store does.
   */
  async deleteAll(): Promise<DeleteReport> {
    const removed: string[] = []
    const kept: string[] = []
    for (const entry of await this.listDir('')) {
      if (entry.name === SNAPSHOT_DIR && entry.type !== 'file') {
        for (const inner of await this.listDir(SNAPSHOT_DIR)) {
          const file = `${SNAPSHOT_DIR}/${inner.name}`
          if (inner.type !== 'dir' && SNAPSHOT_FILE.test(inner.name)) {
            if (await this.deleteFile(file, inner.sha)) removed.push(file)
          } else {
            kept.push(file)
          }
        }
      } else if (
        (entry.name === PROFILE_FILE || entry.name === NOTES_FILE) &&
        entry.type !== 'dir'
      ) {
        if (await this.deleteFile(entry.name, entry.sha)) {
          removed.push(entry.name)
        }
      } else {
        kept.push(entry.name)
      }
    }
    return { removed, kept }
  }

  /**
   * Deletes `file` at the sha the listing gave, or at the sha a read gives
   * when the listing left it out. False when the file is already gone.
   */
  private async deleteFile(
    file: string,
    listedSha: string | undefined
  ): Promise<boolean> {
    const sha = listedSha ?? (await this.getFile(file))?.sha
    if (sha === undefined) return false
    await this.commit('DELETE', file, sha)
    return true
  }
}

/**
 * The store the environment names for `tool`: the GitHub repo store when
 * RETIRE_RUNWAY_DATA_REPO, RETIRE_RUNWAY_DATA_PATH,
 * RETIRE_RUNWAY_GITHUB_APP_ID and RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY are
 * all set, the local folder store when none is. Throws a UserStoreError
 * naming the missing variables when only some are set, so data never goes to
 * the wrong place unnoticed. A GitHub App failure (not installed on the repo,
 * a bad key) is an error of the repo store, never a switch to the folder.
 */
export function openDataStore(
  tool: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: Fetch
): DataStore {
  const set = GIT_ENV.filter(name => (env[name] ?? '') !== '')
  if (set.length === 0) return UserStore.fromEnv(env)
  const missing = GIT_ENV.filter(name => !set.includes(name))
  if (missing.length > 0) {
    throw new UserStoreError(
      missing[0],
      `${set.join(' and ')} ${set.length === 1 ? 'is' : 'are'} set but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not: set all of ${GIT_ENV.join(', ')} to keep data in a GitHub repo, or none to keep it in the local folder`
    )
  }
  const repo = env[REPO_ENV] ?? ''
  return new GitStore({
    repo,
    path: env[PATH_ENV] ?? '',
    token: createAppTokenSource({
      appId: (env[APP_ID_ENV] ?? '').trim(),
      privateKey: env[APP_KEY_ENV] ?? '',
      repo,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    }),
    tool,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  })
}
