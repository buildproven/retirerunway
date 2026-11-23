// knip.config.js lists the MCP server entry files (BUI-1808). run.mjs gives
// src/mcp/main.ts to esbuild as a path string, so Knip cannot follow it as an
// import and would report the whole server as unused.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '..', '..', '..')
const requireFromRoot = createRequire(resolve(repoRoot, 'package.json'))
const knipConfig = requireFromRoot('./knip.config.js') as { entry: string[] }

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

// Every src/mcp file named as a string literal: these load by path, not import.
function pathLoadedMcpFiles(source: string): string[] {
  return [...source.matchAll(/['"](src\/mcp\/[\w./-]+\.(?:ts|mjs))['"]/g)].map(
    match => match[1]
  )
}

describe('knip entries for the MCP server', () => {
  it('lists main.ts, which run.mjs loads by path', () => {
    const loaded = pathLoadedMcpFiles(read('src/mcp/run.mjs'))
    expect(loaded).toContain('src/mcp/main.ts')
    for (const file of loaded) {
      expect(knipConfig.entry).toContain(file)
    }
  })

  it('names only entry files that exist', () => {
    const mcpEntries = knipConfig.entry.filter(entry =>
      entry.startsWith('src/mcp/')
    )
    expect(mcpEntries.length).toBeGreaterThan(0)
    for (const entry of mcpEntries) {
      expect(() => read(entry)).not.toThrow()
    }
  })
})
