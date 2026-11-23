// Plan notes in sections (REQ-MCP-35..36). Pure functions, no I/O: the
// stores read and write notes.json, and save_plan_notes calls these to apply
// one section update with an optimistic revision check and to refuse text
// that holds account or card numbers, government IDs or passwords.

/** The note sections, in the order get_briefing returns them. */
export const SECTION_KEYS = [
  'decisions',
  'scenarios',
  'confirmedFigures',
  'openItems',
  'agentLog',
] as const

export type SectionKey = (typeof SECTION_KEYS)[number]

export const SECTION_TITLES: Readonly<Record<SectionKey, string>> = {
  decisions: 'Decisions',
  scenarios: 'Scenarios being weighed',
  confirmedFigures: 'Confirmed figures',
  openItems: 'Open items',
  agentLog: 'Agent log',
}

/** The longest text one section accepts, in characters. */
export const MAX_SECTION_LENGTH = 4_000

export interface NoteSection {
  readonly text: string
  /** 0 until the section is first saved; each save adds 1. */
  readonly revision: number
  readonly updatedAt: string | null
}

export type NoteSections = Readonly<Record<SectionKey, NoteSection>>

/** Every section empty at revision 0. */
export function emptySections(): NoteSections {
  const empty: NoteSection = { text: '', revision: 0, updatedAt: null }
  return {
    decisions: empty,
    scenarios: empty,
    confirmedFigures: empty,
    openItems: empty,
    agentLog: empty,
  }
}

/**
 * The section a `##`-or-deeper heading in single-text notes belongs to, or
 * undefined when it names none. Checked in this order, so "Open questions on
 * the scenario" is an open item.
 */
export function sectionForHeading(heading: string): SectionKey | undefined {
  const h = heading.toLowerCase()
  if (/\bagent log\b|\bsession log\b|^log\b/.test(h)) return 'agentLog'
  if (
    /\bopen\b|\bto ?dos?\b|\bnext steps?\b|\bquestions?\b|\bfollow[- ]ups?\b/.test(
      h
    )
  )
    return 'openItems'
  if (/\bconfirmed\b|\bfigures?\b|\bfacts?\b|\bnumbers\b/.test(h))
    return 'confirmedFigures'
  if (/\bscenarios?\b|\bwhat[- ]ifs?\b|\bweigh/.test(h)) return 'scenarios'
  if (/\bdecisions?\b|\bdecided\b/.test(h)) return 'decisions'
  return undefined
}

const HEADING = /^#{2,6}\s+(.+?)\s*#*\s*$/

/**
 * The sections for notes saved before sections existed (one text). The text
 * is split at its `##` headings: each heading, with the lines under it, goes
 * to the section it names (sectionForHeading), keeping the heading line.
 * Text before the first heading, and headings that name no section, go to
 * Decisions. Every line is kept, in order, in exactly one section; only
 * blank lines at a section's start and end are dropped. With no heading that
 * names a section, the whole text, unchanged, becomes Decisions. Each
 * section that receives text is at revision 1.
 */
export function migrateSingleText(
  notes: string,
  updatedAt: string
): NoteSections {
  const buffers: Record<SectionKey, string[]> = {
    decisions: [],
    scenarios: [],
    confirmedFigures: [],
    openItems: [],
    agentLog: [],
  }
  let target: SectionKey = 'decisions'
  let matched = false
  for (const line of notes.split('\n')) {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const section = sectionForHeading(heading[1])
      if (section !== undefined) matched = true
      target = section ?? 'decisions'
      const lines = buffers[target]
      if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
        lines.push('')
      }
    }
    buffers[target].push(line)
  }
  if (!matched) {
    return {
      ...emptySections(),
      decisions: { text: notes, revision: 1, updatedAt },
    }
  }
  const sections: Record<SectionKey, NoteSection> = { ...emptySections() }
  for (const key of SECTION_KEYS) {
    const text = buffers[key].join('\n').replace(/^(\s*\n)+|(\n\s*)+$/g, '')
    if (text.trim() !== '') sections[key] = { text, revision: 1, updatedAt }
  }
  return sections
}

export type SectionUpdate =
  | {
      readonly ok: true
      readonly sections: NoteSections
      readonly revision: number
    }
  | { readonly ok: false; readonly currentRevision: number }

/**
 * Replaces one section when `expectedRevision` is that section's current
 * revision, else reports the current revision and changes nothing. The other
 * sections are left as they are.
 */
