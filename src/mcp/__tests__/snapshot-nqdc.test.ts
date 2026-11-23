// @vitest-environment node
// BUI-1940 (FR-23): a snapshot saved before NQDC support, with the
// non-qualified deferred compensation plan as `brokerage`, reads back as
// `nqdc` without a new import or a rewrite. A BrokerageLink window saved as
// `brokerage` reads as `401k`. Other saved types are kept.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Account, AccountType, Portfolio } from '@/engine/types'
import {
  UserStore,
  fileText,
  parseSnapshotText,
  snapshotFile,
  snapshotPortfolio,
} from '../user-store'

const AS_OF = '2026-11-15'
const NQDC_NAME = 'NON-QUALIFIED DEFERRED COMPENSATION PLAN - EXAMPLE CO'

function account(id: string, name: string, accountType: AccountType): Account {
  return {
    id,
    name,
    institution: 'Fidelity',
    accountType,
    cds: [],
    cashBalance: 0,
    holdings: [
      {
        id: `${id}-h`,
        symbol: 'FXAIX',
        name: 'FIDELITY 500 INDEX FUND',
        assetClass: 'us_equity',
        shares: 10,
        costBasis: 900,
        currentPrice: 100,
        currentValue: 1000,
      },
    ],
  }
}

// The types the 2026-11-15 import saved, before BUI-1940.
function legacySnapshot(): Portfolio {
  return snapshotPortfolio(
    {
      name: 'Imported Portfolio',
      accounts: [
        account('nqdc', NQDC_NAME, 'brokerage'),
        account('joint', 'Joint WROS - TOD', 'brokerage'),
        // A Fidelity BrokerageLink window sits inside the 401(k).
        account('blink', 'BrokerageLink', 'brokerage'),
        // A type the user chose is kept even when the name says otherwise.
        account('manual', 'Hiram brokerage IRA', 'brokerage'),
        account('roth', 'Deferred compensation Roth IRA', 'roth_ira'),
      ],
    },
    AS_OF
  )
}

function types(portfolio: Portfolio): Record<string, AccountType> {
  return Object.fromEntries(
    portfolio.accounts.map(a => [a.name, a.accountType])
  )
}

const EXPECTED: Record<string, AccountType> = {
  [NQDC_NAME]: 'nqdc',
  'Joint WROS - TOD': 'brokerage',
  BrokerageLink: '401k',
  'Hiram brokerage IRA': 'brokerage',
  'Deferred compensation Roth IRA': 'roth_ira',
}

describe('FR-23 BUI-1940 saved snapshots read NQDC accounts as nqdc', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rr-nqdc-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('FR-23 reads a local snapshot saved with the NQDC account as brokerage as nqdc', async () => {
    const store = new UserStore(dir)
    await store.saveSnapshot(legacySnapshot())
    const path = join(dir, snapshotFile(legacySnapshot()).file)
    const before = readFileSync(path, 'utf8')

    const newest = await store.newestSnapshot()
    expect(newest && types(newest.portfolio)).toEqual(EXPECTED)
    const [listed] = await store.listSnapshots()
    expect(types(listed.portfolio)).toEqual(EXPECTED)

    // The read does not write the snapshot back.
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(before).not.toContain('"nqdc"')
  })

  it('FR-23 re-derives the type in snapshot text read from the GitHub store', () => {
    const text = fileText(snapshotFile(legacySnapshot()).value)
    expect(types(parseSnapshotText(text, AS_OF).portfolio)).toEqual(EXPECTED)
  })

  it('FR-23 saves and reads back a snapshot that holds an nqdc account', async () => {
    const store = new UserStore(dir)
    const current = snapshotPortfolio(
      { name: 'Imported', accounts: [account('n', 'Example NQDC', 'nqdc')] },
      AS_OF
    )
    await store.saveSnapshot(current)
    const newest = await store.newestSnapshot()
    expect(newest?.portfolio.accounts[0].accountType).toBe('nqdc')
  })
})
