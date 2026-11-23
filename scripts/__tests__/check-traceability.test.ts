import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { check, render } = require('../check-traceability.js') as {
  check: (base: string) => { errors: string[]; rendered: string }
  render: (requirements: unknown[]) => string
}

const created: string[] = []

interface Requirement {
  id: string
  title: string
  status: string
  design: string
  code: string[]
  tests: string[]
  issue?: string
}

function project(requirements: Requirement[], extraFiles: string[] = []) {
  const base = mkdtempSync(join(tmpdir(), 'trace-'))
  created.push(base)
  const put = (file: string, body = '') => {
    mkdirSync(dirname(join(base, file)), { recursive: true })
    writeFileSync(join(base, file), body)
  }
  put(
    'docs/REQUIREMENTS.md',
    '### FR-01 Thing\n\n| DEF-01 | Later | x | BUI-1 |\n'
  )
  put('docs/DESIGN.md', '## 1. Shape\n')
  put('docs/traceability.json', JSON.stringify({ requirements }))
  put('docs/TRACEABILITY.md', render(requirements))
  put('docs/decisions/ADR-001.md')
  put('src/engine/a.ts')
  put('src/engine/__tests__/a.test.ts')
  for (const file of extraFiles) put(file)
  return base
}

const good: Requirement[] = [
  {
    id: 'FR-01',
    title: 'Thing',
    status: 'implemented',
    design: 'DESIGN.md §1',
    code: ['src/engine/a.ts'],
    tests: ['src/engine/__tests__/a.test.ts'],
  },
  {
    id: 'DEF-01',
    title: 'Later',
    status: 'out-of-scope',
    design: 'REQUIREMENTS.md §4',
    code: [],
    tests: [],
    issue: 'BUI-1',
  },
]

afterEach(() => {
  for (const base of created.splice(0)) {
    rmSync(base, { recursive: true, force: true })
  }
})

describe('traceability check', () => {
  it('holds for this repository', () => {
    expect(check(process.cwd()).errors).toEqual([])
  })

  it('passes a fully traced project', () => {
    expect(check(project(good)).errors).toEqual([])
  })

  it('fails when a documented requirement has no mapping', () => {
    const base = project(good.slice(1))
    expect(check(base).errors.join('\n')).toContain(
      'FR-01 is in REQUIREMENTS.md'
    )
  })

  it('fails when an implemented requirement has no tests', () => {
    const base = project([{ ...good[0], tests: [] }, good[1]])
    expect(check(base).errors.join('\n')).toContain('FR-01: no tests mapped')
  })

  it('fails when a mapped file does not exist', () => {
    const base = project([
      { ...good[0], code: ['src/engine/gone.ts'] },
      good[1],
    ])
    expect(check(base).errors.join('\n')).toContain('missing code path')
  })

  it('fails on an orphan source file', () => {
    const base = project(good, ['src/engine/orphan.ts'])
    expect(check(base).errors.join('\n')).toContain(
      'orphan source file (no requirement): src/engine/orphan.ts'
    )
  })

  it('fails on an orphan test file', () => {
    const base = project(good, ['src/engine/__tests__/orphan.test.ts'])
    expect(check(base).errors.join('\n')).toContain('orphan test')
  })

  it('fails when the design reference has no section', () => {
    const base = project([{ ...good[0], design: 'DESIGN.md §9' }, good[1]])
    expect(check(base).errors.join('\n')).toContain(
      'no matching DESIGN.md section'
    )
  })

  it('fails when the generated matrix is stale', () => {
    const base = project(good)
    writeFileSync(join(base, 'docs/TRACEABILITY.md'), 'stale')
    expect(check(base).errors.join('\n')).toContain('stale')
  })
})
