import { createHash } from 'node:crypto'

export type ProvenanceStamp = {
  tool: string
  version: string
  inputHash: string
  outputHash: string
  seed?: number
  assumptions: Record<string, unknown>
  timestamp: string
}

const ENGINE_VERSION = '0.1.0'

// Recursively sort object keys so canonicalize() produces the same string
// regardless of key insertion order at any depth. Arrays preserve order,
// primitives pass through.
const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') {
    // Reject non-plain objects (Date, Map, Set, etc.) — their Object.keys()
    // yields empty, so they'd canonicalize to {} and silently collide.
    // Engine portfolio/profile types are plain JSON, so this should never
    // happen; if it does we want a loud error, not a silent hash collision.
    const proto = Object.getPrototypeOf(v)
    if (proto !== null && proto !== Object.prototype) {
      throw new Error(
        `provenance: cannot canonicalize non-plain object (${proto?.constructor?.name ?? 'unknown'}). ` +
          `Serialize to a plain object before hashing.`
      )
    }
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map(k => [k, sortKeys((v as Record<string, unknown>)[k])])
    )
  }
  return v
}

const canonicalize = (v: unknown): string => JSON.stringify(sortKeys(v))

const sha256 = (v: unknown): string =>
  'sha256:' + createHash('sha256').update(canonicalize(v)).digest('hex')

export const stamp = (
  tool: string,
  input: unknown,
  output: unknown,
  extras: { seed?: number; assumptions?: Record<string, unknown> } = {}
): ProvenanceStamp => ({
  tool,
  version: ENGINE_VERSION,
  inputHash: sha256(input),
  outputHash: sha256(output),
  seed: extras.seed,
  assumptions: extras.assumptions ?? {},
  timestamp: new Date().toISOString(),
})

export const readJson = async <T>(path: string): Promise<T> => {
  const fs = await import('node:fs/promises')
  const raw = await fs.readFile(path, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`readJson: failed to parse ${path}: ${msg}`)
  }
}

export const readText = async (path: string): Promise<string> => {
  const fs = await import('node:fs/promises')
  return fs.readFile(path, 'utf8')
}

export const writeJson = (value: unknown): void => {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

// Validates that a value is a non-null, non-array plain object — used by
// skill scripts to guard against malformed JSON input (arrays, primitives).
export const assertPlainObject = (v: unknown, context: string): void => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    console.error(
      `error: ${context} must be a JSON object (got ${Array.isArray(v) ? 'array' : typeof v})`
    )
    process.exit(1)
  }
}

// Derives a deterministic portfolio ID from content. 128 bits of entropy
// (32 hex chars) to stay collision-safe if this ID is ever used as a primary
// key. Birthday bound ~2^64 = 1.8e19 items before ~1% collision risk.
export const contentHashId = (prefix: string, content: string): string =>
  prefix + '-' + createHash('sha256').update(content).digest('hex').slice(0, 32)
