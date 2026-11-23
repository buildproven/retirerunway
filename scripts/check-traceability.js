#!/usr/bin/env node
'use strict'

// Verifies requirements -> design -> code -> tests traceability.
//   node scripts/check-traceability.js          check (CI)
//   node scripts/check-traceability.js --write  regenerate docs/TRACEABILITY.md
// Rules:
//  1. Every ID in REQUIREMENTS.md (### FR-/NFR-/DEF- headings or DEF table rows)
//     appears in traceability.json and vice versa.
//  2. Implemented requirements list >=1 existing code path, >=1 existing test
//     file, and a design reference to a heading that exists in DESIGN.md.
//  3. Out-of-scope requirements name a tracking issue or an explicit note.
//  4. No orphans: every governed source file and every test file is covered by
//     at least one requirement (a directory entry covers its subtree).
//  5. docs/TRACEABILITY.md matches what --write would produce.

const fs = require('node:fs')
const path = require('node:path')

const GOVERNED_SOURCE_ROOTS = [
  'src/engine',
  'src/ai',
  'src/lib',
  'src/services',
  'src/store',
  'src/hooks',
  'src/app/api',
  'skills/retire-runway/scripts',
]
const TEST_PATTERN = /\.(test|spec)\.(ts|tsx|js)$/
const TEST_ROOTS = ['src', 'scripts', 'skills/retire-runway/scripts', 'tests']
const ID_PATTERN = /^(FR|NFR|DEF)-\d{2}$/

function walk(root, base) {
  const dir = path.join(base, root)
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const rel = path.posix.join(root, entry.name)
    if (entry.isDirectory()) out.push(...walk(rel, base))
    else out.push(rel)
  }
  return out
}

function covers(entry, file) {
  return file === entry || file.startsWith(`${entry}/`)
}

