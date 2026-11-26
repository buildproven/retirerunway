// ---------------------------------------------------------------------------
// RetireRunway – Medicare IRMAA (FR-23, REQ-MCP-44)
//
// The income-related monthly adjustment amounts added to Medicare Part B and
// Part D premiums for higher incomes. Each person on Medicare pays them, set
// by the household's MAGI (AGI plus tax-exempt interest) from the tax return
// two years earlier. Deterministic, no AI.
// ---------------------------------------------------------------------------

import type { FilingStatus } from './tax-brackets'

/** One IRMAA tier: MAGI above `over` (single/joint), monthly surcharges per person. */
export interface IrmaaTier {
  readonly overSingle: number
  readonly overJoint: number
  /** Part B surcharge on top of the standard premium, per month. */
  readonly partB: number
  /** Part D surcharge on top of the plan premium, per month. */
  readonly partD: number
}

export interface IrmaaTable {
  readonly year: number
  readonly source: string
  readonly standardPartB: number
  /** Tiers above the first threshold, lowest first. */
  readonly tiers: readonly IrmaaTier[]
  /** The top tier starts AT these amounts (≥), not above them. */
  readonly topSingle: number
  readonly topJoint: number
}

/**
 * 2027 amounts, from 2025 MAGI (CMS 2027 Medicare Parts A & B premiums and
 * deductibles, Nov 17, 2026). Thresholds below the top tier are indexed to
 * inflation each year, so the projection holds them, and the surcharges,
 * flat in today's dollars. Registered in law-tables.ts (REQ-MCP-84).
 */
export const IRMAA_2027: IrmaaTable = {
  year: 2027,
  source:
    'https://www.cms.gov/newsroom/fact-sheets/2027-medicare-parts-b-premiums-deductibles',
  standardPartB: 209.4,
  tiers: [
    { overSingle: 112_000, overJoint: 224_000, partB: 83.7, partD: 15.4 },
    { overSingle: 141_000, overJoint: 282_000, partB: 209.4, partD: 39.7 },
    { overSingle: 177_000, overJoint: 354_000, partB: 335.0, partD: 64.0 },
    { overSingle: 212_000, overJoint: 424_000, partB: 460.6, partD: 88.3 },
    { overSingle: 500_000, overJoint: 750_000, partB: 502.4, partD: 96.4 },
  ],
  topSingle: 500_000,
  topJoint: 750_000,
}

/**
 * 2026 amounts, from 2024 MAGI (CMS fact sheet, Nov 14, 2025:
 * https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles).
 */
export const IRMAA_2026: IrmaaTable = {
  year: 2026,
  source:
    'https://www.cms.gov/newsroom/fact-sheets/2026-medicare-parts-b-premiums-deductibles',
  standardPartB: 202.9,
  tiers: [
    { overSingle: 109_000, overJoint: 218_000, partB: 81.2, partD: 14.5 },
    { overSingle: 137_000, overJoint: 274_000, partB: 202.9, partD: 37.5 },
    { overSingle: 171_000, overJoint: 342_000, partB: 324.6, partD: 60.4 },
    { overSingle: 205_000, overJoint: 410_000, partB: 446.3, partD: 83.3 },
    { overSingle: 500_000, overJoint: 750_000, partB: 487.0, partD: 91.0 },
  ],
  topSingle: 500_000,
  topJoint: 750_000,
}

export const IRMAA_LOOKBACK_YEARS = 2

export interface IrmaaResult {
  /** 0 = no surcharge; 1–5 = the tier reached. */
  readonly tier: number
  /** Part B + Part D surcharge for one person for a year, today's dollars. */
  readonly annualPerPerson: number
}

/**
 * The IRMAA tier and yearly surcharge per person for a MAGI in today's
 * dollars. Joint thresholds apply to married filing jointly; everyone else
 * uses the individual thresholds (married filing separately is not modelled).
 */
export function irmaaFor(
  magi: number,
  filingStatus: FilingStatus,
  table: IrmaaTable = IRMAA_2027
): IrmaaResult {
  const joint = filingStatus === 'married_filing_jointly'
  const top = joint ? table.topJoint : table.topSingle
  let tier = 0
  table.tiers.forEach((t, i) => {
    const over = joint ? t.overJoint : t.overSingle
    const last = i === table.tiers.length - 1
    if (last ? magi >= top : magi > over) tier = i + 1
  })
  if (tier === 0) return { tier: 0, annualPerPerson: 0 }
  const t = table.tiers.at(tier - 1)
  if (t === undefined) return { tier: 0, annualPerPerson: 0 }
  return {
    tier,
    annualPerPerson: Math.round((t.partB + t.partD) * 12 * 100) / 100,
  }
}

/** The MAGI ceiling (today's dollars) that stays in `tier`; Infinity for the top. */
export function irmaaCeiling(
  tier: number,
  filingStatus: FilingStatus,
  table: IrmaaTable = IRMAA_2027
): number {
  const joint = filingStatus === 'married_filing_jointly'
  const next = table.tiers.at(tier)
  if (next === undefined) return Infinity
  return joint ? next.overJoint : next.overSingle
}
