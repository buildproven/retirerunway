// Plan notes in sections (REQ-MCP-35) and the server-side privacy and size
// checks on them (REQ-MCP-36). Pure logic: no store, no server.
import { describe, expect, it } from 'vitest'
import {
  MAX_SECTION_LENGTH,
  SECTION_KEYS,
  SECTION_TITLES,
  applySectionUpdate,
  emptySections,
  findSensitiveContent,
  migrateSingleText,
  noteRejection,
  openItemLines,
  sectionForHeading,
} from '../plan-notes'

const AT = '2026-11-19T00:00:00.000Z'

describe('REQ-MCP-35: sections, revisions and migration', () => {
  it('REQ-MCP-35 has the five sections in order with their titles', () => {
    expect(SECTION_KEYS).toEqual([
      'decisions',
      'scenarios',
      'confirmedFigures',
      'openItems',
      'agentLog',
    ])
    expect(SECTION_KEYS.map(key => SECTION_TITLES[key])).toEqual([
      'Decisions',
      'Scenarios being weighed',
      'Confirmed figures',
      'Open items',
      'Agent log',
    ])
  })

  it('REQ-MCP-35 starts every section empty at revision 0', () => {
    const sections = emptySections()
    for (const key of SECTION_KEYS) {
      expect(sections[key]).toEqual({ text: '', revision: 0, updatedAt: null })
    }
  })

  it('REQ-MCP-35 keeps notes without section headings in Decisions verbatim', () => {
    const legacy = '# Plan\n\n- Retire at 60\n- ACA quote ($1,450/mo?)\n'
    const sections = migrateSingleText(legacy, AT)
    expect(sections.decisions).toEqual({
      text: legacy,
      revision: 1,
      updatedAt: AT,
    })
    for (const key of SECTION_KEYS.filter(key => key !== 'decisions')) {
      expect(sections[key]).toEqual({ text: '', revision: 0, updatedAt: null })
    }
  })

  it('REQ-MCP-35 splits single-text notes into the sections their headings name, losing no line', () => {
    const legacy = [
      '# Plan notes (Nov 18)',
      '',
      '## Decisions',
      '- Retire at 60',
      '',
      '## Scenario being weighed: downsize at 60',
      '- Downsize: 86.7%',
      '',
      '## Confirmed figures',
      '- SS $50K/yr at 67',
      '',
      '## Misc',
      '- Call the planner',
      '',
      '## Open items',
      '- Get an ACA quote',
      '',
      '### Agent log',
      '- 2026-11-18: imported Empower',
      '',
    ].join('\n')
    const sections = migrateSingleText(legacy, AT)
    expect(sections.decisions.text).toBe(
      '# Plan notes (Nov 18)\n\n## Decisions\n- Retire at 60\n\n## Misc\n- Call the planner'
    )
    expect(sections.scenarios.text).toBe(
      '## Scenario being weighed: downsize at 60\n- Downsize: 86.7%'
    )
    expect(sections.confirmedFigures.text).toBe(
      '## Confirmed figures\n- SS $50K/yr at 67'
    )
    expect(sections.openItems.text).toBe('## Open items\n- Get an ACA quote')
    expect(sections.agentLog.text).toBe(
      '### Agent log\n- 2026-11-18: imported Empower'
    )
    for (const key of SECTION_KEYS) {
      expect(sections[key]).toMatchObject({ revision: 1, updatedAt: AT })
    }
    const kept = SECTION_KEYS.flatMap(key => sections[key].text.split('\n'))
    for (const line of legacy.split('\n').filter(line => line.trim() !== '')) {
      expect(kept).toContain(line)
    }
  })

  it.each([
    ['Decisions', 'decisions'],
    ['Decided', 'decisions'],
    ['Scenarios being weighed', 'scenarios'],
    ['What-ifs', 'scenarios'],
    ['Confirmed figures', 'confirmedFigures'],
    ['Key numbers', 'confirmedFigures'],
    ['Open items', 'openItems'],
    ['Open questions on the scenario', 'openItems'],
    ['Next steps', 'openItems'],
    ['Agent log', 'agentLog'],
    ['Background', undefined],
  ])('REQ-MCP-35 reads the heading %j as %s', (heading, section) => {
    expect(sectionForHeading(heading)).toBe(section)
  })

  it('REQ-MCP-35 replaces one section and bumps only its revision', () => {
    const start = emptySections()
    const first = applySectionUpdate(start, 'openItems', '- ACA quote', 0, AT)
    expect(first).toMatchObject({ ok: true, revision: 1 })
    if (!first.ok) throw new Error('expected ok')
    const second = applySectionUpdate(
      first.sections,
      'openItems',
      '- done',
      1,
      AT
    )
    if (!second.ok) throw new Error('expected ok')
    expect(second.revision).toBe(2)
    expect(second.sections.openItems.text).toBe('- done')
    expect(second.sections.decisions).toEqual(start.decisions)
  })

  it('REQ-MCP-35 refuses a stale revision and names the current one', () => {
    const saved = applySectionUpdate(emptySections(), 'decisions', 'a', 0, AT)
    if (!saved.ok) throw new Error('expected ok')
    const again = applySectionUpdate(saved.sections, 'decisions', 'b', 1, AT)
    if (!again.ok) throw new Error('expected ok')
    expect(applySectionUpdate(again.sections, 'decisions', 'c', 1, AT)).toEqual(
      {
        ok: false,
        currentRevision: 2,
      }
    )
    // A revision ahead of the stored one is stale too.
    expect(applySectionUpdate(again.sections, 'decisions', 'c', 5, AT)).toEqual(
      {
        ok: false,
        currentRevision: 2,
      }
    )
  })

  it('REQ-MCP-35 lists open items from bulleted and numbered lines only', () => {
    const sections = {
      ...emptySections(),
      openItems: {
        text: '## Open items\n- Get an ACA quote\n* Set a downsize target\n1. Confirm SS at 67\nloose prose\n',
        revision: 1,
        updatedAt: AT,
      },
    }
    expect(openItemLines(sections)).toEqual([
      'Get an ACA quote',
      'Set a downsize target',
      'Confirm SS at 67',
    ])
  })
})

