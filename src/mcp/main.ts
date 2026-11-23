// Stdio entry point for the plan MCP server (REQ-MCP-1). Started by
// `npm run mcp` through src/mcp/run.mjs. Stdout carries only MCP messages.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createPlanServer } from './server'

await createPlanServer().connect(new StdioServerTransport())
