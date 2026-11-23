import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = 'scripts/production-readiness.js'

function run(
  env: Record<string, string>,
  mode = 'production',
  requireSubscriptions = false
) {
  const args = [script, '--mode', mode, '--json']
  if (requireSubscriptions) args.push('--require-subscriptions')
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

const productionEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://retire-runway.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  SUBSCRIPTIONS_READY: 'true',
  SUBSCRIPTIONS_ENABLED: 'true',
  STRIPE_SECRET_KEY: 'sk_live_example',
  STRIPE_WEBHOOK_SECRET: 'whsec_example',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_example',
  STRIPE_PRO_PRICE_ID: 'price_pro',
  STRIPE_ALLOWED_PRICE_IDS: 'price_pro,price_other',
}

describe('production readiness contract', () => {
  it('blocks incomplete production configuration without printing secret values', () => {
    const result = run(
      {
        ...productionEnv,
        SUBSCRIPTIONS_ENABLED: 'false',
        STRIPE_SECRET_KEY: '',
      },
      'production',
      true
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('"status": "blocked"')
    expect(result.stdout).toContain('subscriptions-enabled')
    expect(result.stdout).not.toContain('service-role-key')
    expect(result.stdout).not.toContain('sk_live_example')
  })

  it('accepts a complete production configuration', () => {
    const result = run(productionEnv)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"status": "ready"')
    expect(result.stdout).not.toContain('service-role-key')
    expect(result.stdout).not.toContain('sk_live_example')
  })

  it('uses the Pro price as the default allowlist entry', () => {
    const result = run({
      ...productionEnv,
      STRIPE_ALLOWED_PRICE_IDS: '',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"status": "ready"')
  })

  it('allows a production deployment while paid rollout stays disabled', () => {
    const result = run({
      NEXT_PUBLIC_SUPABASE_URL: productionEnv.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY:
        productionEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: productionEnv.SUPABASE_SERVICE_ROLE_KEY,
      SUBSCRIPTIONS_READY: 'false',
      SUBSCRIPTIONS_ENABLED: 'false',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"status": "ready"')
    expect(result.stdout).toContain('subscription-rollout')
  })

  it('requires explicit paid go-live mode before enabling subscriptions', () => {
    const result = run(
      {
        ...productionEnv,
        SUBSCRIPTIONS_ENABLED: 'false',
      },
      'production',
      true
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('subscription-rollout')
  })

  it('supports local-only mode while keeping paid rollout disabled', () => {
    const result = run({ SUBSCRIPTIONS_ENABLED: 'false' }, 'local')

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('"mode": "local"')
    expect(result.stdout).toContain('"status": "ready"')
  })

  it('rejects test Stripe keys for production', () => {
    const result = run({
      ...productionEnv,
      STRIPE_SECRET_KEY: 'sk_test_example',
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
    })

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('stripe-secret-key')
    expect(result.stdout).toContain('stripe-public-key')
  })

  it('loads the same local environment file precedence as Next', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'retire-runway-env-'))
    const helper = `
      const { loadNextEnvironment } = require(${JSON.stringify(
        `${process.cwd()}/${script}`
      )})
      process.stdout.write(loadNextEnvironment(${JSON.stringify(
        temporaryRoot
      )}, 'preview').FROM_ENV_FILE || '')
    `

    try {
      writeFileSync(
        join(temporaryRoot, '.env.local'),
        'FROM_ENV_FILE=loaded-by-next-precedence\n'
      )
      const result = spawnSync(process.execPath, ['-e', helper], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: (() => {
          const childEnv = { ...process.env }
          delete childEnv.FROM_ENV_FILE
          childEnv.NODE_ENV = 'production'
          return childEnv
        })(),
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('loaded-by-next-precedence')
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  })
})
