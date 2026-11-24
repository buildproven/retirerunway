// @vitest-environment node
// The repo root is the RetireRunway Claude plugin (BUI-1859): the marketplace
// buildproven/claude-plugins lists it by GitHub source, so the root must hold
// a valid .claude-plugin/plugin.json, a .mcp.json naming the hosted server,
// and the skill. Chat loads only remote http servers, so the .mcpb desktop
// extension is gone and the stdio server stays the developer path.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { createPlanServer } from '../server'

const repoRoot = resolve(__dirname, '..', '..', '..')
const skillDir = resolve(repoRoot, 'skills/retire-runway')
const PRODUCTION_MCP_URL = 'https://retire-runway.vercel.app/api/mcp'

const SKILL_TOOLS = [
  'analyze_plan',
  'build_plan',
  'compare_plans',
  'compare_retirement_scenarios',
  'delete_user_data',
  'earliest_retirement',
  'explain_change',
  'explore_claiming_ages',
  'explore_roth_conversions',
  'get_briefing',
  'get_profile',
  'historical_backtest',
  'import_positions',
  'list_snapshots',
  'plan_check',
  'plan_monte_carlo',
  'plan_verdict',
  'portfolio_analysis',
  'project_retirement',
  'propose_plan_rules',
  'rank_levers',
  'review_plan',
  'save_plan_notes',
  'save_profile',
  'spending_guardrails',
  'tax_strategy',
  'trade_plan',
]

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8')
}

function readJson(path: string): unknown {
  return JSON.parse(read(path))
}

function readSkill(): { frontmatter: Record<string, string>; body: string } {
  const text = read('skills/retire-runway/SKILL.md')
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) throw new Error('SKILL.md has no frontmatter block')
  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z_-]+):\s*(.*)$/)
    if (!field)
      throw new Error(`SKILL.md frontmatter line is not a field: ${line}`)
    frontmatter[field[1]] = field[2].trim()
  }
  return { frontmatter, body: match[2] }
}

function readmeFirstSection(): string {
  return read('README.md').split(/^## /m)[1]
}

async function serverToolNames(): Promise<string[]> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await createPlanServer().connect(serverTransport)
  const client = new Client({ name: 'plugin-test', version: '0.0.0' })
  await client.connect(clientTransport)
  try {
    const { tools } = await client.listTools()
    return tools.map(tool => tool.name).sort()
  } finally {
    await client.close()
  }
}

/** Why `claude plugin validate` cannot run here, or null when it can. */
function claudeCliMissing(): string | null {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' })
  if (probe.error)
    return `claude CLI not found on PATH (${probe.error.message})`
  if (probe.status !== 0) return `claude --version exited ${probe.status}`
  return null
}

