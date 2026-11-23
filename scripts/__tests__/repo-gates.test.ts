import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// BUI-545: the scheduled qa-architect regeneration twice re-added
// `tsc --noEmit <staged files>` to lint-staged. Appending file names makes tsc
// ignore tsconfig.json, so every commit touching a .ts file failed with
// spurious TS errors. These guards fail on main if a regeneration brings it
// back; the type check belongs to the project-wide pre-commit step.

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  'lint-staged': Record<string, string | string[]>
  scripts: Record<string, string>
}

describe('local gate configuration', () => {
  it('never runs tsc from lint-staged', () => {
    const commands = Object.values(packageJson['lint-staged']).flat()

    expect(commands.length).toBeGreaterThan(0)
    expect(commands.filter(command => /\btsc\b/.test(command))).toEqual([])
  })

  it('runs the project-wide type check in the pre-commit hook', () => {
    const hook = readFileSync('.husky/pre-commit', 'utf8')

    expect(hook).toMatch(
      /npm run type-check|tsc --noEmit(?! --skipLibCheck \S)/
    )
  })

  it('keeps a project-wide type-check script that uses tsconfig.json', () => {
    expect(packageJson.scripts['type-check']).toBe('tsc --noEmit')
  })
})
