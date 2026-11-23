// Builds the retire-runway skill bundle once, before any vitest worker starts
// (BUI-1452). Per-file builds let one worker rewrite dist/*.mjs while another
// ran node on it. A failed build throws, so vitest aborts instead of running
// tests against a stale or partial dist/.
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleScript = resolve(
  repoRoot,
  'skills/retire-runway/scripts/bundle.mjs'
)

export type BuildRunner = (command: string, args: string[]) => void

const runBuild: BuildRunner = (command, args) => {
  execFileSync(command, args, { cwd: repoRoot, stdio: 'pipe' })
}

export function buildSkillBundle(run: BuildRunner = runBuild): void {
  try {
    run(process.execPath, [bundleScript])
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`skill bundle build failed: ${detail}`, { cause: error })
  }
}

export default function setup(): void {
  buildSkillBundle()
}
