// RFC 9728 protected resource metadata for the hosted MCP entry
// (REQ-MCP-23, BUI-1856). The 401 challenge from /api/mcp points here; the
// client reads which authorization server to sign in with.
import { readIssuer, resourceUrls } from '@/mcp/http-auth'

export function GET(request: Request): Response {
  const issuer = readIssuer()
  if (!issuer.ok) return issuer.response
  return Response.json({
    resource: resourceUrls(request).mcpUrl,
    authorization_servers: [issuer.value],
    bearer_methods_supported: ['header'],
    resource_name: 'Retire Runway',
  })
}
