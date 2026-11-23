// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// NFR-07 (BUI-1231): a fork PR runs the workflow file from its own head, so it
// can delete the runner-selection condition. The workflow must not claim that
// condition keeps fork code off the self-hosted runner; it must name the repo
// setting that does, and how to check it.
const text = readFileSync(
  resolve(__dirname, '../../../.github/workflows/quality.yml'),
  'utf8'
)

describe('NFR-07 fork PR runner isolation claim', () => {
  it('does not claim the workflow itself keeps fork code off the self-hosted runner', () => {
    expect(text).not.toMatch(/never reaches the self-hosted runner/i)
  })

  it('says a fork PR can edit the runner-selection condition', () => {
    expect(text).toMatch(/fork PR runs this workflow file from its own head/)
    expect(text).toMatch(/defense in depth only/)
  })

  it('names the setting that enforces fork isolation and how to check it', () => {
    expect(text).toMatch(/"Run workflows from fork pull requests" = off/)
    expect(text).toMatch(
      /actions\/permissions\/fork-pr-workflows-private-repos/
    )
  })

  it('names what must change before the repo goes public', () => {
    expect(text).toMatch(/runner group to private repositories/)
    expect(text).toMatch(
      /require approval\s*#?\s*for workflows from all outside collaborators/
    )
  })
})