function requirementIdsFromMarkdown(markdown) {
  const ids = new Set()
  for (const match of markdown.matchAll(/^###\s+((?:FR|NFR)-\d{2})\b/gm)) {
    ids.add(match[1])
  }
  for (const match of markdown.matchAll(/^\|\s*(DEF-\d{2})\s*\|/gm)) {
    ids.add(match[1])
  }
  return ids
}

function headingExists(designMarkdown, reference) {
  // "DESIGN.md §3.2, §4" -> section numbers 3.2 and 4 must head a section.
  const sections = [...reference.matchAll(/§(\d+(?:\.\d+)?)/g)].map(m => m[1])
  return sections.every(section => {
    const top = section.split('.')[0]
    const pattern =
      section === top
        ? new RegExp(`^##\\s+${top}\\.`, 'm')
        : new RegExp(
            `^(?:##\\s+${top}\\.|\\s*${section.replace('.', '\\.')}\\.\\s)`,
            'm'
          )
    return pattern.test(designMarkdown)
  })
}

function render(requirements) {
  const lines = [
    '# Traceability matrix',
    '',
    '> Generated from `docs/traceability.json` by `npm run traceability:write`.',
    '> Do not edit by hand; `npm run traceability:check` fails on drift.',
    '',
    '| ID | Requirement | Status | Design | Code | Tests |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  const cell = list =>
    list.length ? list.map(item => `\`${item}\``).join('<br>') : '—'
  for (const req of requirements) {
    const status =
      req.status === 'out-of-scope'
        ? `out of scope${req.issue ? ` (${req.issue})` : ''}`
        : 'implemented'
    const design = [req.design, ...(req.adr ?? [])].join('<br>')
    lines.push(
      `| ${req.id} | ${req.title} | ${status} | ${design} | ${cell(req.code)} | ${cell(req.tests)} |`
    )
  }
  return `${lines.join('\n')}\n`
}

function check(base = process.cwd()) {
  const errors = []
  const read = file => fs.readFileSync(path.join(base, file), 'utf8')
  const requirementsMd = read('docs/REQUIREMENTS.md')
  const designMd = read('docs/DESIGN.md')
  let requirements
  try {
    ;({ requirements } = JSON.parse(read('docs/traceability.json')))
  } catch (error) {
    return {
      errors: [`docs/traceability.json is unreadable: ${error.message}`],
      rendered: '',
    }
  }
  if (!Array.isArray(requirements)) {
    return {
      errors: ['docs/traceability.json must contain a requirements array'],
      rendered: '',
    }
  }

  const documented = requirementIdsFromMarkdown(requirementsMd)
  const traced = new Set(requirements.map(req => req.id))
  for (const id of documented) {
    if (!traced.has(id))
      errors.push(`${id} is in REQUIREMENTS.md but not in traceability.json`)
  }
  for (const id of traced) {
    if (!documented.has(id))
      errors.push(`${id} is in traceability.json but not in REQUIREMENTS.md`)
  }

  const coveredCode = []
  const coveredTests = []
  for (const req of requirements) {
    if (!ID_PATTERN.test(req.id)) errors.push(`${req.id}: malformed ID`)
    if (req.status === 'out-of-scope') {
      if (!req.issue && !req.note)
        errors.push(`${req.id}: out-of-scope without issue or note`)
      continue
    }
    if (req.status !== 'implemented')
      errors.push(`${req.id}: unknown status ${req.status}`)
    if (!req.code?.length) errors.push(`${req.id}: no code mapped`)
    if (!req.tests?.length) errors.push(`${req.id}: no tests mapped`)
    if (!req.design || !headingExists(designMd, req.design)) {
      errors.push(
        `${req.id}: design reference "${req.design}" has no matching DESIGN.md section`
      )
    }
    for (const adr of req.adr ?? []) {
      const found = fs
        .readdirSync(path.join(base, 'docs/decisions'))
        .some(f => f.startsWith(adr))
      if (!found) errors.push(`${req.id}: ${adr} not found in docs/decisions`)
    }
    for (const file of req.code ?? []) {
      if (!fs.existsSync(path.join(base, file)))
        errors.push(`${req.id}: missing code path ${file}`)
      coveredCode.push(file)
    }
    for (const file of req.tests ?? []) {
      if (!fs.existsSync(path.join(base, file)))
        errors.push(`${req.id}: missing test ${file}`)
      else if (!TEST_PATTERN.test(file))
        errors.push(`${req.id}: ${file} is not a test file`)
      coveredTests.push(file)
    }
  }

  const allCovered = [...coveredCode, ...coveredTests]
  for (const root of GOVERNED_SOURCE_ROOTS) {
    for (const file of walk(root, base)) {
      if (TEST_PATTERN.test(file) || file.includes('/__tests__/')) continue
      if (!/\.(ts|tsx|js)$/.test(file)) continue
      if (!allCovered.some(entry => covers(entry, file))) {
        errors.push(`orphan source file (no requirement): ${file}`)
      }
    }
  }
  for (const root of TEST_ROOTS) {
    for (const file of walk(root, base)) {
      if (!TEST_PATTERN.test(file)) continue
      if (!coveredTests.includes(file))
        errors.push(`orphan test (no requirement): ${file}`)
    }
  }

  const rendered = render(requirements)
  const matrixPath = path.join(base, 'docs/TRACEABILITY.md')
  if (
    !fs.existsSync(matrixPath) ||
    fs.readFileSync(matrixPath, 'utf8') !== rendered
  ) {
    errors.push('docs/TRACEABILITY.md is stale; run npm run traceability:write')
  }
  return { errors, rendered }
}

function main() {
  const { errors, rendered } = check()
  if (process.argv.includes('--write')) {
    fs.writeFileSync('docs/TRACEABILITY.md', rendered)
    const after = check()
    if (after.errors.length) {
      console.error(after.errors.join('\n'))
      process.exitCode = 1
      return
    }
    console.log('docs/TRACEABILITY.md written')
    return
  }
  if (errors.length) {
    console.error(`Traceability check failed:\n- ${errors.join('\n- ')}`)
    process.exitCode = 1
    return
  }
  console.log('Traceability check passed')
}

if (require.main === module) main()

module.exports = { check, render, requirementIdsFromMarkdown }
