// Dynamic client registration (RFC 7591) (REQ-MCP-28, BUI-1857). Logic lives in src/mcp/oauth-server.ts.
import { oauthServer } from '@/mcp/oauth-server'

export function POST(request: Request): Promise<Response> {
  return oauthServer.register(request)
}

export function OPTIONS(): Response {
  return oauthServer.preflight()
}
