// knip.config.js — Dead code detection
// Docs: https://knip.dev/overview/configuration
module.exports = {
  // Next.js routes are the application entry points. The old src/index entry
  // never existed, so Knip treated the entire application as unreachable.
  entry: [
    'src/app/**/page.tsx',
    'src/app/**/route.ts',
    'tests/**/*.{test,spec}.{ts,tsx,js,jsx}',
    'scripts/**/*.{js,mjs,cjs}',
    'skills/**/*.{js,mjs,cjs}',
    'eslint-security.config.js',
    // The MCP server. Knip reaches run.mjs through the package.json mcp
    // script, but run.mjs hands main.ts to esbuild by path, not by import.
    'src/mcp/main.ts',
  ],
  project: [
    'src/**/*.{ts,tsx,js,jsx}',
    'tests/**/*.{ts,tsx,js,jsx}',
    'scripts/**/*.{js,mjs,cjs}',
    'skills/**/*.{js,mjs,cjs}',
  ],
  // These packages are imported from CSS, which Knip does not trace.
  ignoreDependencies: ['tailwindcss', 'tw-animate-css'],
  // The shell subcommand in .husky/pre-push is `npm audit`, not a binary
  // dependency named audit.
  ignoreBinaries: ['audit'],
  // Barrel exports are public module APIs. Check them separately with the
  // advisory dead-code:exports command; do not treat external consumers as
  // dead code in the release gate.
  include: ['files', 'dependencies', 'devDependencies', 'unlisted', 'binaries'],
}
