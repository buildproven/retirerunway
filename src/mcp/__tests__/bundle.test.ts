// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bundleServer } from '../bundle.mjs'

const entry = resolve(__dirname, '..', 'main.ts')
const created: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rr-mcp-bundle-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true })
})

type Call = readonly [string, ...unknown[]]

function recordingFs(failRename = false) {
  const calls: Call[] = []
  return {
    calls,
    fs: {
      mkdir: async (path: string) => {
        calls.push(['mkdir', path])
        return undefined
      },
      writeFile: async (path: string) => {
        calls.push(['writeFile', path])
      },
      rename: async (from: string, to: string) => {
        calls.push(['rename', from, to])
        if (failRename) throw new Error('rename failed')
      },
      rm: async (path: string) => {
        calls.push(['rm', path])
      },
    },
  }
}

describe('REQ-MCP-1: npm run mcp publishes its server bundle atomically', () => {
  it('REQ-MCP-1 never writes the shared bundle path in place; it renames a unique temporary file over it', async () => {
    const outfile = join(tempDir(), 'server.mjs')
    const first = recordingFs()
    const second = recordingFs()
    await bundleServer({ entry, outfile, fs: first.fs })
    await bundleServer({ entry, outfile, fs: second.fs })

    for (const { calls } of [first, second]) {
      const writes = calls.filter(call => call[0] === 'writeFile')
      expect(writes).toHaveLength(1)
      expect(writes[0][1]).not.toBe(outfile)
      expect(calls.at(-1)).toEqual(['rename', writes[0][1], outfile])
    }
    const temporaryOf = (calls: Call[]) =>
      calls.find(call => call[0] === 'writeFile')?.[1]
    expect(temporaryOf(first.calls)).not.toBe(temporaryOf(second.calls))
  })

  it('REQ-MCP-1 removes the temporary file and reports the error when publishing fails', async () => {
    const outfile = join(tempDir(), 'server.mjs')
    const { calls, fs } = recordingFs(true)
    await expect(bundleServer({ entry, outfile, fs })).rejects.toThrow(
      'rename failed'
    )
    const temporary = calls.find(call => call[0] === 'writeFile')?.[1]
    expect(calls.at(-1)).toEqual(['rm', temporary])
  })

  it('REQ-MCP-1 overlapping builds never expose a partial bundle and leave no temporary files', async () => {
    const dir = tempDir()
    const outfile = join(dir, 'server.mjs')
    await bundleServer({ entry, outfile, fs: { mkdir, rename, rm, writeFile } })
    const complete = readFileSync(outfile, 'utf8')
    expect(complete.length).toBeGreaterThan(1_000)

    let building = true
    const reads: string[] = []
    const reader = (async () => {
      while (building) {
        reads.push(await readFile(outfile, 'utf8'))
        await new Promise(resolveTick => setImmediate(resolveTick))
      }
    })()
    await Promise.all(
      Array.from({ length: 6 }, () => bundleServer({ entry, outfile }))
    )
    building = false
    await reader

    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toBe(complete)
    expect(readdirSync(dir)).toEqual(['server.mjs'])
  })
})
