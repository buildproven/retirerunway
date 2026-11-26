// The open-source export (NFR-07): private sections dropped, private paths
// left out, plugin links pointed at the public repo, and the denylist scan
// finds what is left.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { dropSections, exportPublic, isExcluded, publicPlugin, scan } =
  require('../export-public.js') as {
    exportPublic: (
      root: string,
      dest: string
    ) => { files: number; hits: string[] }
    dropSections: (text: string, headings: string[]) => string
    isExcluded: (file: string) => boolean
    publicPlugin: (text: string) => string
    scan: (dest: string, patterns: RegExp[]) => string[]
  }

describe('NFR-07 public export', () => {
  it('drops a private section up to the next same-level heading', () => {
    const text = [
      '# Guide',
      '',
      '## Keep',
      'kept',
      '',
      '## Sibling app sync (A and B)',
      'private',
      '### Detail',
      'private too',
      '',
      '## Also keep',
      'kept again',
      '',
    ].join('\n')
    const out = dropSections(text, ['## Sibling app sync'])
    expect(out).toContain('## Keep\nkept')
    expect(out).toContain('## Also keep\nkept again')
    expect(out).not.toMatch(/private/)
  })

  it('leaves out private-only paths and keeps the rest', () => {
    expect(isExcluded('docs/archive/old.md')).toBe(true)
    expect(isExcluded('.claude/session-learnings.md')).toBe(true)
    expect(isExcluded('.public-export/denylist.txt')).toBe(true)
    expect(isExcluded('.github/workflows/deploy.yml')).toBe(true)
    expect(isExcluded('.github/workflows/publish-public.yml')).toBe(true)
    expect(isExcluded('.github/workflows/quality.yml')).toBe(false)
    expect(isExcluded('src/engine/plan-check.ts')).toBe(false)
  })

  it('points the plugin links at the public repo and site, keeping the rest', () => {
    const plugin = JSON.parse(
      publicPlugin(
        JSON.stringify({
          name: 'retire-runway',
          version: '1.0.0',
          homepage: 'https://example.com/private',
          repository: 'https://example.com/private',
          privacyPolicyUrl: 'https://example.com/privacy',
        })
      )
    ) as Record<string, string>
    expect(plugin).toEqual({
      name: 'retire-runway',
      version: '1.0.0',
      homepage: 'https://retirerunway.buildproven.ai',
      repository: 'https://github.com/buildproven/retirerunway',
      privacyPolicyUrl: 'https://retirerunway.buildproven.ai/#privacy',
    })
  })

  it('reports every denylist hit with its file and line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rr-export-'))
    try {
      writeFileSync(join(dir, 'a.md'), 'fine\nPat Example lives here\n')
      writeFileSync(join(dir, 'b.bin'), Buffer.from([0, 1, 2, 80, 97, 116]))
      expect(scan(dir, [/pat example/i])).toEqual([
        'a.md:2: matches /pat example/',
      ])
      expect(scan(dir, [/nothing/i])).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The publish job only runs when the version changes; this catches a
  // private detail the moment it lands, not at the next release. Skipped in
  // the public copy, which has no denylist.
  const root = join(__dirname, '..', '..')
  it.skipIf(!existsSync(join(root, '.public-export/denylist.txt')))(
    'exports this repository with no denylist hit',
    () => {
      const dest = mkdtempSync(join(tmpdir(), 'rr-export-'))
      try {
        const { files, hits } = exportPublic(root, dest)
        expect(files).toBeGreaterThan(100)
        expect(hits).toEqual([])
      } finally {
        rmSync(dest, { recursive: true, force: true })
      }
    },
    120_000
  )
})
