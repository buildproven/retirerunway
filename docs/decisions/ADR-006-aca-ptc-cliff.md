# ADR-006: Version the ACA premium-tax-credit cliff in plan projections

## Status

Accepted for implementation on 2026-08-22. The first implementation supports
the contiguous United States and fails closed for unsupported residence regions.

## Decision

Represent ACA premium-tax-credit eligibility with explicit, versioned FPL rules
keyed by projected tax year in `HealthcareACAConfig`. For the 2026 tax year,
the default US contiguous-states rule uses the 2025 HHS poverty guideline
($15,650 for one person plus $5,500 for each additional person) and a 400%
eligibility ceiling. The projection selects the exact rule for each covered
tax year and fails closed when that rule is unavailable. The projection
calculates annual MAGI from included income and tax-character-aware
withdrawals, reports the FPL percentage and amount above the ceiling, and
reports the subsidy lost when the ceiling is crossed.

The built-in intake includes official rules where available and explicitly
marked planning-estimate rules for later years so a long local projection does
not silently reuse a stale threshold. The UI labels those estimates. A caller
that supplies the existing `Scenario.healthcare.aca` contract must provide every
rule needed by the ACA-covered years. The intake requires explicit tax-family
size and residence region; filing status is not used as a family-size proxy
because a filer can have dependents. The initial implementation supports only
`contiguous_us`; Alaska and Hawaii fail closed until their separate HHS tables
are added. ACA projections are restricted to January-aligned
`asOfDate` values so each annual projection row maps to one calendar tax year;
non-January ACA scenarios fail closed until the projector has a calendar-month
MAGI ledger.

The built-in coverage schedule ends Marketplace coverage at Medicare
eligibility and uses the Medicare phase after age 65. The engine also fails
closed for married-filing-separately scenarios because the intake does not
collect the narrow exception evidence required for a positive PTC claim. The
income solver receives candidate ACA cliff points and searches each side of
those discontinuities instead of assuming the whole verdict function is
monotonic.

The modeled general eligibility interval is explicit: MAGI must be at least
100% of the applicable FPL and no more than the rule's upper percentage. The
engine does not infer a special lower-income exception. Unsupported lower-
boundary exception cases produce a visible uncertainty state rather than a
positive subsidy claim.

The engine keeps the contribution-rate and benchmark-premium inputs as planning
assumptions. The built-in intake uses the 2026 9.96% upper applicable-
percentage assumption and labels it in the results; it does not implement the
full income-band table. The engine does not claim to determine Marketplace
eligibility, plan availability, household tax filing eligibility, or the final
Form 8962 result.

## Alternatives considered

1. Keep a caller-provided `annualMagiCap` — rejected because the rule is not
   auditable or versioned and can silently become stale.
2. Fetch HHS or Marketplace rules at projection time — rejected because it
   would break deterministic, offline, reproducible projections.
3. Reuse the latest rule for later years — rejected because it silently
   presents stale law as current.
4. Add only a warning in the UI — rejected because the withdrawal and
   healthcare projection already contain the stable seam needed to expose the
   calculation to callers and tests.

## Invariants

- The same scenario and rule produce byte-stable projection output.
- MAGI includes ordinary income, capital gains, tax-character-aware account
  withdrawals, the nontaxable portion of included Social Security benefits,
  and explicit additional MAGI assumptions such as tax-exempt interest; other
  tax-free income is not silently included.
- MAGI below 100% FPL does not receive a general-rule modeled subsidy and is
  marked unsupported/uncertain.
- MAGI at or above 100% FPL and at or below the versioned ceiling can receive
  the modeled subsidy; MAGI above it receives no modeled subsidy under this
  rule.
- Crossing cost is the modeled subsidy available at the ceiling, capped by the
  plan premium, and is zero when the scenario is at or below the ceiling.
- Unsupported or malformed rules fail closed during healthcare validation.
- Each ACA-covered tax year selects a matching rule by exact year; no rule is
  silently inherited from a neighboring year.
- Social Security MAGI uses the full included benefit amount, not only the
  taxable planning fraction used for ordinary-income tax modeling.
- Non-January ACA scenarios fail closed rather than applying one anniversary-
  year MAGI total to two calendar tax years.
- The built-in schedule does not apply ACA credits after age 65 or to
  married-filing-separately scenarios without explicit exception evidence.
- Income-solver searches partition at modeled ACA cliff candidates and test
  both sides before returning a minimum.
- A one-person household and a dependent household exercise the family-size
  calculation, and an Alaska/Hawaii input fails closed instead of using the
  contiguous-states table.

## Rollback

Remove the ACA rule field and projection result fields, then restore the prior
caller-supplied cap behavior. No database migration is required because this
change is local to the deterministic engine and its UI.

## Verification

- Test the public `projectScenario` seam for the 2026 single and couple
  thresholds, below/equal/above boundary behavior, tax-character MAGI,
  nontaxable Social Security addback, year-specific rule selection, January
  alignment, and malformed or missing rule rejection.
- Test the plan results surface for a visible cliff warning and `as of` rule
  metadata.
- Run the repository quality workflow, including the production build and
  detached mutation evidence.

## Sources

- IRS, Publication 505 (2026):
  https://www.irs.gov/publications/p505
- IRS, Premium Tax Credit Q&A (updated December 23, 2025):
  https://www.irs.gov/pub/taxpros/fs-2025-10.pdf
- IRS, Revenue Procedure 2025-25, 2026 applicable percentage table:
  https://www.irs.gov/pub/irs-drop/rp-25-25.pdf
- HHS ASPE, 2025 Poverty Guidelines:
  https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines/prior-hhs-poverty-guidelines-federal-register-references
- HHS ASPE, 2026 Poverty Guidelines:
  https://aspe.hhs.gov/topics/poverty-economic-mobility/poverty-guidelines
