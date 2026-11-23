// BUI-1835 (NFR-01): load-portfolio never reads the system clock for the
// portfolio as-of date. The date comes from SKILL_AS_OF_DATE, else the CSV
// export date, else there is none and a warning asks for one — the same order
// as the import_positions MCP tool.
import { afterAll, describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { NO_AS_OF_DATE_WARNING } from '../../../../src/mcp/portfolio-tools'

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = resolve(here, '..', '..')
const loadPortfolio = resolve(skillRoot, 'dist', 'load-portfolio.mjs')
const csvFixture = (f: string) => resolve(skillRoot, 'fixtures/csv', f)

// Loads a hook that makes every Date construction without arguments, and
// Date.now(), return a fixed instant, so a test can see a clock read.
const clockDir = mkdtempSync(resolve(tmpdir(), 'rr-clock-'))
const clockHook = resolve(clockDir, 'fixed-clock.mjs')
writeFileSync(
  clockHook,
  [
    'const fixed = Date.parse(process.env.FAKE_NOW)',
    'const RealDate = Date',
    'class FakeDate extends RealDate {',
    '  constructor(...args) { super(...(args.length === 0 ? [fixed] : args)) }',
    '  static now() { return fixed }',
    '}',
    'globalThis.Date = FakeDate',
    '',
  ].join('\n')
)

interface LoadOutput {
  portfolio: { id: string; asOfDate?: string }
  import: { warnings: string[] }
  provenance: Array<{
    outputHash: string
    assumptions?: { asOfDateSource?: string }
  }>
}

function run(
  csvPath: string,
  options: { now: string; asOf?: string }
): LoadOutput {
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_NOW: options.now }
  delete env.SKILL_AS_OF_DATE
  if (options.asOf !== undefined) env.SKILL_AS_OF_DATE = options.asOf
  const out = execFileSync(
    'node',
    ['--import', clockHook, loadPortfolio, csvPath],
    { encoding: 'utf8', env }
  )
  return JSON.parse(out) as LoadOutput
}

describe('load-portfolio as-of date does not come from the clock (BUI-1835)', () => {
  afterAll(() => {
    rmSync(clockDir, { recursive: true, force: true })
  })

  it('NFR-01: a CSV without an export date and no SKILL_AS_OF_DATE has no as-of date and a warning', () => {
    const out = run(csvFixture('generic-sample.csv'), {
      now: '2031-07-04T12:00:00Z',
    })
    expect(out.portfolio.asOfDate).toBeUndefined()
    expect(out.import.warnings).toContain(NO_AS_OF_DATE_WARNING)
    expect(out.provenance[0].assumptions?.asOfDateSource).toBe('none')
  })

  it('NFR-01: the same CSV gives the same output hash on different days', () => {
    const day1 = run(csvFixture('generic-sample.csv'), {
      now: '2031-07-04T12:00:00Z',
    })
    const day2 = run(csvFixture('generic-sample.csv'), {
      now: '2032-01-15T08:00:00Z',
    })
    expect(day1.provenance[0].outputHash).toBe(day2.provenance[0].outputHash)
    expect(day1.portfolio).toEqual(day2.portfolio)
  })

  it('NFR-01: a CSV with an export date uses that date, not the clock', () => {
    const out = run(csvFixture('fidelity-2026.csv'), {
      now: '2031-07-04T12:00:00Z',
    })
    expect(out.portfolio.asOfDate).toBe('2026-11-02')
    expect(out.import.warnings).not.toContain(NO_AS_OF_DATE_WARNING)
    expect(out.provenance[0].assumptions?.asOfDateSource).toBe('csv')
  })

  it('NFR-01: SKILL_AS_OF_DATE wins over the CSV export date', () => {
    const out = run(csvFixture('fidelity-2026.csv'), {
      now: '2031-07-04T12:00:00Z',
      asOf: '2026-04-18',
    })
    expect(out.portfolio.asOfDate).toBe('2026-04-18')
    expect(out.provenance[0].assumptions?.asOfDateSource).toBe('input')
  })

  it('NFR-01: a CSV whose export date is not a real date has no as-of date and a warning', () => {
    const csvPath = resolve(clockDir, 'bad-export-date.csv')
    writeFileSync(
      csvPath,
      `${readFileSync(csvFixture('generic-sample.csv'), 'utf8')}\n"Date downloaded 02/30/2026 10:30 AM ET"\n`
    )
    const out = run(csvPath, { now: '2031-07-04T12:00:00Z' })
    expect(out.portfolio.asOfDate).toBeUndefined()
    expect(out.import.warnings).toContain(NO_AS_OF_DATE_WARNING)
    expect(out.provenance[0].assumptions?.asOfDateSource).toBe('none')
  })

  it.each(['2026-02-30', 'tomorrow', ''])(
    'NFR-01: SKILL_AS_OF_DATE=%j that is not a real date exits 2 with an error',
    asOf => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        SKILL_AS_OF_DATE: asOf,
      }
      const result = spawnSync(
        'node',
        [loadPortfolio, csvFixture('generic-sample.csv')],
        { encoding: 'utf8', env }
      )
      expect(result.status).toBe(2)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('SKILL_AS_OF_DATE')
    }
  )
})
