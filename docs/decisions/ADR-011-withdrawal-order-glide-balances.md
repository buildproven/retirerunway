# ADR-011: Withdrawal order, glide path and pasted balances

- Status: accepted
- Date: 2026-11-24
- Requirements: REQ-MCP-70, REQ-MCP-71, REQ-MCP-72

## Context

The benchmark in `docs/RESEARCH.md` listed three gaps against paid planners:
the withdrawal order was fixed, the stock share was constant for life, and
cash, debts and the home had no import (positions only). All three change
the earliest safe retirement age and the cash the owner can rely on.

## Decision

- Withdrawal order is a profile setting with three orders (taxable first,
  pre-tax first, proportional). A comparison tool runs them, and taxable
  first with conversions filling the 12% bracket, on one seed. We chose a
  small set of orders that a planner can explain over a year-by-year
  optimiser: the results stay auditable and the owner picks.
- Glide path is a profile list of (age, stock share) points joined by
  straight lines. propose_plan_rules tests a bond tent and a rising path
  against the constant target and proposes one only when it wins by more than
  1 point on the worse of long-run and forecast returns.
- Balances come from a pasted net-worth list, not a live link: no
  credentials, no network, account numbers masked, nothing saved until the
  owner approves the proposed changes.

## Consequences

- With neither setting saved, every projection is unchanged.
- review_plan runs about 5 more projections.
- A live account link and a full withdrawal optimiser stay on the roadmap.
