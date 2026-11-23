# RetireRunway

Retirement planning you can check. RetireRunway is a Claude plugin: a tested
engine calculates every number, and Claude only explains the results. Each
result carries a provenance stamp (the tool, the engine version, SHA-256
hashes of the input and output, and the seed), so the same inputs give the
same answer every time and you can trace any figure back to the call that
made it.

Free under the [MIT License](LICENSE), with no paid tier. Site:
[retirerunway.buildproven.ai](https://retirerunway.buildproven.ai).

> Educational simulation, not investment, tax or legal advice. RetireRunway is
> not a registered investment adviser. Check with a licensed professional
> before you act on anything it shows you.

## Use RetireRunway in Claude

You set it up once. Then you save your profile and a positions CSV, and ask
Claude things like "am I on track?" or "what should I do this month?".

### On your computer (Claude Code)

You need Node 24 (see `.nvmrc`) and Claude Code. The server runs over stdio
with `npm run mcp`:

```bash
git clone https://github.com/buildproven/retirerunway
cd retirerunway
npm ci
claude mcp add --transport stdio --scope user retire-runway \
  -- npm --prefix "$PWD" run --silent mcp
mkdir -p ~/.claude/skills && cp -R skills/retire-runway ~/.claude/skills/
```

Keep `--silent`: without it npm writes a banner to stdout, which carries the
MCP stream. Your data stays in `~/.retire-runway` (or the absolute path in
`RETIRE_RUNWAY_DATA_DIR`). Then ask Claude: "Set up my retirement plan."

### Your own hosted copy (web, desktop and phone)

The repo is also a Next.js app with a remote MCP endpoint at `/api/mcp`, for
claude.ai on the web, the desktop app and the phone apps. It serves one owner:
only your GitHub account can sign in, and your data lives in a private GitHub
repo you choose.

1. Deploy the repo to Vercel (or any Node host).
2. Create a GitHub OAuth app whose callback is
   `https://<your-host>/oauth/github/callback`, and a GitHub App with contents
   access to a private data repo.
3. Set the environment variables: `RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_ID`,
   `RETIRE_RUNWAY_GITHUB_OAUTH_CLIENT_SECRET`, `OWNER_GITHUB_LOGIN` and
   `RETIRE_RUNWAY_OWNER_SUBJECT` (your GitHub login),
   `RETIRE_RUNWAY_OAUTH_ISSUER` (`https://<your-host>`),
   `RETIRE_RUNWAY_OAUTH_JWKS_URL` (`https://<your-host>/oauth/jwks`),
   `RETIRE_RUNWAY_OAUTH_SIGNING_KEY` (a private ES256 JWK),
   `RETIRE_RUNWAY_DATA_REPO` (`owner/repo`), `RETIRE_RUNWAY_DATA_PATH`, and
   `RETIRE_RUNWAY_GITHUB_APP_ID` with `RETIRE_RUNWAY_GITHUB_APP_PRIVATE_KEY`.
4. In claude.ai, add a custom connector under Connectors at
   `https://<your-host>/api/mcp`, sign in with your GitHub account, and upload
   `skills/retire-runway` as a skill.

`docs/DESIGN.md` and `docs/REQUIREMENTS.md` describe the sign-in and the data
store in full. If you publish your copy as a plugin, change the URL in
`.mcp.json` to your host.

The web UI is frozen: it still runs, but new features go to the MCP tools and
the skill.

## What it does

- **A monthly verdict.** `plan_verdict` gives one GO, CAUTION or DELAY call
  from the success rate at long-run returns, the success rate at 10-year
  forecast returns, a replay through market history from every start year
  since 1928, the spending the plan supports, and your own rules.
- **Your rules, checked.** `plan_check` measures your newest snapshot against
  the rules you set (target stock share, drift band, cash buffer, a sell
  schedule, accounts never to sell from, one-off tasks) and lists what is due,
  with the trades by account and the estimated tax. Nothing is traded.
- **A US retirement model.** `project_retirement` keeps taxable, 401(k), IRA,
  Roth and NQDC money apart, with the 10% penalty before 59½, the Rule of 55,
  RMDs, federal brackets and a state rate, both spouses' Social Security
  (spousal and survivor benefits included), pre-Medicare health insurance with
  the ACA credit and its cliff, and Medicare IRMAA. All in today's dollars.
- **What-ifs side by side.** `compare_retirement_scenarios` runs up to four
  changes (downsize, retire later, side income, a job gap, a Social Security
  cut, a death before retirement) on the same portfolio and seed.
- **The other questions.** How much can I spend (`spending_guardrails`)? When
  should we claim Social Security (`explore_claiming_ages`)? Do Roth
  conversions help (`explore_roth_conversions`)? What moved the number since
  last month (`explain_change`)?

Positions import from Fidelity, Schwab, Vanguard or a generic CSV, with
account numbers removed before anything is saved.

## How it keeps the AI honest

- **The model never does maths.** All financial calculations live in
  `src/engine/`, which has no AI in it. The server instructions and the skill
  tell Claude to quote each figure with the tool that produced it.
- **Reproducible.** The Monte Carlo is a seeded generator (seed 42 by
  default). There are no clock reads or `Math.random()` calls on the
  calculation paths; the as-of date is an input.
- **Tested against values, not shapes.** Engine tests check numbers, ranges
  and directions, not only that a field exists.
- **Traceable.** Every requirement in `docs/REQUIREMENTS.md` maps to design,
  code and tests in `docs/TRACEABILITY.md`, and `npm test` fails on a file
  with no requirement.

## Develop

```bash
npm run quality:check   # type-check, lint and the full test suite
npm run traceability:check
```

Read `CLAUDE.md` first: the engine stays deterministic, AI only narrates, and
every new file maps to a requirement.

## License

MIT. See [LICENSE](LICENSE).
