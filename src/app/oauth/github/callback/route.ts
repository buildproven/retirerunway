// GitHub sign-in callback: issues the authorization code to the owner only (REQ-MCP-30, BUI-1857). Logic lives in src/mcp/oauth-server.ts.
import { oauthServer } from '@/mcp/oauth-server'

export function GET(request: Request): Promise<Response> {
  return oauthServer.githubCallback(request)
}
