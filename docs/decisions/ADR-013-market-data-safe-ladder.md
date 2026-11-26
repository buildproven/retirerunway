# ADR-013: Current market data, a safe ladder for the bridge, rules as working settings

- Status: accepted
- Date: 2026-11-24
- Requirements: REQ-MCP-75, REQ-MCP-76, REQ-MCP-77

## Context

The forecast returns were numbers committed on 2026-11-21 (stocks 4.5%,
bonds 4%, inflation 3%), and the stock-share test only weighed stocks
against a volatile bond fund. By late 2026 call-protected CDs paid about 5%,
the 10-year Treasury about 5% and the 10-year TIPS auction 2.9% real, the
highest since 2002, while the firms' 10-year stock forecasts ran 4% to 7.5%.
Stocks were expected to pay little more than risk-free money, yet the
engine proposed more stocks, because a held-to-maturity ladder (no market
risk over the bridge years) was not modelled. The owner also asked that the
plan rules be the system's working settings, updated as markets change, not
rules he must approve one by one.

## Decision

- Market data is an explicit, dated profile input (`marketData`), saved by
  the agent from dated pages with `save_market_data`. The engine never reads
  the network or the clock, so runs stay reproducible; the briefing warns
  after 35 days.
- Preset `forecast` uses the saved data when present: stocks at the average
  of the firms' forecasts, bonds at the 10-year Treasury yield, inflation at
  the breakeven.
- A held-to-maturity ladder (`safeLadder`) is modelled as its cost taken out
  of the account that holds it and its rungs paid as income, TIPS indexed to
  the path's inflation, CDs fixed. `propose_plan_rules` tests 3-year, 5-year
  and whole-bridge ladders at the saved yields against no ladder, on the same
  seed and the same worse-of-two score.
- `goals.autoApplyRules` lets the review stand on the proposed rules and the
  agent save them; trades stay the owner's.

## Consequences

- Recommendations move with the market only as often as the market data is
  refreshed; the monthly check refreshes it first.
- Rungs are sized on the expected path, so a bad-path year can still need
  more than its rung; the rest comes from the remaining portfolio.
- CD rungs are fixed in dollars and lose to inflation above the breakeven;
  TIPS rungs carry no such risk but are taxed as withdrawals from a pre-tax
  account. The projection does not charge the 10% penalty on rungs paid
  before 59½; a warning says so.
- The test multiplies the projections propose_plan_rules runs (three ladders
  by each candidate share, twice); runs stay well within the tool timeout.