describe('REQ-PLUGIN-1: the repo root is a valid Claude plugin', () => {
  it('REQ-PLUGIN-1 .claude-plugin/plugin.json names the plugin after the repo and the package', () => {
    const plugin = readJson('.claude-plugin/plugin.json') as {
      name: string
      version?: string
      description?: string
    }
    const packageJson = readJson('package.json') as {
      name: string
      version: string
    }
    expect(plugin.name).toBe('retire-runway')
    expect(plugin.name).toBe(packageJson.name)
    expect(plugin.version).toBe(packageJson.version)
    expect(plugin.description?.length ?? 0).toBeGreaterThan(0)
  })

  it('REQ-PLUGIN-1 claude plugin validate . passes at the repo root', ctx => {
    const missing = claudeCliMissing()
    if (missing) {
      console.warn(`REQ-PLUGIN-1 skipped: ${missing}`)
      ctx.skip(`REQ-PLUGIN-1 skipped: ${missing}`)
    }
    const validate = spawnSync('claude', ['plugin', 'validate', '.'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    const output = validate.stdout + validate.stderr
    expect(validate.status, output).toBe(0)
    expect(output).toMatch(/Validation passed/)
    // Without a manifest the validator still passes on the skills tree alone.
    expect(output).not.toMatch(/MANIFEST_NOT_FOUND/)
  }, 60_000)
})

describe('REQ-PLUGIN-2: .mcp.json declares the hosted server', () => {
  it('REQ-PLUGIN-2 declares one server retire-runway of type http at the production /api/mcp URL', () => {
    const config = readJson('.mcp.json') as Record<string, unknown>
    const servers = (config.mcpServers ?? config) as Record<
      string,
      Record<string, unknown>
    >
    expect(Object.keys(servers)).toEqual(['retire-runway'])
    expect(servers['retire-runway']).toEqual({
      type: 'http',
      url: PRODUCTION_MCP_URL,
    })
    const url = new URL(PRODUCTION_MCP_URL)
    expect(url.protocol).toBe('https:')
    expect(url.pathname).toBe('/api/mcp')
  })

  it('REQ-PLUGIN-2 declares no local command server, which chat ignores', () => {
    const text = read('.mcp.json')
    expect(text).not.toMatch(/"command"\s*:/)
    expect(text).not.toMatch(/"stdio"/)
  })
})

describe('REQ-PLUGIN-3: the skill uses the hosted tools and the saved data', () => {
  it('REQ-PLUGIN-3 names every hosted tool, and every tool it names is registered by the server', async () => {
    const { body } = readSkill()
    const named = [...new Set(body.match(/`[a-z]+(?:_[a-z]+)+`/g) ?? [])]
      .map(token => token.slice(1, -1))
      .sort()
    expect(named).toEqual(SKILL_TOOLS)
    expect(await serverToolNames()).toEqual(named)
  })

  it('REQ-PLUGIN-3 says the data comes from the owner saved profile and snapshots', () => {
    const { body } = readSkill()
    expect(body).toMatch(/hosted/i)
    expect(body).toMatch(/owner's saved profile and (position )?snapshots/i)
  })

  it('REQ-PLUGIN-3 has no local path or install step', () => {
    const text = read('skills/retire-runway/SKILL.md')
    expect(text).not.toMatch(/~\//)
    expect(text).not.toMatch(/\/(Users|home)\//)
    expect(text).not.toMatch(/on (this|the user's) machine/i)
    expect(text).not.toMatch(/locally/i)
    expect(text).not.toMatch(/RETIRE_RUNWAY_DATA_DIR/)
    expect(text).not.toMatch(/claude mcp add/)
    expect(text).not.toMatch(/desktop extension|\.mcpb/i)
    expect(text).not.toMatch(/\bnpm\b|\bnode scripts\//)
    expect(text).not.toMatch(/\binstall/i)
  })

  it('REQ-PLUGIN-3 keeps the REQ-AGENT-1 contract: saved data first, narrate, a tool result for each number', () => {
    const { body } = readSkill()
    const firstStep = body
      .split('\n')
      .find(line => /\bfirst\b/i.test(line) && line.includes('`get_briefing`'))
    // get_briefing returns the saved profile, snapshots and plan notes.
    expect(firstStep).toBeDefined()
    expect(body).toContain('`get_profile`')
    expect(body).toContain('`list_snapshots`')
    expect(body).toMatch(/saved (profile|data)/i)
    expect(body).toMatch(/never calculate/i)
    expect(body).toMatch(/every number[^.]*tool result/i)
    expect(body).not.toMatch(/scripts\/[a-z-]+\.ts/)
  })

  it('REQ-PLUGIN-3 finds a new positions file in the attachment, Downloads or Gmail, and saves after a dry run', () => {
    const { body } = readSkill()
    const section = body
      .split(/^## /m)
      .find(s => s.startsWith('Get a new positions file'))
    expect(section).toBeDefined()
    expect(section).toMatch(/attachment/i)
    expect(section).toMatch(/Downloads folder/)
    expect(section).toMatch(/Gmail/)
    expect(section).toMatch(/from:me has:attachment filename:csv/)
    expect(section).toContain('`list_snapshots`')
    expect(section).toContain('`save: true`')
  })

  it('REQ-PLUGIN-3 has valid frontmatter: name matches the folder, description at most 1,024 characters', () => {
    const { frontmatter } = readSkill()
    expect(Object.keys(frontmatter).sort()).toEqual(['description', 'name'])
    expect(frontmatter.name).toBe(basename(skillDir))
    expect(frontmatter.name).toMatch(/^[a-z0-9-]{1,64}$/)
    expect(frontmatter.description.length).toBeGreaterThan(0)
    expect(frontmatter.description.length).toBeLessThanOrEqual(1024)
    expect(frontmatter.description).not.toMatch(/[<>]/)
    expect(frontmatter.description).not.toMatch(/on the user's machine/i)
  })
})

describe('REQ-PLUGIN-4: README starts with the one-time install; the .mcpb build is gone', () => {
  it('REQ-PLUGIN-4 the first README section gives the one-time install and the connector step', () => {
    const first = readmeFirstSection()
    expect(first.split('\n')[0]).toBe('Use RetireRunway in Claude')
    expect(first).toMatch(/Connectors/)
    expect(first).toMatch(/once/i)
    expect(first).toMatch(/web UI is frozen/i)
  })

  it('REQ-PLUGIN-4 keeps npm run mcp as the developer path and drops the .mcpb build', () => {
    const readme = read('README.md')
    expect(readmeFirstSection()).toContain('npm run mcp')
    expect(readme).not.toMatch(/npm run mcpb|\.mcpb\b|manifest\.json/)
    const packageJson = readJson('package.json') as {
      scripts: Record<string, string>
      devDependencies: Record<string, string>
      overrides: Record<string, unknown>
    }
    expect(packageJson.scripts.mcp).toBe('node src/mcp/run.mjs')
    expect(packageJson.scripts).not.toHaveProperty('mcpb')
    expect(packageJson.devDependencies).not.toHaveProperty('@anthropic-ai/mcpb')
    expect(packageJson.devDependencies).not.toHaveProperty('fflate')
    expect(packageJson.overrides).not.toHaveProperty('@anthropic-ai/mcpb')
  })

  it('REQ-PLUGIN-4 removes manifest.json and src/mcp/pack.mjs, and knip no longer names pack.mjs', () => {
    expect(existsSync(resolve(repoRoot, 'manifest.json'))).toBe(false)
    expect(existsSync(resolve(repoRoot, 'src/mcp/pack.mjs'))).toBe(false)
    const requireFromRoot = createRequire(resolve(repoRoot, 'package.json'))
    const knipSource = read('knip.config.js')
    const knipConfig = requireFromRoot('./knip.config.js') as {
      entry: string[]
    }
    expect(knipSource).not.toContain('pack.mjs')
    expect(knipConfig.entry).toContain('src/mcp/main.ts')
  })
})
