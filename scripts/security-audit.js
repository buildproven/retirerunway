#!/usr/bin/env node
'use strict'

const fs = require('node:fs')

// Dev-only advisories with no patched release. Each reaches the tree only
// through dev tooling (stylelint, lint-staged, knip, eslint, vite/vitest) that
// globs repository-controlled patterns. Production deps are audited separately
// with --omit=dev and get no exception. Remove an entry when its package ships
// a fix.
//
// GHSA-vfj7-8cjw-p6xm: braces <=3.0.3 stack exhaustion on deeply nested glob
// patterns. braces latest is 3.0.3; micromatch 4.0.8 pins braces ^3.
//
// GHSA-fc5q-39xc-vjpf: picomatch <=4.0.7 ReDoS through single-branch repeated
// extglobs. picomatch latest is 4.0.7 (checked 2026-11-17).
//
// GHSA-g3hv-75wg-m249: minimatch >=7.0.0 <11.0.1 (moderate) DoS via globparts
// amplification. The fix is minimatch 11, which the ESLint plugin chain
// (typescript-estree, eslint-plugin-import) does not accept yet. It sits inside
// the high-severity chains above, so the chain check has to allow it too.
const ALLOWED_ADVISORIES = Object.freeze([
  Object.freeze({
    name: 'braces',
    source: 1240992,
    url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
  }),
  Object.freeze({
    name: 'picomatch',
    source: 1247710,
    url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
  }),
  Object.freeze({
    name: 'minimatch',
    source: 1244623,
    url: 'https://github.com/advisories/GHSA-g3hv-75wg-m249',
  }),
])
const HIGH_SEVERITIES = new Set(['high', 'critical'])

function parseAuditInput(raw) {
  let data
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(`npm audit did not return valid JSON: ${error.message}`)
  }
  if (data.error) {
    throw new Error(
      `npm audit returned an error object: ${JSON.stringify(data.error)}`
    )
  }
  if (!data.vulnerabilities || typeof data.vulnerabilities !== 'object') {
    throw new Error('npm audit JSON has no vulnerabilities object')
  }
  return data
}

function isAllowedAdvisory(value) {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    ALLOWED_ADVISORIES.some(
      advisory =>
        value.name === advisory.name &&
        value.source === advisory.source &&
        value.url === advisory.url
    )
  )
}

// A finding is allowed only when every path through `via` ends in a
// documented advisory. Any other advisory anywhere in the chain fails it.
function isAllowedChain(packageName, vulnerabilities, seen = new Set()) {
  if (seen.has(packageName)) return true
  const vulnerability = vulnerabilities[packageName]
  if (!vulnerability || !Array.isArray(vulnerability.via)) return false
  const nextSeen = new Set(seen).add(packageName)
  return vulnerability.via.every(reference =>
    typeof reference === 'string'
      ? isAllowedChain(reference, vulnerabilities, nextSeen)
      : isAllowedAdvisory(reference)
  )
}

function validateAudit(data) {
  const vulnerabilities = data.vulnerabilities
  const highSeverity = Object.entries(vulnerabilities).filter(
    ([, vulnerability]) => HIGH_SEVERITIES.has(vulnerability.severity)
  )
  const unexpected = highSeverity
    .filter(([packageName]) => !isAllowedChain(packageName, vulnerabilities))
    .map(
      ([packageName, vulnerability]) =>
        `${packageName} (${vulnerability.severity})`
    )

  if (unexpected.length > 0) {
    throw new Error(
      `npm audit found high-severity vulnerabilities outside the documented dev-only advisories: ${unexpected.join(', ')}`
    )
  }

  return { highSeverityCount: highSeverity.length }
}

function main() {
  const data = parseAuditInput(fs.readFileSync(0, 'utf8'))
  const result = validateAudit(data)
  const auditStatus = Number(process.env.NPM_AUDIT_STATUS ?? 0)
  if (auditStatus === 1 && result.highSeverityCount === 0) {
    throw new Error(
      'npm audit exited with status 1 but reported no high-severity vulnerabilities'
    )
  }
  console.log(
    'npm audit passed; only the documented dev-only advisories (braces, picomatch, minimatch) are allowlisted'
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { parseAuditInput, validateAudit }
