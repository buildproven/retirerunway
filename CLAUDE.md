# RetireRunway - Claude Guide

> Financial modelling tool for pre-retirees

## Project Status

**Stage:** v1.0.0, open source under MIT (free, educational)
**Quality Maturity:** Production-ready

## Tech Stack

- **Frontend:** Next.js 16 (App Router) + TypeScript
- **UI:** shadcn/ui + Tailwind CSS v4
- **Charts:** Recharts
- **State:** Zustand
- **AI:** Vercel AI SDK (@ai-sdk/anthropic, @ai-sdk/openai)
- **Database:** Supabase (Postgres) — wired locally; production project and credentials remain external launch gates
- **Hosting:** Vercel

## Architecture

**Key principle:** LLM is the analyst narrator, not the calculator.

- `src/app/` — Next.js pages and API routes
- `src/components/ui/` — shadcn/ui components
- `src/lib/` — Shared utilities
- `src/engine/` — Deterministic modelling (scenarios, risk scores, trade plans, CD logic, projections). No AI here — must be auditable and reproducible.
- `src/ai/` — AI orchestration (BYOK adapter, prompt templates, narration)
- `src/store/` — Zustand stores
- `skills/retire-runway/` — Claude Code skill wrapping the engine. Ships tool CLIs + provenance system; same determinism contract as the engine.

## Requirements, design, traceability

- `docs/REQUIREMENTS.md` (IDs `FR-xx` / `NFR-xx` / `DEF-xx`) → `docs/DESIGN.md` + `docs/decisions/ADR-*` → code and tests via `docs/traceability.json` (rendered to `docs/TRACEABILITY.md`).
- Adding or moving a source or test file under a governed directory requires mapping it to a requirement; `npm run traceability:check` (also run by `npm test`) fails on orphans, missing files, and a stale matrix. Regenerate with `npm run traceability:write`.
- Product is free and educational; billing stays off (NFR-05). See the distribution decision in REQUIREMENTS.md §1.

## Commands

```bash
npm run dev                 # Local dev server
npm run build               # Production build
npm run lint                # ESLint (Next.js)
npm run lint:fix            # ESLint with auto-fix
npm run format              # Prettier formatting
npm run format:check        # Check formatting
npm run type-check          # TypeScript check
npm run quality:check       # All checks (type + lint + test)
npm test                    # Run tests (Vitest)
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report
```

## Conventions

- All financial calculations MUST be deterministic (no AI)
- AI only narrates/explains outputs from the deterministic engine
- Use `@/*` import alias for `src/` directory
- Components in `src/components/`, pages in `src/app/`
- TypeScript strict mode enabled

## Code Patterns (Learned)

### API Security & Validation

**Webhook Security (Stripe)**

- Verify signature BEFORE parsing (fail fast)
- Validate timestamp within 5-minute tolerance (replay attack protection)
- Wrap JSON.parse in try-catch, then type guard validation
- Return 400 for client errors (malformed), 500 for server errors

**Rate Limiting**

- Tiered limits by route sensitivity: AI (20/min), Payment (10/min), API (100/min)
- In-memory sliding window for MVP, migrate to Redis for multi-instance production
- Higher-order function: `withRateLimit(handler, config)`
- Return 429 with Retry-After and X-RateLimit-\* headers

**Input Validation**

- Zod schemas in `src/lib/validation-schemas.ts`
- Higher-order function: `withValidation(schema, handler)`
- Layer order: `withRateLimit → withValidation → handler`
- Return 400 with field-specific errors

**Authentication Middleware**

- Supabase auth with `@supabase/ssr` for App Router
- Higher-order function: `withAuth(handler)`
- Middleware composition: `compose(withAuth, withRateLimit, withValidation)(handler)`
- Different auth per route type: Supabase user auth vs API key vs webhook signature

### Error Handling

**Async Operations in React**

- Two-layer: `.then(check error) + .catch(handle rejection)` OR `try/catch/finally`
- Always set `loading: false` in both error paths
- Set safe fallback values (empty arrays, null) in catch blocks
- Use cleanup in `finally` blocks

**CSV/Parser Error Protection**

- Layer 1: Low-level validation (throw specific errors)
- Layer 2: Mid-level recovery (skip malformed rows, continue processing)
- Layer 3: High-level never throws (return `Result` with warnings array)
- Layer 4: UI translation (technical errors → user-friendly messages)

### Determinism (engine + skill)

- **No `Math.random()` or wall-clock reads on reproducibility-critical paths** — CSV parsing, Plaid mapping, report generation, provenance hashing, projection outputs, anything that flows into a `provenance` block. UI-only alert IDs in `alerts.ts` / `plaid-mapper.ts` may use wall-clock values only when they do not feed a hash. CSV and Plaid IDs use the 128-bit-width `stableId()` derived from content. Import and report `asOfDate`/`generatedAt` values are explicit inputs.
- **Canonicalize recursively before hashing.** Top-level-only key sort silently breaks determinism on nested reorder. `sortKeys()` in `skills/retire-runway/scripts/provenance.ts` throws on non-plain objects (Date, Map, Set) rather than serializing to `{}` and colliding.
- **Validate skill inputs as plain objects.** Arrays/primitives/null must be rejected at the CLI boundary via `assertPlainObject`, not silently coerced.
- **Content-hash IDs need ≥128 bits** if ever used as primary keys (32 hex chars). 48 bits collides.

### Monte Carlo invariants (don't regress)

- Inflation compounds via a running `cumulativeInflation *= (1 + draw)` — never `Math.pow(1 + drawThisYear, yearIndex)`. The latter makes each year's expenses depend on a single random draw.
- Withdrawals start at `age >= target`, not `age > target` (off-by-one = one missed year of spending).
- Seeded LCG only. Default seed 42. Same inputs + seed = byte-identical output.

### Testing

- **Assert correctness, not just structure.** Structural assertions (object has key X) pass even when the engine silently inverts a sign. Every engine output needs at least one value/range/monotonicity assertion.
- Real CSV fixtures live in `skills/retire-runway/fixtures/csv/` (Fidelity, Schwab, Vanguard, generic, malformed). Use these for parser tests — don't inline CSV strings.
- Commit fixtures directly. Never generate fixtures inline via `node -e` in test setup — races on parallel runs.
- Prefer `readFileSync` over `execFileSync('cat', ...)` in tests (platform fragility).

## Library Gotchas

- **AI SDK v6:** Use `maxOutputTokens` (not `maxTokens`), `toTextStreamResponse()` for streaming, `@ai-sdk/react` is a separate package from `ai`. Use `generateText` for structured JSON extraction, `streamText` for narrative content
- **React:** Use `useMemo` for sync derived state (not `useEffect` + `setState`); all hooks must come before early returns
- **Recharts v3:** Tooltip `formatter` params are optional; use CSS variables for theming

## What NOT to Do

- Don't use AI for portfolio value calculations, scenario math, CD penalties, or risk scores
- Don't commit secrets (use .env)
- Don't skip quality gates
- Don't use `any` types

---

**Last Updated:** 2026-08-22
