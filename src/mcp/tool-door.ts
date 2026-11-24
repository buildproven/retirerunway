// ---------------------------------------------------------------------------
// RetireRunway – one stable door to every tool (REQ-MCP-73)
//
// Claude loads a connector's tool list (names and input schemas) when a chat
// starts, and the phone and desktop apps can keep it longer; no client
// re-reads it mid-chat. So a tool added in a release, or a field added to a
// schema, is not callable from a chat that is already open.
//
// The fix is a stable surface:
// - recordTools() keeps every registered tool (name, description, schema,
//   handler) in a registry as the server registers it.
// - run_tool calls any tool in the registry by name. Its own schema never
//   changes ({ tool, arguments } with arguments an open object), and the
//   arguments are validated here against the tool's current schema, so a
//   tool or field added later works in a chat opened earlier.
// - toolCatalog() lists every tool with its arguments for get_briefing,
//   which every chat calls first, so the agent learns new tools from a
//   result rather than from the tool list.
// ---------------------------------------------------------------------------

import type { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { errorResult } from './portfolio-tools'

type Handler = (args: Record<string, unknown>, extra: unknown) => unknown

export interface ToolEntry {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: z.ZodObject
  readonly handler: Handler
}

export type ToolRegistry = Map<string, ToolEntry>

/** Tools run_tool will not call: itself, and deletion (always called directly). */
export const DOOR_EXCLUDED: ReadonlySet<string> = new Set([
  'run_tool',
  'delete_user_data',
])

/**
 * Record each tool the server registers from now on. Call before any
 * registerTool; returns the registry the door and the catalog read.
 */
export function recordTools(server: McpServer): ToolRegistry {
  const registry: ToolRegistry = new Map()
  const original = server.registerTool.bind(server) as (
    name: string,
    config: {
      title?: string
      description?: string
      inputSchema?: z.ZodObject
    },
    handler: Handler
  ) => unknown
  const recording = (
    name: string,
    config: { title?: string; description?: string; inputSchema?: z.ZodObject },
    handler: Handler
  ): unknown => {
    registry.set(name, {
      name,
      ...(config.title === undefined ? {} : { title: config.title }),
      description: config.description ?? '',
      inputSchema: config.inputSchema ?? z.strictObject({}),
      handler,
    })
    return original(name, config, handler)
  }
  Object.assign(server, { registerTool: recording })
  return registry
}

export interface CatalogEntry {
  readonly name: string
  /** The first sentence of the tool's description. */
  readonly summary: string
  /** Argument names; required ones end in "*". */
  readonly arguments: readonly string[]
}

function firstSentence(text: string): string {
  const match = text.match(/^(.+?[.!?])(\s|$)/)
  return (match === null ? text : match[1]).slice(0, 240)
}

function isOptional(schema: z.ZodType): boolean {
  return schema.safeParse(undefined).success
}

/** Every tool with a one-line summary and its arguments, sorted by name. */
export function toolCatalog(registry: ToolRegistry): CatalogEntry[] {
  return [...registry.values()]
    .map(entry => ({
      name: entry.name,
      summary: firstSentence(entry.description),
      arguments: Object.entries(entry.inputSchema.shape).map(([key, schema]) =>
        isOptional(schema as z.ZodType) ? key : `${key}*`
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export const runToolInput = z.strictObject({
  tool: z.string().trim().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()).optional(),
})

export function registerToolDoor(
  server: McpServer,
  registry: ToolRegistry
): void {
  server.registerTool(
    'run_tool',
    {
      title: 'Run any RetireRunway tool',
      description:
        "Call any RetireRunway tool by name with its arguments, including tools and fields added after this chat started (Claude keeps the tool list from the start of a chat). get_briefing's tools list names every tool the server has now and its arguments (required ones end in *). Pass tool (the name) and arguments (an object, the tool's own arguments). The arguments are checked against the tool's current schema; a wrong one returns field-level errors naming what to fix. Returns exactly what the tool returns. Use the tool directly when it is in your list. delete_user_data is not available here.",
      inputSchema: runToolInput,
    },
    async ({ tool, arguments: args }, extra) => {
      const entry = registry.get(tool)
      if (entry === undefined || DOOR_EXCLUDED.has(tool)) {
        const names = [...registry.keys()]
          .filter(n => !DOOR_EXCLUDED.has(n))
          .sort()
        return errorResult([
          {
            field: 'tool',
            message: `no tool named "${tool}" can be run here; the tools are: ${names.join(', ')}`,
          },
        ])
      }
      const parsed = entry.inputSchema.safeParse(args ?? {})
      if (!parsed.success) {
        return errorResult(
          parsed.error.issues.map(issue => ({
            field: ['arguments', ...issue.path.map(String)].join('.'),
            message: issue.message,
          }))
        )
      }
      return (await entry.handler(
        parsed.data as Record<string, unknown>,
        extra
      )) as CallToolResult
    }
  )
}
