// MCP tools over the user data store (REQ-MCP-11..13, REQ-MCP-15,
// REQ-MCP-17..18, REQ-MCP-33, REQ-MCP-35..37). They read and write the user's profile and position
// snapshots in the store the environment names (src/mcp/git-store.ts
// openDataStore): a private GitHub repo folder, else $RETIRE_RUNWAY_DATA_DIR.
import type { McpServer } from '@modelcontextprotocol/server'
import packageJson from '../../package.json'
import {
  calculatePortfolioValue,
  mortgagePayoffWarning,
} from '../engine/portfolio-math'
import type { UserProfile } from '../engine/types'
import { UserProfileSchema } from '../lib/validation-schemas'
import type { FieldError } from './portfolio-tools'
import { errorResult, fromStore } from './portfolio-tools'
import { jsonResult } from './result'
import {
  deleteUserDataInput,
  noInput,
  savePlanNotesInput,
  saveProfileInput,
} from './schemas'
import { openDataStore } from './git-store'
import { WHATS_NEW } from './instructions'
import {
  MAX_SECTION_LENGTH,
  SECTION_KEYS,
  SECTION_TITLES,
  emptySections,
  findSensitiveContent,
  noteRejection,
  openItemLines,
} from './plan-notes'
import type { NoteSections } from './plan-notes'

/** The newest snapshots get_briefing lists. */
const BRIEFING_SNAPSHOTS = 5

interface MissingInput {
  readonly field: string
  readonly why: string
  /** The tool that fixes it. */
  readonly fixWith: string
}

interface BriefingWarning {
  readonly message: string
  /** The tool that fixes it. */
  readonly fixWith: string
}

interface NextAction {
  readonly action: string
  /** The tool to call, or null when the step is the user's. */
  readonly tool: string | null
}

/** The most next actions get_briefing returns. */
const MAX_NEXT_ACTIONS = 5

/**
 * The inputs a saved profile leaves out that move the result most, in the
 * order the server instructions name them. Deterministic: reads only the
 * profile and whether a snapshot is saved.
 */
export function missingInputs(
  profile: UserProfile | undefined,
  hasSnapshot: boolean
): MissingInput[] {
  const missing: MissingInput[] = []
  if (profile === undefined) {
    missing.push({
      field: 'profile',
      why: 'no profile is saved: ask for the basics and call save_profile',
      fixWith: 'save_profile',
    })
  }
  if (!hasSnapshot) {
    missing.push({
      field: 'snapshot',
      why: 'no positions are saved: import a positions CSV with import_positions and save: true',
      fixWith: 'import_positions',
    })
  }
  if (profile === undefined) return missing
  if (
    profile.currentAge < profile.targetRetirementAge &&
    profile.annualContributions === undefined
  ) {
    missing.push({
      field: 'annualContributions',
      why: 'savings until retirement (including any employer match) are not set',
      fixWith: 'save_profile',
    })
  }
  if (
    profile.targetRetirementAge < 65 &&
    (profile.spendingPhases ?? []).length === 0
  ) {
    missing.push({
      field: 'spendingPhases',
      why: 'retiring before 65 with no spending phases: health insurance before Medicare is not modelled',
      fixWith: 'save_profile',
    })
  }
  if (profile.socialSecurityMonthly === undefined) {
    missing.push({
      field: 'socialSecurityMonthly',
      why: 'no Social Security benefit is set (ask for each spouse)',
      fixWith: 'save_profile',
    })
  }
  if (profile.withdrawalTaxRate === undefined) {
    missing.push({
      field: 'withdrawalTaxRate',
      why: 'no tax on withdrawals: annualExpenses is read as the gross withdrawal',
      fixWith: 'save_profile',
    })
  }
  return missing
}

/**
 * Warnings about saved notes that are already stored: a section over the
 * 4,000-character cap (only notes migrated from one text can be) or holding
 * sensitive content saved before the server refused it.
 */
export function notesWarnings(sections: NoteSections): BriefingWarning[] {
  const warnings: BriefingWarning[] = []
  for (const key of SECTION_KEYS) {
    const { text } = sections[key]
    const title = SECTION_TITLES[key]
    if (text.length > MAX_SECTION_LENGTH) {
      warnings.push({
        message: `${title} holds ${text.length.toLocaleString('en-US')} characters, over the ${MAX_SECTION_LENGTH.toLocaleString('en-US')} limit; move parts into the other sections and shorten it`,
        fixWith: 'save_plan_notes',
      })
    }
    const kinds = findSensitiveContent(text)
    if (kinds.length > 0) {
      warnings.push({
        message: `${title} contains what looks like a ${kinds.join(', ')}; remove it`,
        fixWith: 'save_plan_notes',
      })
    }
  }
  return warnings
}

