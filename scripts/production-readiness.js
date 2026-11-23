#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { loadEnvConfig } = require('@next/env')

const STATIC_REQUIREMENTS = [
  ['vercel-config', 'vercel.json'],
  ['environment-template', '.env.example'],
  ['privacy-route', 'src/app/privacy/page.tsx'],
  ['terms-route', 'src/app/terms/page.tsx'],
  ['portfolio-migration', 'supabase/migrations/20260131_create_portfolios.sql'],
  [
    'subscription-migration',
    'supabase/migrations/20260811_create_subscriptions.sql',
  ],
]

function hasValue(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function check(id, label, passed, detail) {
  return { id, label, status: passed ? 'pass' : 'block', detail }
}

function isSupabaseUrl(value) {
  if (!hasValue(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname.endsWith('.supabase.co')
  } catch {
    return false
  }
}

function hasExpectedPrefix(value, prefixes) {
  return prefixes.some(prefix => hasValue(value) && value.startsWith(prefix))
}

function loadNextEnvironment(repoRoot, mode) {
  const { combinedEnv } = loadEnvConfig(repoRoot, mode === 'local')
  return combinedEnv
}

function evaluateReadiness({
  env = process.env,
  repoRoot = path.resolve(__dirname, '..'),
  mode = 'production',
  requireSubscriptions = false,
} = {}) {
  if (!['local', 'preview', 'production'].includes(mode)) {
    throw new Error(`Unsupported readiness mode: ${mode}`)
  }

  const checks = STATIC_REQUIREMENTS.map(([id, relativePath]) => {
    const absolutePath = path.join(repoRoot, relativePath)
    return check(
      id,
      `Required file: ${relativePath}`,
      fs.existsSync(absolutePath),
      fs.existsSync(absolutePath) ? 'present' : 'missing'
    )
  })

  if (mode === 'local') {
    checks.push(
      check(
        'local-subscription-boundary',
        'Local mode keeps paid subscriptions disabled',
        env.SUBSCRIPTIONS_ENABLED !== 'true',
        env.SUBSCRIPTIONS_ENABLED === 'true'
          ? 'disable SUBSCRIPTIONS_ENABLED for local-only mode'
          : 'paid subscription rollout is disabled'
      )
    )
  } else {
    const paidChecksRequired =
      requireSubscriptions || env.SUBSCRIPTIONS_ENABLED === 'true'
    checks.push(
      check(
        'supabase-public-url',
        'Supabase public URL',
        isSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL),
        isSupabaseUrl(env.NEXT_PUBLIC_SUPABASE_URL)
          ? 'configured'
          : 'must be an HTTPS *.supabase.co URL'
      ),
      check(
        'supabase-public-key',
        'Supabase anonymous key',
        hasValue(env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
        hasValue(env.NEXT_PUBLIC_SUPABASE_ANON_KEY) ? 'configured' : 'missing'
      ),
      check(
        'supabase-service-key',
        'Supabase service-role key',
        hasValue(env.SUPABASE_SERVICE_ROLE_KEY),
        hasValue(env.SUPABASE_SERVICE_ROLE_KEY) ? 'configured' : 'missing'
      ),
      check(
        'subscription-rollout',
        'Paid subscriptions are either disabled or explicitly required',
        !requireSubscriptions && env.SUBSCRIPTIONS_ENABLED !== 'true'
          ? true
          : env.SUBSCRIPTIONS_ENABLED === 'true',
        !requireSubscriptions && env.SUBSCRIPTIONS_ENABLED !== 'true'
          ? 'disabled; deployment readiness does not activate billing'
          : env.SUBSCRIPTIONS_ENABLED === 'true'
            ? 'enabled'
            : 'set SUBSCRIPTIONS_ENABLED=true only for an approved paid go-live'
      )
    )

    if (paidChecksRequired) {
      checks.push(
        check(
          'subscriptions-ready',
          'Subscription persistence readiness flag',
          env.SUBSCRIPTIONS_READY === 'true',
          env.SUBSCRIPTIONS_READY === 'true'
            ? 'enabled'
            : 'set SUBSCRIPTIONS_READY=true after migration verification'
        ),
        check(
          'subscriptions-enabled',
          'Subscription rollout flag',
          env.SUBSCRIPTIONS_ENABLED === 'true',
          env.SUBSCRIPTIONS_ENABLED === 'true'
            ? 'enabled'
            : 'set SUBSCRIPTIONS_ENABLED=true only for an approved paid go-live'
        )
      )

      const stripeSecretPrefixes =
        mode === 'production' ? ['sk_live_'] : ['sk_test_']
      const stripePublicPrefixes =
        mode === 'production' ? ['pk_live_'] : ['pk_test_']
      checks.push(
        check(
          'stripe-secret-key',
          'Stripe secret key',
          hasExpectedPrefix(env.STRIPE_SECRET_KEY, stripeSecretPrefixes),
          hasExpectedPrefix(env.STRIPE_SECRET_KEY, stripeSecretPrefixes)
            ? 'configured'
            : `must use ${stripeSecretPrefixes.join(' or ')} prefix`
        ),
        check(
          'stripe-webhook-secret',
          'Stripe webhook secret',
          hasExpectedPrefix(env.STRIPE_WEBHOOK_SECRET, ['whsec_']),
          hasExpectedPrefix(env.STRIPE_WEBHOOK_SECRET, ['whsec_'])
            ? 'configured'
            : 'must use whsec_ prefix'
        ),
        check(
          'stripe-public-key',
          'Stripe publishable key',
          hasExpectedPrefix(
            env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
            stripePublicPrefixes
          ),
          hasExpectedPrefix(
            env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
            stripePublicPrefixes
          )
            ? 'configured'
            : `must use ${stripePublicPrefixes.join(' or ')} prefix`
        )
      )

      const allowedPriceIds = hasValue(env.STRIPE_ALLOWED_PRICE_IDS)
        ? env.STRIPE_ALLOWED_PRICE_IDS.split(',')
            .map(value => value.trim())
            .filter(Boolean)
        : [env.STRIPE_PRO_PRICE_ID].filter(hasValue)
      checks.push(
        check(
          'stripe-price-allowlist',
          'Stripe Pro price allowlist',
          hasValue(env.STRIPE_PRO_PRICE_ID) &&
            allowedPriceIds.includes(env.STRIPE_PRO_PRICE_ID),
          hasValue(env.STRIPE_PRO_PRICE_ID) &&
            allowedPriceIds.includes(env.STRIPE_PRO_PRICE_ID)
            ? 'configured'
            : 'STRIPE_ALLOWED_PRICE_IDS must include STRIPE_PRO_PRICE_ID'
        )
      )
    }
  }

  return {
    status: checks.every(item => item.status === 'pass') ? 'ready' : 'blocked',
    mode,
    checks,
  }
}

function parseArgs(argv) {
  const options = {
    mode: 'production',
    requireSubscriptions: false,
    json: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--json') {
      options.json = true
    } else if (argument === '--require-subscriptions') {
      options.requireSubscriptions = true
    } else if (argument === '--mode') {
      options.mode = argv[++index]
    } else if (argument.startsWith('--mode=')) {
      options.mode = argument.slice('--mode='.length)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const repoRoot = path.resolve(__dirname, '..')
  const result = evaluateReadiness({
    env: loadNextEnvironment(repoRoot, options.mode),
    mode: options.mode,
    requireSubscriptions: options.requireSubscriptions,
    repoRoot,
  })
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`Production readiness: ${result.status} (${result.mode})`)
    for (const item of result.checks) {
      console.log(
        `- ${item.status.toUpperCase()}: ${item.label} — ${item.detail}`
      )
    }
    if (result.status === 'ready') {
      console.log(
        'This checks configuration shape and repository contracts only; it does not prove live service, deployment, legal, or customer acceptance.'
      )
    }
  }
  process.exitCode = result.status === 'ready' ? 0 : 1
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { evaluateReadiness, loadNextEnvironment, parseArgs }
