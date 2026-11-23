// MCP tool result helper shared by the plan and portfolio tools.
import type { CallToolResult } from '@modelcontextprotocol/server'

/** A result with the payload as structured content and as JSON text. */
export function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  }
}
