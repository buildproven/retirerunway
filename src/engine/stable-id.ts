// Deterministic 128-bit-width fingerprint for content-derived domain IDs.
// This is not a cryptographic hash. It provides a stable, dependency-free
// identifier for browser and server engine code while avoiding the 32-bit
// collision surface of the previous CSV ID implementation.

const FNV_PRIME = 16777619
const LANE_SEEDS = [2166136261, 2246822519, 3266489917, 668265263]

export function stableId(content: string): string {
  return LANE_SEEDS.map((seed, lane) => {
    let hash = seed

    for (let index = 0; index < content.length; index++) {
      hash ^= content.charCodeAt(index) + lane
      hash = Math.imul(hash, FNV_PRIME)
    }

    return (hash >>> 0).toString(16).padStart(8, '0')
  }).join('')
}
