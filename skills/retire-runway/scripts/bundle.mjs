// Bundles each TS entrypoint with its engine deps into dist/ for execution.
import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(here, '..', 'dist')
await mkdir(outDir, { recursive: true })

const entries = [
  'load-portfolio.ts',
  'monte-carlo.ts',
  'roth-conversion.ts',
  'rule-of-55.ts',
  'trade-plan.ts',
  'analyze.ts',
]

for (const entry of entries) {
  await build({
    entryPoints: [resolve(here, entry)],
    outfile: resolve(outDir, entry.replace(/\.ts$/, '.mjs')),
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: ['node:*'],
  })
}
console.log('bundled', entries.length, 'entries to', outDir)
