// Public signing keys the resource server verifies access tokens with (REQ-MCP-29, BUI-1857). Logic lives in src/mcp/oauth-server.ts.
import { oauthServer } from '@/mcp/oauth-server'

export function GET(request: Request): Promise<Response> {
  return oauthServer.jwks(request)
}

export function OPTIONS(): Response {
  return oauthServer.preflight()
}
