import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const script = 'scripts/launch-smoke.js'
const { fetchWithTimeout } = require('../launch-smoke.js') as {
  fetchWithTimeout: (
    url: string,
    init?: RequestInit,
    timeoutMs?: number
  ) => Promise<unknown>
}

const pageMarkers: Record<string, string> = {
  '/': 'Know what to do',
  '/features': 'Features',
  '/pricing': 'Simple, Transparent Pricing',
  '/faq': 'Frequently Asked Questions',
  '/about': 'About RetireRunway',
  '/privacy': 'Privacy Policy',
  '/terms': 'Terms of Service',
}

function listen(
  handler: (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse
  ) => void
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('test server did not expose a TCP address'))
        return
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` })
    })
  })
}

function runSmoke(
  baseUrl: string,
  mode?: 'local' | 'preview' | 'production'
): Promise<{ status: number; stdout: string; stderr: string }> {
  const args = [script, '--base-url', baseUrl]
  if (mode) args.push('--mode', mode)
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('close', status =>
      resolve({ status: status ?? 1, stdout, stderr })
    )
  })
}

describe('launch smoke contract', () => {
  it('passes public route and protected API checks', async () => {
    const { server, baseUrl } = await listen((request, response) => {
      if (request.url === '/api/subscription') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end('{"error":"Authentication required"}')
        return
      }
      const marker = pageMarkers[request.url ?? ''] ?? ''
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<html><body>${marker}</body></html>`)
    })

    try {
      const result = await runSmoke(baseUrl, 'preview')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Launch smoke passed')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('fails when a public route is unavailable', async () => {
    const { server, baseUrl } = await listen((request, response) => {
      if (request.url === '/privacy') {
        response.writeHead(404)
        response.end('missing')
        return
      }
      if (request.url === '/api/subscription') {
        response.writeHead(401)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        `<html><body>${pageMarkers[request.url ?? ''] ?? ''}</body></html>`
      )
    })

    try {
      const result = await runSmoke(baseUrl, 'preview')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('/privacy: expected 200, received 404')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects unavailable authentication for a deployed mode', async () => {
    const { server, baseUrl } = await listen((request, response) => {
      if (request.url === '/api/subscription') {
        response.writeHead(503)
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        `<html><body>${pageMarkers[request.url ?? ''] ?? ''}</body></html>`
      )
    })

    try {
      const result = await runSmoke(baseUrl, 'preview')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        '/api/subscription: expected 401, received 503'
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects a local 503 that is not the missing-auth response', async () => {
    const { server, baseUrl } = await listen((request, response) => {
      if (request.url === '/api/subscription') {
        response.writeHead(503)
        response.end('upstream unavailable')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        `<html><body>${pageMarkers[request.url ?? ''] ?? ''}</body></html>`
      )
    })

    try {
      const result = await runSmoke(baseUrl)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(
        '/api/subscription: 503 did not identify missing authentication configuration'
      )
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects redirects instead of following them', async () => {
    const { server, baseUrl } = await listen((request, response) => {
      if (request.url === '/api/subscription') {
        response.writeHead(401)
        response.end()
        return
      }
      if (request.url === '/features') {
        response.writeHead(302, { location: '/faq' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(
        `<html><body>${pageMarkers[request.url ?? ''] ?? ''}</body></html>`
      )
    })

    try {
      const result = await runSmoke(baseUrl)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('/features: expected 200, received 302')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('keeps the timeout active while reading a response body', async () => {
    const { server, baseUrl } = await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('partial response')
    })

    try {
      await expect(fetchWithTimeout(`${baseUrl}/`, {}, 20)).rejects.toThrow()
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