describe('REQ-MCP-36: privacy and size checks', () => {
  it.each([
    ['card 4111 1111 1111 1111 on file', 'card number'],
    ['SSN 123-45-6789', 'Social Security number'],
    ['social security number 123456789', 'Social Security number'],
    ['Fidelity account number 12345678', 'account or routing number'],
    ['routing 021000021', 'account or routing number'],
    ['passport X1234567', 'government ID number'],
    ["driver's license D1234-56789", 'government ID number'],
    ['password: hunter2', 'password'],
    ['login pwd = s3cret!', 'password'],
  ])('REQ-MCP-36 flags %j as a %s', (text, kind) => {
    expect(findSensitiveContent(text)).toContain(kind)
  })

  it.each([
    'Balance $970,000 as of 2026-11-17; SS $50,000/yr at 67',
    '401k max $23,500 plus 6% match; mortgage $3k/mo, payoff 2050-11-01',
    'Fidelity 401k ending 4417',
    'Call Fidelity at 800-343-3548',
    'Spending $96,000 to $128,000 from age 60 to 67',
    'Property tax 14,700 a year; HELOC 0',
  ])('REQ-MCP-36 allows ordinary planning text: %j', text => {
    expect(findSensitiveContent(text)).toEqual([])
  })

  it('REQ-MCP-36 names the problem without echoing the value', () => {
    const message = noteRejection('confirmedFigures', 'SSN 123-45-6789')
    expect(message).toContain('Confirmed figures')
    expect(message).toContain('Social Security number')
    expect(message).not.toContain('123-45-6789')
  })

  it('REQ-MCP-36 caps each section at 4,000 characters', () => {
    expect(MAX_SECTION_LENGTH).toBe(4_000)
    expect(noteRejection('decisions', 'x'.repeat(4_000))).toBeUndefined()
    expect(noteRejection('decisions', 'x'.repeat(4_001))).toMatch(
      /Decisions text is 4,001 characters; each section holds at most 4,000/
    )
  })
})
