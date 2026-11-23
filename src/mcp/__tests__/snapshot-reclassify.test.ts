// @vitest-environment node
// BUI-1939 (FR-23): a snapshot saved before the asset-class fix reads back
// with each holding re-classified by the current rules, without a rewrite.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AssetClass, Holding, Portfolio } from '@/engine/types'
import {
  UserStore,
  fileText,
  parseSnapshotText,
  snapshotFile,
  snapshotPortfolio,
} from '../user-store'

const AS_OF = '2026-11-15'

function holding(
  symbol: string,
  name: string,
  assetClass: AssetClass
): Holding {
  return {
    id: symbol,
    symbol,
    name,
    assetClass,
    shares: 10,
    costBasis: 900,
    currentPrice: 100,
    currentValue: 1000,
  }
}

// The classes the 2026-11-15 import saved, before BUI-1939.
function legacySnapshot(): Portfolio {
  return snapshotPortfolio(
    {
      name: 'Imported Portfolio',
      accounts: [
        {
          id: 'a',
          name: 'Rollover IRA',
          institution: 'Fidelity',
          accountType: 'rollover_ira',
          cds: [],
          cashBalance: 0,
          holdings: [
            holding(
              'VEA',
              'VANGUARD DEVELOPED MARKETS INDEX FUND ETF',
              'us_equity'
            ),
            holding('PHYQX', 'PGIM HIGH YIELD R6', 'us_equity'),
            holding('VOO', 'VANGUARD S&P 500 ETF', 'us_equity'),
            // No rule matches this name: the saved class is kept.
            holding('ZZPRV', 'Acme Private Holdings', 'reit'),
          ],
        },
      ],
    },
    AS_OF
  )
}

function classes(portfolio: Portfolio): Record<string, AssetClass> {
  return Object.fromEntries(
    portfolio.accounts
      .flatMap(a => a.holdings)
      .map(h => [h.symbol, h.assetClass])
  )
}

const EXPECTED: Record<string, AssetClass> = {
  VEA: 'intl_equity',
  PHYQX: 'us_bond',
  VOO: 'us_equity',
  ZZPRV: 'reit',
}

describe('FR-23 BUI-1939 saved snapshots read back re-classified', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-reclassify-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('FR-23 reads a local snapshot saved with VEA as us_equity as intl_equity', async () => {
    const store = new UserStore(dir)
    await store.saveSnapshot(legacySnapshot())
    const path = join(dir, snapshotFile(legacySnapshot()).file)
    const before = readFileSync(path, 'utf8')

    const newest = await store.newestSnapshot()
    expect(newest && classes(newest.portfolio)).toEqual(EXPECTED)
    const [listed] = await store.listSnapshots()
    expect(classes(listed.portfolio)).toEqual(EXPECTED)

    // The read does not write the snapshot back.
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(before).toContain('"assetClass": "us_equity"')
  })

  it('FR-23 re-classifies snapshot text read from the GitHub store', () => {
    const text = fileText(snapshotFile(legacySnapshot()).value)
    const saved = parseSnapshotText(text, AS_OF)
    expect(classes(saved.portfolio)).toEqual(EXPECTED)
  })

  it('FR-23 keeps every other holding field as saved', () => {
    const text = fileText(snapshotFile(legacySnapshot()).value)
    const saved = parseSnapshotText(text, AS_OF)
    const original = legacySnapshot()
    expect(
      saved.portfolio.accounts[0].holdings.map(h => ({
        ...h,
        assetClass: undefined,
      }))
    ).toEqual(
      original.accounts[0].holdings.map(h => ({ ...h, assetClass: undefined }))
    )
  })
})
