# OddKet — Handoff Document

> **This is the living handoff doc.** It is updated at the end of every build pass and must
> be kept current whenever the repo changes hands. If you are picking this project up,
> start here, then read `OddKet_PRD.md` and `OddKet_Build_Prompt.md`.

**Last updated:** Pass 1 — full V1 monorepo scaffold **complete** (all typechecks, prod build,
model pipeline, and worker end-to-end tests green)

---

## 1. Project snapshot

- **What:** OddKet — decision-support for sports betting on SportyBet. Probability + confidence
  interval per pick, Kelly staking, CLV as the scoreboard, calibration dashboard.
- **Owner:** Eleazar Ogoyemi (codeleyoungtech)
- **Stack:** pnpm monorepo · Next.js 14 (App Router) + Tailwind + Recharts · Hono + Cloudflare
  Workers + D1 (plain SQL migrations — no ORM) · Python/XGBoost sidecar.
- **Hard budget:** V1 must run on **$0**. Free odds API tier only, Workers + D1 free tier,
  Cron tuned to stay inside ~500 req/month.
- **Dev environment:** Termux proot Ubuntu on Android (aarch64). Workspace lives at `~/oddket`
  (f2fs home — NOT `/sdcard`, which forbids symlinks and breaks pnpm + venvs).

## 2. What is built (map to PRD §9 V1 build order)

| PRD step | Status | Where |
|---|---|---|
| 1. Odds ingestion + D1 schema | ✅ Built + tested | `worker/src/db.ts`, `worker/migrations/0000_init.sql`, `worker/src/odds/*` (The Odds API client, env-gated) |
| 2. Prediction model (BTTS first) | ✅ Scaffolded | `model/scripts/train.py` (XGBoost + sklearn fallback), `calibrate` step, `predict.py` → JSON |
| 3. EV engine (implied prob, margin, edge) | ✅ Built | `packages/core/src/ev.ts`, exposed via `GET /api/slips` |
| 4. Bet logging + CLV engine | ✅ Built | `POST /api/bets`, `GET /api/clv`, cron closing-odds pull, `packages/core/src/aggregates.ts` |
| 5. Calibration dashboard | ✅ Built | `apps/web/app/calibration` (Brier + calibration curve, most prominent charts) |
| 6. Slip builder UI (singles-first, opt-in multiples) | ✅ Built | `apps/web/app/slips`, correlation warnings, copyable slip — **no place-bet action** |
| 7. Staking module (fractional Kelly + stop-loss) | ✅ Built | `packages/core/src/kelly.ts`, enforced in UI + settings |
| 8. Backtest + paper-trade mode | ✅ Built (paper-trade groundwork) | `apps/web/app/backtest`, historical simulation via aggregates |
| 9. Multiples with correlation warnings | ✅ Built | `packages/core/src/correlation.ts`, leg selector in slip builder |

**Demo-mode note:** the whole pipeline runs today on a deterministic seed dataset
(`packages/core/src/seed.ts`) so every dashboard shows real numbers with no API keys.
Live pulls activate the moment `ODDS_API_KEY` is set.

## 3. How to run

See `README.md` → Quickstart. Short version:

```bash
pnpm install
pnpm dev:web              # dashboard, demo mode, http://localhost:3000
cd worker && pnpm dev     # API, http://localhost:8787 (+ POST /api/seed?force=1)
pnpm model:train && pnpm model:predict   # python sidecar (synthetic offline)
```

## 4. Key files

| File | Purpose |
|---|---|
| `packages/core/src/types.ts` | Canonical record shapes (fixture, odds, prediction, bet, CLV, outcome, settings) |
| `packages/core/src/math.ts` | Margin-adjusted implied prob, Brier, Wilson CI, CLV fractional, Poisson helpers |
| `packages/core/src/kelly.ts` | Fractional Kelly stake + stop-loss caps |
| `packages/core/src/ev.ts` | Edge computation + slip flagging (threshold-gated) |
| `packages/core/src/aggregates.ts` | Calibration bins, CLV series, bankroll series, dashboard summary |
| `packages/core/src/backtest.ts` | Historical replay of finished fixtures through the same EV engine |
| `packages/core/src/seed.ts` | Deterministic demo dataset (4 leagues, 80 fixtures, ~110 bets) |
| `packages/core/src/correlation.ts` | Multi-leg independence warnings (same-fixture, same-kickoff) |
| `worker/src/index.ts` | Hono app + scheduled (Cron) handler |
| `worker/src/db.ts` | D1 row mappers + all queries (plain SQL, no ORM) |
| `worker/src/odds/ingest.ts` | Pull → store snapshots (free-tier budget aware) |
| `worker/src/odds/closing.ts` | Daily closing-odds pull → CLV records for pending bets |
| `worker/wrangler.toml` | D1 binding, Cron triggers, env vars |
| `worker/scripts/bundle.mjs` | esbuild bundle for local testing without workerd |
| `worker/scripts/serve.mjs` | Local API dev server on :8787 (SQLite-backed, proot-safe `wrangler dev` replacement) |
| `worker/test/e2e.mjs` | 48-check end-to-end API test against real SQLite (node:sqlite) |
| `worker/test/d1-adapter.mjs` | Shared D1-compatible adapter over node:sqlite (e2e + serve) |
| `apps/web/app/*` | Pages: overview, slips, calibration, bets, backtest, settings |
| `apps/web/lib/data-provider.tsx` | LIVE-API-or-seed fallback data layer |
| `model/scripts/*.py` | fetch → train → calibrate → predict |

