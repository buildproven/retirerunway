// BUI-1517 / NFR-01 (Determinism), FR-14 (Portfolio analysis tools):
// alerts must not read the wall clock — same inputs and as-of date give
// byte-identical alerts, and CD maturity is measured from the as-of date.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import type { Portfolio, UserProfile, CD } from '../types'

vi.mock('@/engine/alerts', async importOriginal => {
  const actual = await importOriginal<typeof import('@/engine/alerts')>()
  return { ...actual, generateAlerts: vi.fn(actual.generateAlerts) }
})

import { generateAlerts, isCalendarDate } from '@/engine/alerts'
import { POST } from '@/app/api/v1/analyze/route'

const AS_OF = '2026-03-01'

function makeCD(maturityDate: string, id = 'cd-1'): CD {
  return {
    id,
    institution: 'Ally',
    principal: 50000,
    apy: 0.045,
    termMonths: 12,
    maturityDate,
    purchaseDate: '2025-03-21',
    earlyWithdrawalPenaltyMonths: 3,
  }
}

// Triggers every alert category: equity drift, concentration, cash buffer,
// withdrawal rate and CD maturity.
function makePortfolio(cds: CD[] = [makeCD('2026-03-21')]): Portfolio {
  return {
    id: 'p-1',
    name: 'Determinism portfolio',
    asOfDate: AS_OF,
    accounts: [
      {
        id: 'acc-1',
        name: 'Brokerage',
        institution: 'Fidelity',
        accountType: 'brokerage',
        holdings: [
          {
            id: 'h-1',
            symbol: 'VTI',
            name: 'Vanguard Total Stock',
            assetClass: 'us_equity',
            shares: 1000,
            costBasis: 150000,
            currentPrice: 400,
            currentValue: 400000,
          },
        ],
        cds,
        cashBalance: 1000,
      },
    ],
  }
}

const profile: UserProfile = {
  currentAge: 58,
  targetRetirementAge: 60,
  annualExpenses: 60000,
}

const config = { cdMaturityWindowDays: 90 }

describe('generateAlerts determinism (NFR-01, BUI-1517)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('REQ-ALERT-1: same inputs and as-of date give deep-equal alerts while the clock advances', () => {
    vi.setSystemTime(new Date('2026-03-01T09:00:00.000Z'))
    const first = generateAlerts(makePortfolio(), profile, config, AS_OF)

    vi.setSystemTime(new Date('2026-03-08T17:45:12.345Z'))
    const second = generateAlerts(makePortfolio(), profile, config, AS_OF)

    expect(new Set(first.map(a => a.category))).toEqual(
      new Set([
        'allocation_drift',
        'concentration',
        'cash_buffer',
        'withdrawal_rate',
        'cd_maturity',
      ])
    )
    expect(second).toEqual(first)
  })

  it('REQ-ALERT-1: alert ids are unique within one result', () => {
    const alerts = generateAlerts(
      makePortfolio([
        makeCD('2026-03-21', 'cd-a'),
        makeCD('2026-04-10', 'cd-b'),
      ]),
      profile,
      config,
      AS_OF
    )
    const ids = alerts.map(a => a.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each([
    '2020-01-01T00:00:00.000Z',
    '2026-03-01T23:59:59.999Z',
    '2031-07-15T12:00:00.000Z',
  ])(
    'REQ-ALERT-2: a CD 20 days after the as-of date gives a 20-day alert at system time %s',
    systemTime => {
      vi.setSystemTime(new Date(systemTime))
      const cdAlerts = generateAlerts(
        makePortfolio(),
        profile,
        config,
        AS_OF
      ).filter(a => a.category === 'cd_maturity')

      expect(cdAlerts).toHaveLength(1)
      expect(cdAlerts[0].metric).toBe(20)
      expect(cdAlerts[0].title).toBe('CD maturing in 20 days')
      expect(cdAlerts[0].severity).toBe('warning')
    }
  )

  it('REQ-ALERT-2: the as-of date bounds the window — matured CDs and CDs past the window give no alert', () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const cdAlerts = generateAlerts(
      makePortfolio([
        makeCD('2026-02-28', 'cd-matured'),
        makeCD('2026-03-01', 'cd-today'),
        makeCD('2026-05-30', 'cd-day-90'),
        makeCD('2026-05-31', 'cd-day-91'),
      ]),
      profile,
      config,
      AS_OF
    ).filter(a => a.category === 'cd_maturity')

    expect(cdAlerts.map(a => [a.id, a.metric])).toEqual([
      ['cd-maturity-cd-today', 0],
      ['cd-maturity-cd-day-90', 90],
    ])
  })

  it('REQ-ALERT-2: an invalid as-of date fails loudly instead of dropping CD alerts', () => {
    expect(() =>
      generateAlerts(makePortfolio(), profile, config, '2026-13-45')
    ).toThrow(RangeError)
  })

  it('REQ-ALERT-2: a rolled-over as-of date (2026-02-30) fails loudly instead of meaning March 2', () => {
    expect(() =>
      generateAlerts(makePortfolio(), profile, config, '2026-02-30')
    ).toThrow(RangeError)
  })

  it.each([
    ['2024-02-29', true],
    ['2026-03-01', true],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['2026-13-45', false],
    ['2026-3-1', false],
    ['2026-03-01T00:00:00.000Z', false],
    ['', false],
  ])('isCalendarDate(%j) is %s', (value, expected) => {
    expect(isCalendarDate(value)).toBe(expected)
  })
})

