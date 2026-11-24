/**
 * SSRF Protection
 *
 * Comprehensive Server-Side Request Forgery protection with:
 * - DNS resolution to IP validation
 * - Private IP range blocking
 * - Port filtering (only 80/443 allowed)
 * - Domain blocklist support
 * - AWS/GCP/Azure metadata endpoint blocking
 *
 * Ported from saas-starter-kit for cross-project security standards.
 */

import type { LookupFunction } from 'node:net'

export interface SSRFValidationResult {
  allowed: boolean
  error?: string
  ip?: string
  ips?: string[]
  port?: number
}

/**
 * The DNS lookups `validateUrl` needs. `dns.promises` satisfies it; tests pass
 * a fake so no real DNS is used.
 */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted)
    return Promise.reject(new Error('URL validation aborted.'))

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('URL validation aborted.'))
    const cleanup = () => signal.removeEventListener('abort', abort)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        cleanup()
        resolve(value)
      },
      error => {
        cleanup()
        reject(error)
      }
    )
  })
}

// Address ranges that are not public unicast (RFC 6890 special-purpose
// registries): a resolved host in any of them is refused.
const BLOCKED_IPV4: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // 0.0.0.0/8 "this network", including 0.0.0.0
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 carrier-grade NAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved, including broadcast
]

function ipv4Value(ip: string): number | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

function isBlockedIPv4(value: number): boolean {
  return BLOCKED_IPV4.some(([base, bits]) => {
    const size = 2 ** (32 - bits)
    return Math.floor(value / size) === Math.floor(base / size)
  })
}

/** The eight 16-bit groups of an IPv6 address, or undefined if it is not one. */
function ipv6Groups(ip: string): number[] | undefined {
  let text = ip.toLowerCase()
  const zone = text.indexOf('%')
  if (zone !== -1) text = text.slice(0, zone)
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const tail: number[] = []
  const lastColon = text.lastIndexOf(':')
  if (lastColon !== -1 && text.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4Value(text.slice(lastColon + 1))
    if (v4 === undefined) return undefined
    tail.push(Math.floor(v4 / 0x10000), v4 % 0x10000)
    // Drop the dotted tail; keep a `::` that ends right before it.
    text = text.slice(0, lastColon + 1)
    if (!text.endsWith('::')) text = text.slice(0, -1)
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (half: string): number[] | undefined => {
    if (half === '') return []
    const groups: number[] = []
    for (const group of half.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined
      groups.push(parseInt(group, 16))
    }
    return groups
  }
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  if (head === undefined || rest === undefined) return undefined
  const known = head.length + rest.length + tail.length
  if (halves.length === 2) {
    if (known > 7) return undefined
    return [...head, ...Array<number>(8 - known).fill(0), ...rest, ...tail]
  }
  return known === 8 ? [...head, ...tail] : undefined
}

function isBlockedIPv6(groups: readonly number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0] = groups
  // ::/8 is IETF-reserved: it holds :: (unspecified), ::1 (loopback), and the
  // IPv4-compatible, IPv4-mapped (::ffff:0:0/96) and IPv4-translated
  // (::ffff:0:0:0/96) forms. None is a public IPv6 address.
  if ((g0 & 0xff00) === 0) return true
  // 64:ff9b::/32 covers NAT64 well-known (64:ff9b::/96) and local-use
  // (64:ff9b:1::/48) prefixes.
  if (g0 === 0x64 && g1 === 0xff9b) return true
  if (g0 === 0x2002) return isBlockedIPv4(g1 * 0x10000 + g2) // 6to4
  if (g0 === 0x2001 && g1 === 0) return true // 2001::/32 Teredo
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xff80) === 0xfe80) return true // fe80::/10 link-local, fec0::/10 site-local
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/**
 * True unless `ip` is a public unicast IPv4 or IPv6 address. A value that is
 * not an IP address is treated as non-public, so the check fails closed.
 */
function isNonPublicAddress(ip: string): boolean {
  const v4 = ipv4Value(ip)
  if (v4 !== undefined) return isBlockedIPv4(v4)
  const groups = ipv6Groups(ip)
  if (groups !== undefined) return isBlockedIPv6(groups)
  return true
}

/** The address a checked host resolved to, for `fetchPinned`. */
export interface PinnedAddress {
  readonly address: string
  readonly family: 4 | 6
}

/** The pin for an address `validateUrl` allowed. */
export function pinOf(address: string): PinnedAddress {
  return { address, family: address.includes(':') ? 6 : 4 }
}

/**
 * GETs `url` with its host pinned to `pin`, the address `validateUrl`
 * checked. The connection goes to that address with no second DNS lookup,
 * so a rebinding DNS answer cannot move it to an internal host; TLS still
 * checks the certificate for the URL's host name. Redirects are not
 * followed. The call rejects when the body exceeds `maxBytes`.
 */
