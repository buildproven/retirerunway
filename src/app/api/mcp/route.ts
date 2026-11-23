// Hosted MCP entry (REQ-MCP-22..26, BUI-1856): the plan server over
// Streamable HTTP, for Claude on the web, desktop and mobile. Every request
// passes the OAuth token check first; only the owner's token reaches a tool.
import { createMcpHandler } from '@modelcontextprotocol/server'
import type {
  McpServer,
  ServerCapabilities,
} from '@modelcontextprotocol/server'
import { authorizeMcpRequest } from '@/mcp/http-auth'
import { createPlanServer } from '@/mcp/server'

/**
 * The capability bits that turn off every change notification (BUI-1944).
 * On serverless functions each request runs in its own instance, so the
 * handler's in-memory event bus has no publisher, and a
 * `subscriptions/listen` stream for an advertised bit would only send
 * keep-alives until the platform kills the function at its time limit. With
 * every bit off, the SDK acknowledges an empty filter and closes the stream
 * at once, and clients that follow the capabilities do not open one.
 */
function noChangeNotifications(
  capabilities: ServerCapabilities
): ServerCapabilities {
  return {
    ...(capabilities.tools && { tools: { listChanged: false } }),
    ...(capabilities.prompts && { prompts: { listChanged: false } }),
    ...(capabilities.resources && {
      resources: { listChanged: false, subscribe: false },
    }),
  }
}

/** The plan server, advertising only what a stateless instance can serve. */
function createHostedServer(): McpServer {
  const server = createPlanServer()
  server.server.registerCapabilities(
    noChangeNotifications(server.server.getCapabilities())
  )
  return server
}

// Stateless: each request gets a fresh server from the same factory the
// stdio entry uses, so both entries serve the same tools.
const handler = createMcpHandler(createHostedServer)

async function handle(request: Request): Promise<Response> {
  const auth = await authorizeMcpRequest(request)
  if (!auth.ok) return auth.response
  return handler.fetch(request, { authInfo: auth.value })
}

export const GET = handle
export const POST = handle
export const DELETE = handle
