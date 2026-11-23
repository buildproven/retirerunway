// Authorization endpoint: starts sign-in with GitHub (REQ-MCP-30, BUI-1857). Logic lives in src/mcp/oauth-server.ts.
import { oauthServer } from '@/mcp/oauth-server'

export function GET(request: Request): Promise<Response> {
  return oauthServer.authorize(request)
}
