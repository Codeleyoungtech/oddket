# OddKet

**Personal decision-support for sports betting. Truth over excitement.**

OddKet does **not** predict guaranteed outcomes, does not place bets automatically, and does
not promise any return. It tells the truth about whether a betting model has a real,
measurable edge — and helps you stake sensibly if it does.

Read `OddKet_PRD.md` (product) and `OddKet_Build_Prompt.md` (build rules) for full context.
The live handoff doc lives at [`HANDOFF.md`](./HANDOFF.md) and is updated every build pass.

---

## Non-negotiable constraints (from the PRD)

- **V1 runs on $0.** Free-tier odds API (~500 req/month), Cloudflare Workers + D1 free tier, Cron tuned to stay inside limits.
- **No auto-bet.** The system outputs a copyable slip summary for manual entry only — there is no "place bet" button.
- **No promised returns.** Every prediction ships with a probability + confidence interval, never a bare "win" signal.
- **No fixed-match / insider data.** Legitimate odds APIs and public stats only.
- **Singles by default.** Multiples are opt-in and always show true compounded probability alongside advertised odds, plus correlation warnings.
- **Every pick ships with a Kelly-based stake suggestion.**
- **CLV (Closing Line Value) is the scoreboard** — the primary metric for "is this model any good".

---

## Monorepo layout

```
apps/web/        Next.js 14 dashboard (Tailwind, Recharts) — dark sportsbook UI
worker/          Hono + Cloudflare Workers API, D1 (Drizzle), Cron ingestion + CLV
packages/core/   Shared TS: types, EV/Kelly/CLV math, calibration, deterministic seed data
model/           Python sidecar — XGBoost BTTS/result training, calibration, prediction export
HANDOFF.md       The handoff document — always kept current
```

## Quickstart

```bash
pnpm install

# 1. Dashboard (works immediately in demo mode with seeded data — no API keys needed)
pnpm dev:web           # http://localhost:3000

# 2. Worker API (optional — powers the LIVE mode badge)
cd worker
pnpm wrangler d1 migrations apply oddket --local
pnpm dev               # http://localhost:8787 — then POST /api/seed?force=1

# 3. Python model (offline synthetic mode; real data needs a football-data.org key)
pnpm model:train
pnpm model:predict
```

**Demo mode:** the web app tries the worker at `NEXT_PUBLIC_API_URL` (default
`http://localhost:8787`); if it can't reach it within 2.5s it falls back to the
deterministic seed dataset bundled in `@oddket/core`. Every chart and flow works either way.

**Live mode:** set `ODDS_API_KEY` in `worker/.dev.vars`, restart the worker, and re-seed.
The Cron schedule pulls odds up to 4×/day (~120 requests/month — safely inside the free tier).

## Verification

```bash
pnpm typecheck      # tsc --noEmit across core, worker, web
pnpm --filter @oddket/web build   # production Next.js build
```

## Responsible use

- You place every slip yourself in the SportyBet app. OddKet never touches your bookmaker account.
- No chase mechanics, no stake escalation after losses. Daily/weekly stop-losses are enforced in the UI.
- Gambling involves risk. Nothing here is financial advice, and no win rate is promised or implied.