export async function fetchPinned(
  url: string,
  pin: PinnedAddress,
  init: {
    readonly headers?: HeadersInit
    readonly signal?: AbortSignal | null
    readonly maxBytes: number
  }
): Promise<Response> {
  const target = new URL(url)
  const transport =
    target.protocol === 'https:'
      ? await import('node:https')
      : target.protocol === 'http:'
        ? await import('node:http')
        : undefined
  if (transport === undefined) {
    throw new Error('Only HTTP/HTTPS URLs are allowed')
  }
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pin.address, family: pin.family }])
    } else {
      callback(null, pin.address, pin.family)
    }
  }
  return new Promise<Response>((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        lookup,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      response => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > init.maxBytes) {
            // Once a response has begun, destroying the request emits no
            // error, so the call is rejected here.
            reject(new Error('The response body is too large'))
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => {
          if (size > init.maxBytes) return
          const headers = new Headers()
          for (const [name, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : [value]) {
              if (item !== undefined) headers.append(name, item)
            }
          }
          const status = response.statusCode ?? 502
          const empty = status === 204 || status === 205 || status === 304
          resolve(
            new Response(empty ? null : Buffer.concat(chunks), {
              status,
              headers,
            })
          )
        })
      }
    )
    request.on('error', reject)
    request.end()
  })
}

class SSRFProtection {
  private readonly ALLOWED_PORTS = [80, 443]

  private readonly DOMAIN_BLOCKLIST = [
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.goog',
    'metadata.google.com',
    '10.96.0.1',
    'kubernetes.default.svc.cluster.local',
    'host.docker.internal',
    'localhost',
    'localhost.localdomain',
    'broadcasthost',
    ...(process.env.SSRF_BLOCKED_DOMAINS?.split(',').map(d => d.trim()) || []),
  ]

  private isPrivateIP(ip: string): boolean {
    return isNonPublicAddress(ip)
  }

  private isAllowedPort(port: number): boolean {
    return this.ALLOWED_PORTS.includes(port)
  }

  private isDomainBlocked(hostname: string): boolean {
    const lowercaseHostname = hostname.toLowerCase()
    return this.DOMAIN_BLOCKLIST.some(blocked => {
      const lowercaseBlocked = blocked.toLowerCase()
      if (lowercaseHostname === lowercaseBlocked) return true
      if (lowercaseHostname.endsWith('.' + lowercaseBlocked)) return true
      return false
    })
  }

  async validateUrl(
    url: string,
    signal?: AbortSignal,
    resolver?: DnsResolver
  ): Promise<SSRFValidationResult> {
    try {
      const parsedUrl = new URL(url)

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { allowed: false, error: 'Only HTTP/HTTPS URLs are allowed' }
      }

      const hostname = parsedUrl.hostname.toLowerCase()

      if (this.isDomainBlocked(hostname)) {
        return { allowed: false, error: 'Domain is blocked' }
      }

      const port = parsedUrl.port
        ? parseInt(parsedUrl.port)
        : parsedUrl.protocol === 'https:'
          ? 443
          : 80

      if (!this.isAllowedPort(port)) {
        return {
          allowed: false,
          error: `Port ${port} is not allowed. Only ports 80 and 443 are permitted.`,
          port,
        }
      }

      const dns: DnsResolver =
        resolver ?? (await import('dns').then(m => m.promises))
      const [ipv4Result, ipv6Result] = await Promise.all([
        abortable(
          dns.resolve4(hostname).catch(() => [] as string[]),
          signal
        ),
        abortable(
          dns.resolve6(hostname).catch(() => [] as string[]),
          signal
        ),
      ])
      const resolvedIPs = [...ipv4Result, ...ipv6Result]
      if (resolvedIPs.length === 0)
        return { allowed: false, error: 'DNS resolution failed' }

      for (const ip of resolvedIPs) {
        if (this.isPrivateIP(ip)) {
          return {
            allowed: false,
            error: `Domain resolves to private/internal IP address: ${ip}`,
            ip,
          }
        }
      }

      if (hostname.includes('..') || hostname.includes('%')) {
        return { allowed: false, error: 'Suspicious hostname pattern detected' }
      }

      return { allowed: true, ip: resolvedIPs[0], ips: resolvedIPs, port }
    } catch (error) {
      if (signal?.aborted) throw error
      return { allowed: false, error: 'Invalid URL format' }
    }
  }

  getClientIP(request: Request): string {
    const trustProxy = process.env.NEXT_TRUST_PROXY === 'true'

    if (trustProxy) {
      const cfConnectingIp = request.headers.get('cf-connecting-ip')
      if (cfConnectingIp) return cfConnectingIp.trim()

      const xRealIp = request.headers.get('x-real-ip')
      if (xRealIp) return xRealIp.trim()

      const xForwardedFor = request.headers.get('x-forwarded-for')
      if (xForwardedFor) return xForwardedFor.split(',')[0].trim()
    }

    return process.env.NODE_ENV === 'development' ? '127.0.0.1' : 'unknown'
  }
}

export const ssrfProtection = new SSRFProtection()