describe('POST /api/v1/analyze alerts as-of date (REQ-ALERT-3, BUI-1517)', () => {
  const originalApiAccessKeys = process.env.API_ACCESS_KEYS

  beforeEach(() => {
    process.env.API_ACCESS_KEYS = 'alerts-determinism-key'
    vi.mocked(generateAlerts).mockClear()
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalApiAccessKeys === undefined) {
      delete process.env.API_ACCESS_KEYS
    } else {
      process.env.API_ACCESS_KEYS = originalApiAccessKeys
    }
  })

  function postAnalyze(portfolio: Portfolio, includeAlerts = true) {
    return POST(
      new NextRequest('http://localhost/api/v1/analyze', {
        method: 'POST',
        headers: { authorization: 'Bearer alerts-determinism-key' },
        body: JSON.stringify({
          portfolio,
          userProfile: profile,
          options: { includeMonteCarlo: false, includeAlerts },
        }),
      })
    )
  }

  async function analyze() {
    const response = await postAnalyze(makePortfolio())
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      alerts: { id: string; category: string; metric?: number }[]
    }
    return body.alerts
  }

  it('REQ-ALERT-3: passes the portfolio as-of date to generateAlerts', async () => {
    vi.setSystemTime(new Date('2031-07-15T12:00:00.000Z'))
    await analyze()

    expect(generateAlerts).toHaveBeenCalledTimes(1)
    expect(vi.mocked(generateAlerts).mock.calls[0][3]).toBe(AS_OF)
  })

  it('REQ-ALERT-3: two requests with the same body return identical alerts as the clock advances', async () => {
    vi.setSystemTime(new Date('2026-03-01T09:00:00.000Z'))
    const first = await analyze()

    vi.setSystemTime(new Date('2027-11-30T21:15:00.000Z'))
    const second = await analyze()

    expect(second).toEqual(first)
    const cdAlert = first.find(a => a.category === 'cd_maturity')
    expect(cdAlert?.metric).toBe(20)
  })

  it.each([
    ['2026-13-45', true],
    ['2026-02-30', true],
    ['2026-13-45', false],
  ])(
    'REQ-ALERT-3: an impossible as-of date %s is a 400 field error, not a 500 (includeAlerts: %s)',
    async (asOfDate, includeAlerts) => {
      const response = await postAnalyze(
        { ...makePortfolio(), asOfDate },
        includeAlerts
      )

      expect(response.status).toBe(400)
      const body = (await response.json()) as {
        error: string
        details: { path: string; code: string }[]
      }
      expect(body.error).toBe('Validation failed')
      expect(body.details).toEqual([
        expect.objectContaining({
          path: 'portfolio.asOfDate',
          code: 'invalid_date',
        }),
      ])
      expect(generateAlerts).not.toHaveBeenCalled()
    }
  )

  it('REQ-ALERT-3: a real leap-day as-of date is accepted', async () => {
    const response = await postAnalyze({
      ...makePortfolio(),
      asOfDate: '2024-02-29',
    })

    expect(response.status).toBe(200)
    expect(vi.mocked(generateAlerts).mock.calls[0][3]).toBe('2024-02-29')
  })
})
