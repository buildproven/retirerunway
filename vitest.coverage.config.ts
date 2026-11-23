import { defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vitest.config'

// The release coverage gate measures deterministic calculations and the
// security-sensitive adapters, routes, and auth surfaces that feed them.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        include: [
          'src/engine/**/*.ts',
          'src/lib/**/*.ts',
          'src/services/**/*.ts',
          'src/store/**/*.ts',
          'src/app/api/**/*.ts',
          'src/components/auth-card.tsx',
          'src/components/auth-listener.tsx',
          'src/components/sync-status-indicator.tsx',
        ],
        thresholds: {
          lines: 70,
          functions: 70,
          branches: 70,
          // Exact file globs keep a well-covered engine from offsetting an
          // untested API or auth boundary.
          'src/app/api/auth/webhook/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/email/send-onboarding/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/narrate/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/plaid/create-link-token/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/plaid/exchange-token/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/stripe/checkout/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/stripe/webhook/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/subscription/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/v1/analyze/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/v1/tax/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/app/api/what-if/route.ts': {
            lines: 30,
            functions: 60,
            branches: 20,
          },
          'src/components/auth-card.tsx': {
            lines: 30,
            functions: 30,
            branches: 10,
          },
          'src/components/auth-listener.tsx': {
            lines: 30,
            functions: 40,
            branches: 5,
          },
          'src/components/sync-status-indicator.tsx': {
            lines: 35,
            functions: 35,
            branches: 10,
          },
        },
      },
    },
  })
)
