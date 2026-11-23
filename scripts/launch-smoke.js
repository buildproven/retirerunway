#!/usr/bin/env node
'use strict'

const PUBLIC_ROUTES = [
  ['/', 'Know what to do'],
  ['/features', 'Features'],
  ['/pricing', 'Simple, Transparent Pricing'],
  ['/faq', 'Frequently Asked Questions'],
  ['/about', 'About RetireRunway'],
  ['/privacy', 'Privacy Policy'],
  ['/terms', 'Terms of Service'],
]

const PROTECTED_ROUTE = '/api/subscription'
const LOCAL_AUTH_CONFIGURATION_ERROR =
  'Authentication service is not configured'

function parseArgs(argv) {
  const baseUrlIndex = argv.findIndex(argument => argument === '--base-url')
  const modeIndex = argv.findIndex(argument => argument === '--mode')
  const baseUrl =
    baseUrlIndex >= 0
      ? argv[baseUrlIndex + 1]
      : argv[0]?.startsWith('http') && argv[0]
  if (!baseUrl) {
    throw new Error('Usage: launch-smoke.js --base-url <url>')
  }
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : 'local'
  if (!['local', 'preview', 'production'].includes(mode)) {
    throw new Error(`Unsupported smoke mode: ${mode}`)
  }
  return { baseUrl: baseUrl.replace(/\/$/, ''), mode }
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
    })
    const body = await response.text()
    return { response, body }
  } finally {
    clearTimeout(timeout)
  }
}

async function readResponse(request, url) {
  const result = await request(url)
  if (
    result &&
    typeof result === 'object' &&
    'response' in result &&
    'body' in result
  ) {
    return result
  }
  return { response: result, body: await result.text() }
}

async function runSmoke({
  baseUrl,
  mode = 'local',
  request = fetchWithTimeout,
} = {}) {
  if (!baseUrl) throw new Error('baseUrl is required')
  const expectedProtectedStatuses = mode === 'local' ? [401, 503] : [401]
  const failures = []
  const checked = []

  for (const [route, marker] of PUBLIC_ROUTES) {
    const { response, body } = await readResponse(request, `${baseUrl}${route}`)
    checked.push(route)
    if (response.status !== 200) {
      failures.push(`${route}: expected 200, received ${response.status}`)
    } else if (!body.includes(marker)) {
      failures.push(`${route}: response did not contain expected page marker`)
    }
  }

  const { response, body } = await readResponse(
    request,
    `${baseUrl}${PROTECTED_ROUTE}`
  )
  checked.push(PROTECTED_ROUTE)
  const localConfigurationResponse =
    mode === 'local' &&
    response.status === 503 &&
    body.includes(LOCAL_AUTH_CONFIGURATION_ERROR)
  if (!expectedProtectedStatuses.includes(response.status)) {
    failures.push(
      `${PROTECTED_ROUTE}: expected 401${mode === 'local' ? ' or the local missing-auth 503 response' : ''}, received ${response.status}`
    )
  } else if (response.status === 503 && !localConfigurationResponse) {
    failures.push(
      `${PROTECTED_ROUTE}: 503 did not identify missing authentication configuration`
    )
  }

  return { status: failures.length === 0 ? 'pass' : 'fail', checked, failures }
}

async function main() {
  const { baseUrl, mode } = parseArgs(process.argv.slice(2))
  const result = await runSmoke({ baseUrl, mode })
  for (const route of result.checked) console.log(`CHECKED ${route}`)
  if (result.status === 'pass') {
    console.log(
      'Launch smoke passed: public routes and protected API boundary responded as expected.'
    )
    return
  }
  for (const failure of result.failures) console.error(`BLOCKED: ${failure}`)
  process.exitCode = 1
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Launch smoke failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  LOCAL_AUTH_CONFIGURATION_ERROR,
  PUBLIC_ROUTES,
  PROTECTED_ROUTE,
  fetchWithTimeout,
  parseArgs,
  runSmoke,
}
