// Bundles the plan MCP server with its engine imports, then runs it over
// stdio (REQ-MCP-1). The engine uses extensionless TypeScript imports, so
// Node cannot load src/mcp/main.ts directly. esbuild writes no stdout, so
// the MCP stream stays clean. The bundle goes to node_modules/.cache, which
// git and the linters ignore; bundle.mjs publishes it atomically, so
// overlapping starts never import a half-written bundle.
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { bundleServer } from './bundle.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const outfile = resolve(
  repoRoot,
  'node_modules/.cache/retire-runway-mcp/server.mjs'
)

await bundleServer({ entry: resolve(repoRoot, 'src/mcp/main.ts'), outfile })
await import(pathToFileURL(outfile).href)
