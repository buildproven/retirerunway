# ADR-009: The engine proposes the plan rules; the owner approves them

Status: accepted, 2026-11-24

## Context

plan_check measured the portfolio against rules the owner had to write
(target stock share, cash buffer, sell schedule, CD ladder). A real run showed
the cost: the owner's ladder matured in 2027-2030, years before a 2033
retirement, and the cash buffer asked for a year of retirement spending seven
years early. Nothing in the tools questioned the rules. A planner follows a
fixed sequence (understand, set goals, analyse, recommend, present, implement,
monitor); the recommend and present steps were missing for the rules.

## Decision

Add `propose_plan_rules` (REQ-MCP-64). The engine derives each rule from the
plan with a stated method, tests the stock share by running the projection at
each candidate, and returns findings against the current rules. Claude
presents them; the owner approves each change; save_profile stores only what
was approved. Scheduled runs report and never save.

## Consequences

- Rules carry their reasons and test results, so the owner can check them.
- The stock-share test holds the share constant to the planning age. It does
  not model a rising glide path; the ladder plays the bond-tent role instead.
- The ladder is sized in today's dollars while CDs pay fixed nominal amounts,
  so later rungs lose to inflation; the result says so.
- The method is a heuristic, not advice: the disclaimer applies, and every
  number is from the engine.