/**
 * Up to five next actions, deterministic: fix each warning, then (with saved
 * data) run plan_check or set its rules, then each missing input, then the
 * open items in order.
 */
export function nextActions(
  warnings: readonly BriefingWarning[],
  missing: readonly MissingInput[],
  sections: NoteSections,
  hasSavedData: boolean,
  hasPlanRules = false
): NextAction[] {
  // REQ-MCP-47: with saved data, the rule-based recommendations come first after fixes.
  const planCheck: NextAction[] = !hasSavedData
    ? []
    : hasPlanRules
      ? [
          {
            action:
              'Run plan_check with asOfDate set to today: the recommendations from your rules',
            tool: 'plan_check',
          },
        ]
      : [
          {
            action:
              'Set planRules (target stock share, drift band, sell schedule) with save_profile so plan_check can recommend trades',
            tool: 'save_profile',
          },
        ]
  const actions: NextAction[] = [
    ...warnings.map(warning => ({
      action: `Fix: ${warning.message}`,
      tool: warning.fixWith,
    })),
    ...planCheck,
    ...missing.map(item => ({
      action: `Set ${item.field}: ${item.why}`,
      tool: item.fixWith,
    })),
    ...openItemLines(sections).map(line => ({
      action: `Open item: ${line}`,
      tool: null,
    })),
  ]
  return actions.slice(0, MAX_NEXT_ACTIONS)
}

