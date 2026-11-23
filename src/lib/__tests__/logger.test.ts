import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger, sanitize, setRequestId, getRequestId } from '../logger'

describe('logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setRequestId(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('sanitize', () => {
    it('sanitizes email addresses', () => {
      const input = { email: 'user@example.com' }
      const result = sanitize(input) as typeof input
      expect(result.email).toBe('***@***.***')
    })

    it('sanitizes phone numbers with separators', () => {
      const inputs = ['555-123-4567', '(555) 123-4567', '+1 555 123 4567']
      inputs.forEach(phone => {
        const result = sanitize({ phone }) as { phone: string }
        expect(result.phone).toBe('***-***-****')
      })
    })

    it('sanitizes continuous digit strings as account numbers', () => {
      const result = sanitize({ phone: '5551234567' }) as { phone: string }
      expect(result.phone).toBe('****4567')
    })

    it('sanitizes SSN patterns', () => {
      const inputs = ['123-45-6789', '123.45.6789', '123 45 6789']
      inputs.forEach(ssn => {
        const result = sanitize({ ssn }) as { ssn: string }
        expect(result.ssn).toBe('***-**-****')
      })
    })

    it('sanitizes account numbers (keeps last 4 digits)', () => {
      const input = { account: '12345678901234' }
      const result = sanitize(input) as typeof input
      expect(result.account).toBe('****1234')
    })

    it('sanitizes credit card numbers', () => {
      const inputs = [
        '4111-1111-1111-1111',
        '4111 1111 1111 1111',
        '4111111111111111',
      ]
      inputs.forEach(card => {
        const result = sanitize({ card }) as { card: string }
        expect(result.card).toBe('****-****-****-****')
      })
    })

    it('redacts sensitive field names', () => {
      const input = {
        password: 'secret123',
        apiKey: 'sk-12345',
        api_key: 'ak-67890',
        token: 'tok_abc',
        secret: 'shh',
      }
      const result = sanitize(input) as Record<string, string>
      expect(result.password).toBe('[REDACTED]')
      expect(result.apiKey).toBe('[REDACTED]')
      expect(result.api_key).toBe('[REDACTED]')
      expect(result.token).toBe('[REDACTED]')
      expect(result.secret).toBe('[REDACTED]')
    })

    it('handles nested objects', () => {
      const input = {
        user: {
          email: 'test@example.com',
          profile: {
            phone: '555-123-4567',
          },
        },
      }
      const result = sanitize(input) as typeof input
      expect(result.user.email).toBe('***@***.***')
      expect(result.user.profile.phone).toBe('***-***-****')
    })

    it('handles arrays', () => {
      const input = ['user1@test.com', 'user2@test.com']
      const result = sanitize(input) as string[]
      expect(result).toEqual(['***@***.***', '***@***.***'])
    })

    it('preserves non-sensitive data', () => {
      const input = {
        portfolioValue: 1500000,
        name: 'Retirement Portfolio',
        isActive: true,
      }
      const result = sanitize(input) as typeof input
      expect(result.portfolioValue).toBe(1500000)
      expect(result.name).toBe('Retirement Portfolio')
      expect(result.isActive).toBe(true)
    })

    it('handles null and undefined', () => {
      expect(sanitize(null)).toBe(null)
      expect(sanitize(undefined)).toBe(undefined)
    })
  })

  describe('request ID tracking', () => {
    it('sets and gets request ID', () => {
      setRequestId('req-123')
      expect(getRequestId()).toBe('req-123')
    })

    it('clears request ID with undefined', () => {
      setRequestId('req-123')
      setRequestId(undefined)
      expect(getRequestId()).toBeUndefined()
    })
  })

  describe('log levels', () => {
    it('debug logs in development', () => {
      logger.debug('test message')
      expect(console.debug).toHaveBeenCalled()
    })

    it('info logs message', () => {
      logger.info('test message')
      expect(console.info).toHaveBeenCalled()
    })

    it('warn logs message', () => {
      logger.warn('test message')
      expect(console.warn).toHaveBeenCalled()
    })

    it('error logs message', () => {
      logger.error('test message')
      expect(console.error).toHaveBeenCalled()
    })

    it('error logs with Error object', () => {
      const error = new Error('test error')
      logger.error('something failed', error)
      expect(console.error).toHaveBeenCalled()
    })

    it('error logs with data object when no Error provided', () => {
      logger.error('something failed', { context: 'test' })
      expect(console.error).toHaveBeenCalled()
    })
  })

  describe('log format', () => {
    it('includes data in log output', () => {
      logger.info('test', { key: 'value' })
      expect(console.info).toHaveBeenCalledWith(
        expect.stringContaining('value')
      )
    })

    it('includes request ID when set', () => {
      setRequestId('req-456')
      logger.info('test message')
      expect(console.info).toHaveBeenCalledWith(
        expect.stringContaining('req-456')
      )
    })

    it('sanitizes data in logs', () => {
      logger.info('user logged in', { email: 'user@test.com' })
      expect(console.info).toHaveBeenCalledWith(
        expect.stringContaining('***@***.***')
      )
      expect(console.info).not.toHaveBeenCalledWith(
        expect.stringContaining('user@test.com')
      )
    })
  })
})
