// ---------------------------------------------------------------------------
// RetireRunway – change saved profile fields without resending the profile
// (REQ-MCP-74)
//
// update_profile takes only what changes: `set` maps dotted paths
// ("planRules.outsideCash", "consumerDebt") to new values and `remove` lists
// paths to drop. Arrays are replaced whole. The merged profile is then
// checked by the same strict schema save_profile uses, so the open shape of
// `set` (which keeps the tool's own schema stable as fields are added) never
// lets an unknown field through. Pure; no I/O.
// ---------------------------------------------------------------------------

export class ProfilePatchError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message)
  }
}

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function segments(path: string, field: string): string[] {
  const parts = path.split('.')
  if (
    parts.some(p => p === '' || FORBIDDEN.has(p) || !/^[A-Za-z0-9_]+$/.test(p))
  )
    throw new ProfilePatchError(
      field,
      `"${path}" is not a field path: use names joined by dots, such as planRules.outsideCash`
    )
  return parts
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Apply `set` then `remove` to a copy of `profile`. Returns the new profile
 * and the paths that changed (a set to the same value is not a change).
 */
export function patchProfile(
  profile: Record<string, unknown>,
  set: Readonly<Record<string, unknown>> = {},
  remove: readonly string[] = []
): { profile: Record<string, unknown>; changed: string[] } {
  const next = clone(profile)
  const changed: string[] = []
  for (const [path, value] of Object.entries(set)) {
    const parts = segments(path, `set.${path}`)
    let node: Record<string, unknown> = next
    for (const [i, key] of parts.slice(0, -1).entries()) {
      const child = node[key]
      if (child === undefined) {
        node[key] = {}
      } else if (!isPlainObject(child)) {
        throw new ProfilePatchError(
          `set.${path}`,
          `${parts.slice(0, i + 1).join('.')} is not an object, so ${path} cannot be set inside it`
        )
      }
      node = node[key] as Record<string, unknown>
    }
    const last = parts[parts.length - 1]
    if (JSON.stringify(node[last]) !== JSON.stringify(value)) changed.push(path)
    node[last] = clone(value)
  }
  for (const path of remove) {
    const parts = segments(path, `remove`)
    let node: unknown = next
    for (const key of parts.slice(0, -1)) {
      node = isPlainObject(node) ? node[key] : undefined
    }
    const last = parts[parts.length - 1]
    if (isPlainObject(node) && last in node) {
      delete node[last]
      changed.push(path)
    }
  }
  return { profile: next, changed }
}