export function registerUserDataTools(server: McpServer): void {
  server.registerTool(
    'get_briefing',
    {
      title: 'Get briefing',
      description:
        "Call this first in every conversation. Returns, in order: warnings (such as a mortgage payoff date that does not match the loan, or saved notes that break a rule) and missing inputs that move the result most, each naming the tool that fixes it; the saved profile with when it was saved and the newest snapshot dates with their totals; the plan notes by section (decisions, scenarios, confirmedFigures, openItems, agentLog), each with its text and revision; at most five next actions; and the server version with what's new. Reads only; changes nothing.",
      inputSchema: noInput,
    },
    async () => {
      const read = await fromStore(async () => {
        const store = openDataStore('get_briefing')
        const [profile, snapshots, notes] = await Promise.all([
          store.readProfile(),
          store.listSnapshots(),
          store.readNotes(),
        ])
        return { profile, snapshots, notes }
      })
      if (!read.ok) return errorResult([read.error])
      const { profile, snapshots, notes } = read.value
      const sections = notes?.sections ?? emptySections()
      const payoffWarning =
        profile === undefined
          ? undefined
          : mortgagePayoffWarning(profile.profile)
      const warnings: BriefingWarning[] = [
        ...(payoffWarning === undefined
          ? []
          : [{ message: payoffWarning, fixWith: 'save_profile' }]),
        ...notesWarnings(sections),
      ]
      const missing = missingInputs(profile?.profile, snapshots.length > 0)
      return jsonResult({
        ok: true,
        checks: { warnings, missing },
        profile: profile ?? null,
        snapshots: snapshots.slice(0, BRIEFING_SNAPSHOTS).map(snapshot => ({
          asOfDate: snapshot.asOfDate,
          file: snapshot.file,
          totalValue: calculatePortfolioValue(snapshot.portfolio),
        })),
        snapshotCount: snapshots.length,
        notes: {
          file: notes?.file ?? null,
          migratedFromSingleText: notes?.migratedFromSingleText ?? false,
          sections: SECTION_KEYS.map(key => ({
            section: key,
            title: SECTION_TITLES[key],
            ...sections[key],
          })),
        },
        nextActions: nextActions(
          warnings,
          missing,
          sections,
          profile !== undefined && snapshots.length > 0,
          profile?.profile.planRules !== undefined
        ),
        server: { version: packageJson.version, whatsNew: WHATS_NEW },
      })
    }
  )

  server.registerTool(
    'save_plan_notes',
    {
      title: 'Save plan notes',
      description:
        "Replace one section of the plan notes kept with the saved profile. Pass section (decisions, scenarios, confirmedFigures, openItems or agentLog), the section's full new text, and expectedRevision: the section's revision from get_briefing (0 for a section never saved). Only that section changes. When another chat saved the section since, nothing is saved and the result names the current revision: call get_briefing, merge, and save again with that revision. Each section holds at most 4,000 characters of short, factual markdown. Text with account or card numbers, Social Security or other government ID numbers, or passwords is refused.",
      inputSchema: savePlanNotesInput,
    },
    async ({ section, text, expectedRevision }) => {
      const rejection = noteRejection(section, text)
      if (rejection !== undefined) {
        return errorResult([{ field: 'text', message: rejection }])
      }
      const saved = await fromStore(async () =>
        openDataStore('save_plan_notes').saveNotesSection({
          section,
          text,
          expectedRevision,
          updatedAt: new Date().toISOString(),
        })
      )
      if (!saved.ok) return errorResult([saved.error])
      const result = saved.value
      const title = SECTION_TITLES[section]
      if (!result.ok) {
        return {
          ...jsonResult({
            ok: false,
            conflict: {
              section,
              expectedRevision,
              currentRevision: result.currentRevision,
            },
            errors: [
              {
                field: 'expectedRevision',
                message: `notes not saved: ${title} is at revision ${result.currentRevision}, not ${expectedRevision}; another chat saved it since. Call get_briefing, merge your change into the current ${title} text, and save again with expectedRevision ${result.currentRevision}.`,
              },
            ],
          }),
          isError: true,
        }
      }
      return jsonResult({
        ok: true,
        file: result.notes.file,
        section,
        revision: result.revision,
        updatedAt: result.notes.sections[section].updatedAt,
      })
    }
  )

  server.registerTool(
    'save_profile',
    {
      title: 'Save profile',
      description:
        'Validate a retirement profile (the profile the portfolio tools take: currentAge, targetRetirementAge, annualExpenses and the optional Social Security, pension, income, tax, home, mortgage, annualContributions, spendingPhases and homeSale fields) and save it in the data store (the local data folder, or the private GitHub repo folder the server is set up with), so portfolio_analysis, tax_strategy and trade_plan can be called without it. Returns field-level errors and saves nothing when a value is invalid.',
      inputSchema: saveProfileInput,
    },
    async ({ profile }) => {
      // The same value rules portfolio_analysis applies (AnalyzeRequestSchema.userProfile).
      const parsed = UserProfileSchema.safeParse(profile)
      if (!parsed.success) {
        const errors: FieldError[] = parsed.error.issues.map(issue => ({
          field: ['profile', ...issue.path.map(String)].join('.'),
          message: issue.message,
        }))
        return errorResult(errors)
      }
      const saved = await fromStore(async () =>
        openDataStore('save_profile').saveProfile(
          profile,
          new Date().toISOString()
        )
      )
      if (!saved.ok) return errorResult([saved.error])
      return jsonResult({ ok: true, ...saved.value })
    }
  )

  server.registerTool(
    'get_profile',
    {
      title: 'Get saved profile',
      description:
        'Return the profile saved in the data store with save_profile and when it was saved (updatedAt), or saved: false when there is none.',
      inputSchema: noInput,
    },
    async () => {
      const read = await fromStore(async () =>
        openDataStore('get_profile').readProfile()
      )
      if (!read.ok) return errorResult([read.error])
      if (read.value === undefined) {
        return jsonResult({
          ok: true,
          saved: false,
          message: 'no profile saved: call save_profile',
        })
      }
      return jsonResult({ ok: true, saved: true, ...read.value })
    }
  )

  server.registerTool(
    'list_snapshots',
    {
      title: 'List saved snapshots',
      description:
        'List the position snapshots saved in the data store by import_positions with save: true, newest first, each with its as-of date and total value. The portfolio tools use the newest one when called without a portfolio.',
      inputSchema: noInput,
    },
    async () => {
      const listed = await fromStore(async () =>
        openDataStore('list_snapshots').listSnapshots()
      )
      if (!listed.ok) return errorResult([listed.error])
      return jsonResult({
        ok: true,
        snapshots: listed.value.map(snapshot => ({
          asOfDate: snapshot.asOfDate,
          file: snapshot.file,
          totalValue: calculatePortfolioValue(snapshot.portfolio),
        })),
      })
    }
  )

  server.registerTool(
    'delete_user_data',
    {
      title: 'Delete saved user data',
      description:
        'Delete the profile, the plan notes (every section) and every snapshot saved in the data store. Deletes only with confirm: true; ask the user first. Returns the files removed and any other files left in the data folder.',
      inputSchema: deleteUserDataInput,
    },
    async ({ confirm }) => {
      if (!confirm) {
        return jsonResult({
          ok: false,
          removed: [],
          message:
            'nothing deleted: pass confirm: true to delete the saved profile, plan notes and snapshots',
        })
      }
      const deleted = await fromStore(async () => {
        const store = openDataStore('delete_user_data')
        return { ...store.location, ...(await store.deleteAll()) }
      })
      if (!deleted.ok) return errorResult([deleted.error])
      return jsonResult({ ok: true, ...deleted.value })
    }
  )
}
