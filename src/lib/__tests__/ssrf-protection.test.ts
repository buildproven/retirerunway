import { beforeEach, describe, expect, it, vi } from 'vitest'

const dnsMock = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
}))

vi.mock('dns', () => ({ promises: dnsMock, default: { promises: dnsMock } }))

import { ssrfProtection } from '@/lib/ssrf-protection'

function resolves(v4: string[], v6: string[] = []) {
  dnsMock.resolve4.mockResolvedValue(v4)
  dnsMock.resolve6.mockResolvedValue(v6)
}

describe('SSRF protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    resolves(['93.184.216.34'])
  })

  it('allows a public https host and reports resolved addresses', async () => {
    const result = await ssrfProtection.validateUrl('https://example.com/a')
    expect(result).toEqual({
      allowed: true,
      ip: '93.184.216.34',
      ips: ['93.184.216.34'],
      port: 443,
    })
  })

  it('defaults http to port 80 and honours explicit allowed ports', async () => {
    expect((await ssrfProtection.validateUrl('http://example.com')).port).toBe(
      80
    )
    expect(
      (await ssrfProtection.validateUrl('https://example.com:443')).allowed
    ).toBe(true)
  })

  it('rejects non-http protocols and malformed URLs', async () => {
    expect(await ssrfProtection.validateUrl('ftp://example.com')).toEqual({
      allowed: false,
      error: 'Only HTTP/HTTPS URLs are allowed',
    })
    expect(await ssrfProtection.validateUrl('not a url')).toEqual({
      allowed: false,
      error: 'Invalid URL format',
    })
  })

  it.each([
    'http://localhost/x',
    'https://169.254.169.254/latest',
    'https://api.metadata.google.internal/',
  ])('rejects blocklisted host %s before any DNS lookup', async url => {
    const result = await ssrfProtection.validateUrl(url)
    expect(result).toEqual({ allowed: false, error: 'Domain is blocked' })
    expect(dnsMock.resolve4).not.toHaveBeenCalled()
  })

  it('rejects ports other than 80 and 443', async () => {
    const result = await ssrfProtection.validateUrl('https://example.com:8080')
    expect(result.allowed).toBe(false)
    expect(result.port).toBe(8080)
    expect(result.error).toContain('Port 8080')
  })

  it('fails closed when DNS returns nothing', async () => {
    resolves([])
    expect(await ssrfProtection.validateUrl('https://nowhere.test')).toEqual({
      allowed: false,
      error: 'DNS resolution failed',
    })
  })

  it('treats DNS errors as unresolved', async () => {
    dnsMock.resolve4.mockRejectedValue(new Error('ENOTFOUND'))
    dnsMock.resolve6.mockRejectedValue(new Error('ENOTFOUND'))
    const result = await ssrfProtection.validateUrl('https://nowhere.test')
    expect(result.error).toBe('DNS resolution failed')
  })

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '192.168.1.5',
    '172.16.0.1',
    '172.31.255.1',
    '169.254.10.10',
    '0.0.0.0',
    '100.64.0.9',
    '::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    '::ffff:7f00:1',
  ])('rejects a host that resolves to private address %s', async ip => {
    resolves(ip.includes(':') ? [] : [ip], ip.includes(':') ? [ip] : [])
    const result = await ssrfProtection.validateUrl('https://rebind.test')
    expect(result.allowed).toBe(false)
    expect(result.ip).toBe(ip)
    expect(result.error).toContain('private/internal')
  })

  it('rejects if any one of several addresses is private', async () => {
    resolves(['93.184.216.34', '10.0.0.8'])
    expect((await ssrfProtection.validateUrl('https://mixed.test')).ip).toBe(
      '10.0.0.8'
    )
  })

  it('allows 172.32.x which is outside the private range', async () => {
    resolves(['172.32.0.1'])
    expect(
      (await ssrfProtection.validateUrl('https://edge.test')).allowed
    ).toBe(true)
  })

  it('rejects when the signal is already aborted and rethrows', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      ssrfProtection.validateUrl('https://example.com', controller.signal)
    ).rejects.toThrow('URL validation aborted.')
  })

  it('rejects when the signal aborts during DNS lookup', async () => {
    const controller = new AbortController()
    dnsMock.resolve4.mockReturnValue(new Promise(() => undefined))
    dnsMock.resolve6.mockReturnValue(new Promise(() => undefined))
    const pending = ssrfProtection.validateUrl(
      'https://slow.test',
      controller.signal
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort()
    await expect(pending).rejects.toThrow('URL validation aborted.')
  })

  it('passes a live signal through to a successful lookup', async () => {
    const controller = new AbortController()
    const result = await ssrfProtection.validateUrl(
      'https://example.com',
      controller.signal
    )
    expect(result.allowed).toBe(true)
  })

  describe('getClientIP', () => {
    const req = (headers: Record<string, string>) =>
      new Request('http://x.test', { headers })

    it('ignores forwarding headers unless the proxy is trusted', () => {
      vi.stubEnv('NODE_ENV', 'production')
      expect(
        ssrfProtection.getClientIP(req({ 'x-forwarded-for': '1.2.3.4' }))
      ).toBe('unknown')
      vi.stubEnv('NODE_ENV', 'development')
      expect(ssrfProtection.getClientIP(req({}))).toBe('127.0.0.1')
    })

    it('prefers cf-connecting-ip, then x-real-ip, then x-forwarded-for', () => {
      vi.stubEnv('NEXT_TRUST_PROXY', 'true')
      expect(
        ssrfProtection.getClientIP(
          req({
            'cf-connecting-ip': ' 1.1.1.1 ',
            'x-real-ip': '2.2.2.2',
            'x-forwarded-for': '3.3.3.3',
          })
        )
      ).toBe('1.1.1.1')
      expect(
        ssrfProtection.getClientIP(
          req({ 'x-real-ip': '2.2.2.2', 'x-forwarded-for': '3.3.3.3' })
        )
      ).toBe('2.2.2.2')
      expect(
        ssrfProtection.getClientIP(
          req({ 'x-forwarded-for': '3.3.3.3, 4.4.4.4' })
        )
      ).toBe('3.3.3.3')
    })

    it('falls back when trusted but no header is present', () => {
      vi.stubEnv('NEXT_TRUST_PROXY', 'true')
      vi.stubEnv('NODE_ENV', 'production')
      expect(ssrfProtection.getClientIP(req({}))).toBe('unknown')
    })
  })
})