## 5. Decisions & constraints locked in

1. **No auto-bet anywhere.** Slip builder outputs copyable text only. Do not add a "place bet"
   action without re-reading the PRD's non-negotiables.
2. **No promised returns.** Probability + CI always shown together; never a bare yes/no.
3. **Free tier math:** Cron = 2 triggers/day × 2 jobs ≈ 120 odds requests/month + sports list.
   Add leagues/markets only by re-checking the 500/month budget.
4. **CLV > win/loss.** Dashboard headline is cumulative CLV, not streak.
5. **Multiples opt-in** with true compounded probability + correlation warnings (same-fixture
   legs flagged non-independent).
6. **The Odds API markets default `h2h,totals`** (safe on free tier). `btts` can be added to
   `ODDS_MARKETS` if the tier supports it.
7. **Local worker dev + tests use `node:sqlite` + esbuild** — no workerd needed.
   workerd (wrangler's local runtime) cannot run under proot — it crashes with tcmalloc
   address-space errors — so:
   - `cd worker && npm run serve:local` → real HTTP API on `http://localhost:8787`
     (persistent SQLite DB at `worker/.local/oddket.db`), then `POST /api/seed?force=1`.
   - `cd worker && npm run test:local` → the 48-check e2e suite.
   `wrangler d1` remote still works for deploy.
8. **esbuild pinned at 0.17.19** as a worker devDependency (offline-installed from store) —
   the exact version already present in the root store. Bump with care.
9. **No `.npmrc`** — the `node-linker=hoisted` hack was removed once the project moved to
   f2fs; default pnpm isolated linker works fine there.

## 6. Known gaps / what's next

- [ ] Create real D1 database (`wrangler d1 create oddket`) + set `database_id` in `wrangler.toml` for deploy.
- [ ] Provide `ODDS_API_KEY` (The Odds API free tier) in `worker/.dev.vars`, verify live pull.
- [ ] Wire model output → `POST /api/predictions/ingest` (currently manual/CLI — endpoint is built and tested).
- [ ] Real historical training data via `model/scripts/fetch_historical.py` (football-data.org free token).
- [ ] Next deploy target (Cloudflare Pages / Workers static) for the dashboard.
- [ ] Backtest page currently reads historical simulation; add explicit "paper-trade mode" toggle that
      logs picks without staking for N weeks.

## 7. Verification status (this pass)

- [x] `pnpm -r typecheck` across core/worker/web — green
- [x] `next build` production build (all 6 routes prerendered)
- [x] Worker e2e: `cd worker && npm run test:local` — **48/48 checks pass**
      (migrations, seed, dashboard, slips/multiples, bet placement + cap/validation,
      outcome settlement + payout math, CLV entry + series, calibration, backtest,
      settings persistence, prediction ingest, all three cron paths in demo mode)
- [x] Python pipeline runs in synthetic mode (calibrated Brier 0.32; `model/output/*.json`)
- [ ] Live odds pull (needs API key)
- [ ] Committed to git (pending — first commit this pass)

## 8. Gotchas

- `pnpm dev:web` demo mode needs no backend. If the worker is also running, the web app will use it
  (LIVE badge) — kill the worker to force demo mode.
- The seed is deterministic (fixed PRNG seed) so charts are stable across reloads.
- D1 local under proot: **`wrangler d1 migrations apply --local` will NOT work** (workerd can't
  run in proot). Use `npm run test:local` to verify the worker against SQLite instead. Remote
  D1 (`--remote`) works normally once deployed.
- Python 3.14: if `xgboost` wheels are unavailable (or the network flakes out), `train.py`
  auto-falls-back to sklearn `GradientBoostingClassifier` — output format is identical.
- pip downloads on this network are flaky; retry individually, e.g.
  `.venv/bin/pip install xgboost` (or just rely on the sklearn fallback).
