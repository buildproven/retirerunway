// Token endpoint (form-urlencoded): code + PKCE and refresh grants (REQ-MCP-29, BUI-1857). Logic lives in src/mcp/oauth-server.ts.
import { oauthServer } from '@/mcp/oauth-server'

export function POST(request: Request): Promise<Response> {
  return oauthServer.token(request)
}

export function OPTIONS(): Response {
  return oauthServer.preflight()
}
