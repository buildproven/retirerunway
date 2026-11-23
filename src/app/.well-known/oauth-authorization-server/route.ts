// RFC 8414 authorization server metadata (REQ-MCP-27, BUI-1857). Logic lives in src/mcp/oauth-server.ts.
import { oauthServer } from '@/mcp/oauth-server'

export function GET(request: Request): Response {
  return oauthServer.metadata(request)
}

export function OPTIONS(): Response {
  return oauthServer.preflight()
}
