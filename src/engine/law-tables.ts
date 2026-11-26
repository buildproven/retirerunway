/**
 * REQ-MCP-84: the law and benefit figures the engine is built on, each with
 * the year it holds and when the next year's figures are normally published,
 * so a review can say when the engine is behind the law. Pure: the date is
 * an explicit input.
 */

export interface LawTable {
  readonly id: string
  readonly name: string
  /** The tax or benefit year the engine's figures are for. */
  readonly year: number
  readonly source: string
  /**
   * When the next figures come out: 'nextYear' tables for year Y+1 are
   * published in year Y by month/day; 'sameYear' tables for year Y are
   * published in year Y by month/day.
   */
  readonly published: {
    readonly kind: 'nextYear' | 'sameYear'
    readonly month: number
    readonly day: number
  }
  /** Where to find the next figures. */
  readonly where: string
}

export const LAW_TABLES: readonly LawTable[] = [
  {
    id: 'federalTax',
    name: 'Federal tax brackets, standard deduction and capital gains thresholds',
    year: 2027,
    source: 'IRS Rev. Proc. 2026-35 (Nov 5, 2026)',
    published: { kind: 'nextYear', month: 11, day: 15 },
    where: "the IRS newsroom release of next year's inflation adjustments",
  },
  {
    id: 'irmaa',
    name: 'Medicare Part B premium and IRMAA tiers',
    year: 2027,
    source: 'CMS 2027 Medicare Parts A & B premiums fact sheet (Nov 17, 2026)',
    published: { kind: 'nextYear', month: 11, day: 30 },
    where: "the CMS fact sheet on next year's Part A and B premiums",
  },
  {
    id: 'acaApplicablePercentage',
    name: 'ACA premium credit applicable percentages',
    year: 2027,
    source: 'IRS Rev. Proc. 2026-26',
    published: { kind: 'nextYear', month: 9, day: 1 },
    where: 'the IRS revenue procedure on applicable percentages',
  },
  {
    id: 'povertyLine',
    name: 'HHS poverty guidelines (the ACA credit line)',
    year: 2026,
    source: 'HHS poverty guidelines for 2026',
    published: { kind: 'sameYear', month: 2, day: 15 },
    where: 'the HHS ASPE poverty guidelines page',
  },
  {
    id: 'socialSecurityTrustees',
    name: 'Social Security Trustees Report (benefit cut and its year)',
    year: 2026,
    source: '2026 Trustees Report (June 9, 2026)',
    published: { kind: 'sameYear', month: 7, day: 15 },
    where: 'ssa.gov/oact/tr',
  },
]

/**
 * REQ-MCP-84: temporary provisions that end on a date in law, so a plan
 * spanning them knows they are not permanent.
 */
export const LAW_SUNSETS: readonly {
  readonly id: string
  readonly name: string
  readonly lastYear: number
  readonly source: string
}[] = [
  {
    id: 'seniorDeduction',
    name: 'Senior deduction ($6,000 per person 65+, phased out 6% above $75,000 single / $150,000 joint MAGI)',
    lastYear: 2028,
    source: 'One Big Beautiful Bill Act (P.L. 119-21) §70103',
  },
]

/** The year whose figures should be in force or published on asOfDate. */
export function expectedYear(table: LawTable, asOfDate: string): number {
  const year = Number(asOfDate.slice(0, 4))
  const monthDay = asOfDate.slice(5, 10)
  const cutoff = `${String(table.published.month).padStart(2, '0')}-${String(table.published.day).padStart(2, '0')}`
  const out = monthDay >= cutoff
  return table.published.kind === 'nextYear'
    ? out
      ? year + 1
      : year
    : out
      ? year
      : year - 1
}

export interface LawTableStatus {
  readonly id: string
  readonly name: string
  readonly engineYear: number
  readonly expectedYear: number
  readonly source: string
  readonly where: string
}

/** REQ-MCP-84: the tables behind the law on asOfDate, oldest first. */
export function lawTablesBehind(
  asOfDate: string,
  tables: readonly LawTable[] = LAW_TABLES
): LawTableStatus[] {
  return tables
    .map(t => ({
      id: t.id,
      name: t.name,
      engineYear: t.year,
      expectedYear: expectedYear(t, asOfDate),
      source: t.source,
      where: t.where,
    }))
    .filter(t => t.expectedYear > t.engineYear)
    .sort((a, b) => a.engineYear - b.engineYear)
}

/** One line per table behind, for the briefing and the review. */
export function lawTablesMessage(asOfDate: string): string | undefined {
  const behind = lawTablesBehind(asOfDate)
  if (behind.length === 0) return undefined
  return `the engine's law figures are behind: ${behind
    .map(
      t =>
        `${t.name} are for ${t.engineYear} (${t.source}); ${t.expectedYear} figures are due (${t.where})`
    )
    .join('; ')}. Update the engine before relying on tax figures`
}
