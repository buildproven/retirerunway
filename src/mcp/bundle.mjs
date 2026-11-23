// Builds the plan MCP server bundle and publishes it atomically. esbuild
// writes the bundle to memory; it then goes to a temporary file unique to
// this call and is renamed over the target. A rename on one filesystem is
// atomic, so a server that starts while another rebuilds imports either the
// old complete bundle or the new one, never a half-written file.
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { build } from 'esbuild'

/**
 * The file operations the publish step uses.
 * @typedef {{
 *   mkdir(path: string, options: { recursive: true }): Promise<unknown>,
 *   writeFile(path: string, data: Uint8Array): Promise<void>,
 *   rename(from: string, to: string): Promise<void>,
 *   rm(path: string, options: { force: true }): Promise<void>,
 * }} BundleFs
 */

/** @type {BundleFs} */
const defaultFs = { mkdir, rename, rm, writeFile }

/**
 * @param {{ entry: string, outfile: string, fs?: BundleFs }} options
 * @returns {Promise<void>}
 */
export async function bundleServer({ entry, outfile, fs = defaultFs }) {
  const result = await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    packages: 'external',
    logLevel: 'error',
    write: false,
  })
  if (result.outputFiles.length !== 1) {
    throw new Error(
      `MCP bundle: expected one output file, got ${result.outputFiles.length}`
    )
  }
  await fs.mkdir(dirname(outfile), { recursive: true })
  const temporary = `${outfile}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, result.outputFiles[0].contents)
    await fs.rename(temporary, outfile)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}
