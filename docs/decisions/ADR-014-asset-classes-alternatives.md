# ADR-014: Asset classes beyond stocks and bonds

- Status: accepted
- Date: 2026-11-25
- Requirements: REQ-MCP-78

## Context

The projection had two return streams. Every holding that was not a US,
international or emerging-market stock, gold and REITs included, was
modelled as a bond: 4% mean, bond volatility. Owners hold gold (GLD),
REITs and other assets, and the firms' forecasts differ a lot by class (late
2026: J.P. Morgan gold 5.5%, broad commodities 4.8%, REITs 8.2%, emerging
markets 7.1%; Vanguard non-US developed 4.9%-6.9%, US growth 2.3%-4.3%, US
value 5.8%-7.8%). A recommendation that ignores what each class is expected
to pay against risk-free TIPS is not advice.

## Decision

- Three sleeves: stocks (REITs included), safe, alternatives. Alternatives
  get their own long-run mean (4%: about 1% real, where most studies of
  gold's long-run real return land) and volatility (16%), drawn
  independently. The draw happens only when alternatives are held, after the
  existing draws, so seeded results for plans without them do not change.
- Forecasts by asset class are dated market data (`assetForecasts`), saved
  by the agent from the firms' own pages. Under preset `forecast` they set
  the near-term stock and alternatives means from the classes the owner
  holds.
- Every class is compared with the TIPS real yield: premium and premium per
  unit of volatility, with fixed thresholds (thin below 0.10, strong from
  0.25).
- The alternatives share is tested at none, today's, 5% and 10%, and a
  better share is advice, not a saved rule.

## Consequences

- Correlations are not modelled (alternatives independent; stocks and bonds
  independent as before). Gold's diversification value is therefore
  approximate.
- Results change for plans holding gold, commodities, crypto or REITs; that
  is the fix.
- The historical replay has no gold history; alternatives earn their mean
  there.