export function applySectionUpdate(
  sections: NoteSections,
  section: SectionKey,
  text: string,
  expectedRevision: number,
  updatedAt: string
): SectionUpdate {
  const current = sections[section]
  if (current.revision !== expectedRevision) {
    return { ok: false, currentRevision: current.revision }
  }
  const revision = current.revision + 1
  return {
    ok: true,
    revision,
    sections: { ...sections, [section]: { text, revision, updatedAt } },
  }
}

/** The kinds of sensitive content findSensitiveContent names. */
export type SensitiveKind =
  | 'card number'
  | 'Social Security number'
  | 'account or routing number'
  | 'government ID number'
  | 'password'

const SENSITIVE_ORDER: readonly SensitiveKind[] = [
  'card number',
  'Social Security number',
  'account or routing number',
  'government ID number',
  'password',
]

function digitCount(value: string): number {
  return (value.match(/\d/g) ?? []).length
}

/** The Luhn checksum card numbers carry. */
function passesLuhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

// 13–19 digits in a row, optionally split by single spaces or hyphens, not
// part of a longer number, an amount ($1,234) or a decimal.
const CARD_CANDIDATE = /(?<![\d.,$])\d(?:[ -]?\d){12,18}(?![\d.,])/g
const SSN_PATTERN =
  /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/
const SSN_KEYWORD =
  /\b(?:ssn|social security (?:number|no\.?|#))\b[^\n\d]{0,15}\d{3}[- ]?\d{2}[- ]?\d{4}\b/i
// A label, then within 20 characters a number with at least 6 digits.
// "account ending 4417" (last four) stays allowed.
const ACCOUNT_PATTERN =
  /\b(?:account|acct|a\/c|routing|aba|iban|bsb|sort code|member (?:number|no\.?|#))\b[^\n]{0,20}?([A-Z]{0,4}\d[\d -]{4,}\d)/gi
const GOVERNMENT_ID_PATTERN =
  /\b(?:passport|driver'?s? licen[cs]e|licen[cs]e (?:number|no\.?|#)|tfn|tax file number|itin|ein|medicare (?:number|card)(?: number)?|national id|id (?:number|no\.?|#))\b[^\n]{0,20}?([A-Z0-9][A-Z0-9 -]{4,}[A-Z0-9])/gi
const PASSWORD_PATTERN =
  /\b(?:password|passwd|passcode|pwd|pin)\b\s*(?:is|was|=|:)\s*\S{3,}/i

/**
 * The kinds of sensitive content in `text`, in a fixed order, without the
 * matched values. Empty when the text holds none. Dollar amounts, dates,
 * percentages and the last four digits of an account are allowed.
 */
export function findSensitiveContent(text: string): SensitiveKind[] {
  const found = new Set<SensitiveKind>()
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, '')
    if (digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)) {
      found.add('card number')
    }
  }
  if (SSN_PATTERN.test(text) || SSN_KEYWORD.test(text)) {
    found.add('Social Security number')
  }
  for (const match of text.matchAll(ACCOUNT_PATTERN)) {
    if (digitCount(match[1]) >= 6) found.add('account or routing number')
  }
  for (const match of text.matchAll(GOVERNMENT_ID_PATTERN)) {
    if (digitCount(match[1]) >= 5) found.add('government ID number')
  }
  if (PASSWORD_PATTERN.test(text)) found.add('password')
  return SENSITIVE_ORDER.filter(kind => found.has(kind))
}

function listKinds(kinds: readonly string[]): string {
  if (kinds.length <= 1) return kinds.join('')
  return `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`
}

/**
 * The reason save_plan_notes refuses `text` for `section`, or undefined when
 * it may be saved: too long, or holding sensitive content. The reason names
 * the problem, never the matched value.
 */
export function noteRejection(
  section: SectionKey,
  text: string
): string | undefined {
  const title = SECTION_TITLES[section]
  if (text.length > MAX_SECTION_LENGTH) {
    return `notes not saved: ${title} text is ${text.length.toLocaleString('en-US')} characters; each section holds at most ${MAX_SECTION_LENGTH.toLocaleString('en-US')}. Shorten it or move detail to another section.`
  }
  const kinds = findSensitiveContent(text)
  if (kinds.length > 0) {
    return `notes not saved: ${title} contains what looks like a ${listKinds(kinds)}. Plan notes never hold account or card numbers, Social Security or other government ID numbers, or passwords. Name an account by institution and type (or its last 4 digits) instead, and save again.`
  }
  return undefined
}

/** The open items as single lines: bulleted or numbered lines of Open items. */
export function openItemLines(sections: NoteSections): string[] {
  return sections.openItems.text
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^([-*•]|\d+[.)])\s+\S/.test(line))
    .map(line => line.replace(/^([-*•]|\d+[.)])\s+/, ''))
}
