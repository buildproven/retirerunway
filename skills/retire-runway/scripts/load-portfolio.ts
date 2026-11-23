// Load a portfolio CSV and emit normalized JSON to stdout.
// Usage: node dist/load-portfolio.mjs <csv-path>
// Set SKILL_AS_OF_DATE=YYYY-MM-DD to give the as-of date (NFR-01).

import { parsePortfolioCSV } from '../../../src/engine/csv-parser.ts'
import { isCalendarDate } from '../../../src/engine/alerts.ts'
import {
  NO_AS_OF_DATE_WARNING,
  findCsvExportDate,
  type AsOfDateSource,
} from '../../../src/mcp/portfolio-tools.ts'
import { readText, writeJson, stamp, contentHashId } from './provenance.ts'

const path = process.argv[2]
if (!path) {
  console.error('usage: load-portfolio.ts <csv-path>')
  process.exit(2)
}

const inputAsOfDate = process.env.SKILL_AS_OF_DATE
if (inputAsOfDate !== undefined && !isCalendarDate(inputAsOfDate)) {
  console.error(
    `SKILL_AS_OF_DATE must be a real calendar date (YYYY-MM-DD), got ${JSON.stringify(inputAsOfDate)}`
  )
  process.exit(2)
}

const csv = await readText(path)
const result = parsePortfolioCSV(csv)

// The as-of date is never read from the clock, so the same CSV gives the same
// portfolio and hash on every day (NFR-01). Same order as import_positions:
// SKILL_AS_OF_DATE, then the CSV export date, then none with a warning.
const csvAsOfDate =
  inputAsOfDate === undefined ? findCsvExportDate(csv) : undefined
const asOfDate = inputAsOfDate ?? csvAsOfDate
const asOfDateSource: AsOfDateSource =
  inputAsOfDate !== undefined
    ? 'input'
    : csvAsOfDate !== undefined
      ? 'csv'
      : 'none'

// ID is derived from CSV content — deterministic across runs on the same file.
const portfolio = {
  id: contentHashId('loaded', csv),
  name: 'Loaded Portfolio',
  accounts: result.accounts,
  ...(asOfDate === undefined ? {} : { asOfDate }),
}

writeJson({
  portfolio,
  import: {
    format: result.format,
    warnings:
      asOfDate === undefined
        ? [...result.warnings, NO_AS_OF_DATE_WARNING]
        : result.warnings,
    rowsImported: result.rowsImported,
    rowsSkipped: result.rowsSkipped,
  },
  provenance: [
    stamp('parsePortfolioCSV', { path, bytes: csv.length }, portfolio, {
      assumptions: { format: result.format, asOfDateSource },
    }),
  ],
})
