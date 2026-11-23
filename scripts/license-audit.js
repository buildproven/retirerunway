#!/usr/bin/env node
'use strict'

const fs = require('node:fs')

const APPROVED_LICENSES = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'Unlicense',
  'Python-2.0',
  'MPL-2.0',
])

const APPROVED_SHARP_LIBVIPS =
  /^@img\/sharp-libvips-(darwin|linux|win32)-(arm64|x64)(?:-(gnu|musl))?$/
const APPROVED_SHARP_LICENSE = 'LGPL-3.0-or-later'
const APPROVED_PACKAGE_LICENSES = new Map([
  ['@csstools/color-helpers', new Set(['MIT-0'])],
  ['@csstools/css-syntax-patches-for-csstree', new Set(['MIT-0'])],
  ['@csstools/selector-specificity', new Set(['MIT-0'])],
  ['postal-mime', new Set(['MIT-0'])],
  ['json-schema', new Set(['AFL-2.1'])],
])

function packageName(packageReference) {
  const versionSeparator = packageReference.lastIndexOf('@')
  return versionSeparator > 0
    ? packageReference.slice(0, versionSeparator)
    : packageReference
}

function normalizeLicenses(value) {
  return Array.isArray(value) ? value : [value]
}

function licenseIdentifiers(value) {
  if (typeof value !== 'string' || value.trim() === '') return []
  return String(value)
    .replace(/[()]/g, '')
    .split(/\s+(?:OR|AND)\s+/)
    .map(license => license.trim())
    .filter(Boolean)
}

function isAllowed(packageReference, licenseValue) {
  const name = packageName(packageReference)
  const licenseExpressions = normalizeLicenses(licenseValue)
  if (licenseExpressions.length === 0) return false

  return licenseExpressions.every(licenseExpression => {
    const identifiers = licenseIdentifiers(licenseExpression)
    if (identifiers.length === 0) return false
    return identifiers.every(license => {
      if (APPROVED_LICENSES.has(license)) return true
      if (APPROVED_PACKAGE_LICENSES.get(name)?.has(license)) return true
      return (
        license === APPROVED_SHARP_LICENSE && APPROVED_SHARP_LIBVIPS.test(name)
      )
    })
  })
}

function validateLicenses(data) {
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    Object.keys(data).length === 0
  ) {
    throw new Error('license-checker returned no package license metadata')
  }

  const violations = Object.entries(data)
    .filter(
      ([packageReference, info]) => !isAllowed(packageReference, info.licenses)
    )
    .map(([packageReference, info]) => `${packageReference} (${info.licenses})`)

  if (violations.length > 0) {
    throw new Error(`Disallowed package licenses: ${violations.join(', ')}`)
  }

  return { packageCount: Object.keys(data).length }
}

function main() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch (error) {
    throw new Error(
      `license-checker did not return valid JSON: ${error.message}`
    )
  }

  const result = validateLicenses(data)
  console.log(`License audit passed for ${result.packageCount} packages`)
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { packageName, validateLicenses }
