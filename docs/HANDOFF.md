# OddKet — Handoff Document

> **This is the living handoff doc.** It is updated at the end of every build pass and must
> be kept current whenever the repo changes hands. If you are picking this project up,
> start here, then read `OddKet_PRD.md` and `OddKet_Build_Prompt.md`.

**Last updated:** Pass 2 — **TENNIS MAIN-TOUR PIVOT** (ATP Challenger scope hard-blocked; Betfair geo-blocked from Nigeria; main-tour tennis build in progress).

---

## 11. Tennis build — scope blockers + pivot (Pass 2)

The Tennis PRD/Build-Prompt called for **ATP Challenger** tennis with CLV
validation. Two hard blockers surfaced during the pre-build spike and were
confirmed with the owner:

1. **The Odds API has NO Challenger coverage.** Their tennis coverage is
   exclusively Grand Slams + ATP 1000/500 + WTA equivalents (verified on
   `the-odds-api.com/sports/tennis-odds.html` + `sports-apis.html` — there is
   no `tennis_atp_challenger` sport key). No free-tier odds source covers
   Challenger, so CLV could not be measured at all.
2. **Betfair Exchange is geo-blocked from Nigeria.** The free delayed app
   key would cover Challenger (their tennis rules list Challenger/ITF/UTR),
   but Betfair does not accept Nigerian customers — the site returns
   "country not accepted" even without a VPN, and VPN circumvention violates
   their ToS (accounts closed on detection; KYC flags residence). A coverage
   probe script was written (`model/scripts/betfair_coverage_probe.py`) and
   is ready to run if legitimate Betfair access ever exists, but as of today
   the route is dead.

**Owner decision:** pivot to **ATP main tour (Grand Slams + ATP 1000/500) via
The Odds API** on the existing $0 pipeline, same discipline as football
(Platt calibration, time-ordered backtest, odds-as-feature, odds-band sweep
from day one). This is the one path with real odds + closing lines available
on $0 from Nigeria. The PRD warns main tour is heavily modeled (sharper
pricing, thinner edges) — that honest expectation stands; the build's job is
to measure whatever edge is actually there.

**Additional findings from the spike (all recorded for later):**
- JeffSackmann's `tennis_atp` GitHub repo is **gone** (account lists only
  `tennis_MatchChartingProject`; July 2026 Reddit threads confirm people are
  looking for backups). Mirrors are stale or missing Challenger rows
  (`Kadantte/tennis_atp` — no Challenger, ends May 2026; TML-Database — ends
  Jan 2026). Do NOT rely on tennis_atp for training data.
- **Training data instead:** `tennis-data.co.uk` — free, updated daily,
  ATP main tour results + odds back to 2001, and critically **multiple
  bookmakers per match including Pinnacle (`PSW/PSL`) and Bet365
  (`B365W/B365L`)** → cross-bookmaker spread is computable for training
  (the football-analog feature).
- BALLDONTLIE ATP API: free tier excludes match/odds endpoints (paid tiers
  only) — not usable on $0.
- Tennis sport keys on The Odds API are **per-tournament** (e.g.
  `tennis_atp_french_open`), not one `tennis_atp` key — ingest must loop
  active tournament keys, each costing one API credit.

---

## 12. Tennis main-tour build (Pass 2) — what shipped + honest model results

Full tennis pipeline built mirroring the football architecture, isolated so the
live football paper-trade is untouched:

- **Schema:** `worker/migrations/0001_tennis.sql` — 5 isolated tables
  (`tennis_matches`, `tennis_odds_snapshots`, `tennis_predictions`, `tennis_bets`,
  `tennis_clv_results`). `tennis_matches` has a `winner` column so outcomes are
  synthesized without a fork in the shared aggregate/calibration code (h2h
  selection = player name; tennis has no draw).
- **Core:** `TENNIS_SPORTS` map (per-tournament The Odds API sport keys), tennis
  helpers, `buildTennisSeedDatabase` demo seed → all existing dashboard views
  (calibration, CLV, slips, bets, backtest) work in demo mode with zero forks.
- **Worker:** `odds/tennis-client.ts` + `odds/tennis-ingest.ts` (h2h only,
  per-tournament loop, env-gated by `TENNIS_SPORTS`), `/api/tennis/*` endpoints
  (fixtures, snapshots, predictions/ingest, bets, clv, backtest, ingest/closing
  manual triggers), outcomes synthesized from `winner`.
- **Web:** sport selector (⚽/🎾) in the nav — switches the data-provider between
  `/api/*` and `/api/tennis/*` (LIVE mode) or between the two demo seeds. Bets
  page hides the Draw selection in tennis mode.
- **Model:** `tennis_fetch.py` (tennis-data.co.uk, 9,224 ATP main-tour matches
  2019–2026, multi-book B365+Pinnacle per match) → `tennis_features.py`
  (surface Elo, H2H, exponentially-weighted form, rest days, rank gap, odds
  implied + cross-book spread — name-resolved, leakage-free) →
  `train_tennis.py` (XGBoost, Platt sigmoid calibration on TRAIN, time-ordered
  80/20 split, odds-band sweep in the artifact) → `predict_tennis.py`
  (surface/best-of/tour-level derived from tournament name, ATP rankings absent
  on $0 so rank features go neutral at predict time).

**Honest model results (holdout 2025-04-25 → 2026-08-14, 1,845 matches):**

- Accuracy 0.683, Brier 0.2147 raw → **0.2022 calibrated** (well-calibrated bins).
- Backtest (edge > 0, quarter-Kelly, 5% cap, best-price entry): **1,347 bets,
  ROI −3.52%, win 40.8%, avg edge +5.68%**.
- Odds-band sweep: 1.00–1.50 → −5.42%; 1.50–2.00 → −2.88%; 2.00–2.50 → **+5.89%**
  (206 bets); 2.50–3.50 → −1.47%; 3.50+ → −2.19%.
- **Reading: no proven edge on the holdout.** The 2.00–2.50 band is positive but
  small-sample and cherry-picked post-hoc — do NOT treat it as a real edge.
  This matches the PRD's honest expectation (main tour is sharply priced) and
  the football model's own early baseline. Edge/CLV must be measured live via
  the worker's closing-odds pull before any conclusion.

**Two real bugs found + fixed during this pass (worth remembering):**

1. **Odds-as-feature leaked the outcome.** tennis-data.co.uk stores odds keyed
   to Winner/Loser columns (outcome-labeled), so routing odds by `m.p1_won`
   gave 100% accuracy / 0 Brier on the holdout (classic leakage). Fixed by
   name-resolving each player's odds at build time (`p1 == Winner` etc.) —
   name + price is pre-match info, outcome slot is not.
2. **Stale `r` reference in `build_tennis_matches`.** The second loop iterated
   parsed tuples but resolved odds from `r` — the last row of the first loop —
   so books resolved for only 344/9,224 matches. Fixed by carrying the raw row
   through the parsed tuple; now 8,114/9,224 have both sides with B365+Pinnacle
   (88% spread coverage).

**Live feed multi-book question — ANSWERED (Aug 15, 2026, live run):** The
Odds API's live tennis feed has **22 distinct bookmakers per event set**;
Pinnacle present on all matches, 16–22 books per match typically, with real
sharp-vs-soft spreads (e.g. Cincinnati Open h2h: Pinnacle 1.18 / Betfair 1.16 /
Winamax 1.10 on Djokovic). Cross-book spread is therefore computable in the
live loop too — the feature stays available end-to-end. The full live pipeline
was verified with a real key: 25 Cincinnati fixtures ingested, 1,042 odds
snapshots stored, model predictions exported→predicted→ingested (50 rows), and
`GET /api/tennis/slips` flags 14 edge-positive legs with real player names +
model probability + margin-adjusted implied.

**DEPLOYED (Aug 15, 2026)** — tennis runs continuously in production:

- Worker: `https://oddket-worker.olivia-eleyoungtech-io.workers.dev` (D1 `oddket`,
  migration 0001 applied). GitHub Actions fires `/api/tennis/ingest` +
  `/api/tennis/closing` alongside the football endpoints (cron.yml) and runs
  `predict-tennis` twice daily (predict.yml) — no laptop needed.
- **Budget guard — corrected (Aug 15, 2026):** measured reality is that
  out-of-season keys returning empty cost **0 credits** (`x-requests-last: 0`);
  only in-season keys cost 1/pull. So it's safe to list upcoming tournaments in
  advance (free until they go in-season) and no redeploy is needed when
  fixtures post. `TENNIS_SPORTS` currently tracks Cincinnati + US Open +
  **Shanghai Masters** (added early; costs 0 until Oct 7). Remove Cincinnati
  after ~Aug 23 (it'll still cost 0 once out of season, so this is optional).
- **Multi-key rotation (Aug 15, 2026):** `ODDS_API_KEY` holds a comma-separated
  list of **5 keys** (~2,500 credits/month combined; full football+tennis config
  burns ~720/mo, so one key alone exhausts mid-month). `fetchOdds` round-robins
  across keys per sport pull and falls back on 401/429 — an exhausted key never
  kills the pipeline. Verified live: cron run spread credits across 4/5 keys.
  Same list is set as the GitHub Actions `ODDS_API_KEY` secret. Rotation cursor
  is random-seeded per call, so keys spread evenly over time.
- **Spread capture is automatic:** every ingest stores one snapshot per
  (fixture, selection, bookmaker) — verified live with 22 bookmakers on
  Cincinnati (Coolbet, GTbets, Winamax, Betfair, Matchbook, Pinnacle, ...).
  Spread history accumulates in D1 for the mid-Oct retrain; no code change
  needed to "start" it.
- Verified end-to-end in prod: cron → 19 fixtures/788 snapshots →
  predict-tennis → 38 predictions → 9 flagged slips with model P + edge.

**Tennis runbook (local):**

```bash
cd model && .venv/bin/python scripts/tennis_fetch.py    # rebuild 9,224-match dataset
.venv/bin/python scripts/train_tennis.py                # train + honest backtest
# live: export fixtures -> predict -> ingest
cd worker && npm run serve:local
curl -s -X POST 'http://localhost:8787/api/seed?force=1'
# (set TENNIS_SPORTS + ODDS_API_KEY, then) curl -s -X POST http://localhost:8787/api/tennis/ingest
# model: export -> .venv/bin/python scripts/predict_tennis.py -> POST /api/tennis/predictions/ingest
```

**Verification (Pass 2):** `pnpm -r` typecheck green · worker e2e **69/69**
(10 new tennis checks) · `next build` green.

---
- Fixed a real bug: `mapEvent` only stored `draw` h2h outcomes — home/away were
  dead code (a `toSelection()` null-check `continue`d before team-name matching).
  Now all 3 outcomes land. Caught by running against live data, not the seed.
- Fixed `commenceTimeFrom` format (The Odds API rejects ISO with milliseconds).
- Ingested **10 live EPL fixtures / 30 odds snapshots**; model predicted on them
  via new `worker/scripts/export-fixtures.mjs`; 30 predictions ingested.
  Edge-flagged legs now show real model probability + CI vs live implied.
- `ODDS_FETCH_LIMIT` 3 → 10 (still 1 API request; slice is client-side).

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
| `worker/src/index.ts` | Hono app + scheduled (Cron) handler + manual triggers `POST /api/ingest` / `POST /api/closing` |
| `worker/src/db.ts` | D1 row mappers + all queries (plain SQL, no ORM) |
| `worker/src/odds/ingest.ts` | Pull → store snapshots (free-tier budget aware) |
| `worker/src/odds/closing.ts` | Daily closing-odds pull → CLV records for pending bets |
| `worker/wrangler.toml` | D1 binding, Cron triggers, env vars |
| `worker/scripts/bundle.mjs` | esbuild bundle for local testing without workerd |
| `worker/scripts/serve.mjs` | Local API dev server on :8787 (SQLite-backed, proot-safe `wrangler dev` replacement) |
| `worker/scripts/export-fixtures.mjs` | Export live fixtures + best h2h odds → `model/data/fixtures.json` (feeds the model real games) |
| `worker/test/e2e.mjs` | 50-check end-to-end API test against real SQLite (node:sqlite) |
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
     `serve.mjs` forwards `ODDS_API_KEY` (+ `ODDS_*` vars) from the shell, so live mode
     works locally: `export ODDS_API_KEY=... && npm run serve:local`.
   - `cd worker && npm run test:local` → the 50-check e2e suite.
   `wrangler d1` remote still works for deploy.
10. **Cron jobs are HTTP-triggerable for testing.** `POST /api/ingest` runs the same code
    path as the 09:00/18:00 odds cron; `POST /api/closing` same as the 18:30 CLV cron.
    Without `ODDS_API_KEY` both are safe demo no-ops.
8. **esbuild pinned at 0.17.19** as a worker devDependency (offline-installed from store) —
   the exact version already present in the root store. Bump with care.
9. **No `.npmrc`** — the `node-linker=hoisted` hack was removed once the project moved to
   f2fs; default pnpm isolated linker works fine there.

## 6. Known gaps / what's next

- [ ] Create real D1 database (`wrangler d1 create oddket`) + set `database_id` in `wrangler.toml` for deploy.
- [x] Live ingest verified with a real key (10 EPL fixtures / 30 snapshots stored; see §10)
- [x] Model predictions pushed to live fixtures (`export-fixtures.mjs` → predict → ingest — 30 rows)
- [ ] Deploy so the cron schedules actually fire (needs Cloudflare + D1 database_id)
- [ ] Real historical training data via `model/scripts/fetch_historical.py` (football-data.org free token).
- [ ] Next deploy target (Cloudflare Pages / Workers static) for the dashboard.
- [ ] Backtest page currently reads historical simulation; add explicit "paper-trade mode" toggle that
      logs picks without staking for N weeks.

## 7. Verification status (this pass)

- [x] `pnpm -r typecheck` across core/worker/web — green
- [x] `next build` production build (all 6 routes prerendered)
- [x] Worker e2e: `cd worker && npm run test:local` — **50/50 checks pass**
      (migrations, seed, dashboard, slips/multiples, bet placement + cap/validation,
      outcome settlement + payout math, CLV entry + series, calibration, backtest,
      settings persistence, prediction ingest, manual trigger routes, all three cron paths in demo mode)
- [x] Python pipeline runs in synthetic mode (calibrated Brier 0.32; `model/output/*.json`)
- [x] Live odds path wired — with any `ODDS_API_KEY` set, health reports `live`, and
      `POST /api/ingest` makes a real request to The Odds API (verified: returns the API's
      own `INVALID_KEY` error for a fake key; a valid key stores fixtures + snapshots)
- [x] Committed to git (Pass 1 + Pass 1b)

## 9. Testing the WHOLE thing (live pipeline, end-to-end)

This is the full flow — live odds → worker API → model → dashboard — and the accounts you need.

### Accounts / keys (all free)

| Service | Why | Free tier | Signup | Env var |
|---|---|---|---|---|
| **The Odds API** | Live odds for fixtures + closing odds for CLV | 500 requests/mo, no card | `https://the-odds-api.com` | `ODDS_API_KEY` |
| **football-data.org** (optional) | Real historical results to train the model | 10 req/min, free token | `https://www.football-data.org` | `FD_TOKEN` |
| **Cloudflare** (only for deploy) | Host the worker + D1 in production | Workers + D1 free tier | `https://dash.cloudflare.com` | `CLOUDFLARE_API_TOKEN` (wrangler login) |

### Step-by-step (local, proot-safe)

```bash
# 1) terminal A — worker API with your key (live mode)
export ODDS_API_KEY=your_the_odds_api_key
cd ~/oddket/worker && npm run serve:local

# 2) terminal B — seed demo data, then pull REAL live odds
curl -s -X POST 'http://localhost:8787/api/seed?force=1'
curl -s -X POST http://localhost:8787/api/ingest      # live odds in (same code as the cron)
curl -s http://localhost:8787/api/health              # expect "mode":"live"

# 3) train the model on real data (optional; needs football-data.org token)
cd ~/oddket/model && FD_TOKEN=your_token .venv/bin/python scripts/fetch_historical.py
.venv/bin/python scripts/train.py --source historical
# ...or skip straight to predictions with the synthetic model:
cd ~/oddket && pnpm model:predict

# 4) push model predictions into the worker DB
curl -s -X POST http://localhost:8787/api/predictions/ingest \
  -H 'Content-Type: application/json' -d @model/output/predictions.json

# 5) terminal C — dashboard, now in LIVE mode
cd ~/oddket && pnpm dev:web     # http://localhost:3000
# log a bet → record its outcome → watch CLV + calibration update
```

That's the whole thing: live odds → stored snapshots → model probabilities → edge-flagged
slips → logged bets → settlement → CLV/calibration dashboards. The cron schedules run the
same code in production (see `wrangler.toml`).

## 10. Live run results (Pass 1c — verified with a real key)

- `POST /api/ingest` → `{mode:"live", eventsPulled:10, fixturesStored:10, snapshotsStored:30}`
- 10 real EPL fixtures stored (Arsenal vs Coventry City, Hull vs Man Utd, Man City vs Bournemouth, …)
- Model predictions for all 30 h2h outcomes pushed; edge-flagged slips show e.g.
  Hull City home @ 7.0 — modelP 0.51 [0.37–0.66] vs implied 0.13 → +38% edge.
- **Live-run gotchas:**
  - The Odds API rejects `commenceTimeFrom` with milliseconds — `toISOString()` needs
    `.replace(/\.\d{3}Z$/, "Z")` (done in `client.ts`).
  - Odds aren't posted for every bookmaker until ~days before kickoff — the
    `bookmakers=bet365,sportybet,betway` filter may return just one book early on.
  - Re-running `POST /api/ingest` upserts by snapshot id; counts reported are per-call batches.

## 13. Corners Predictions (V1 — isolated track)

**Status:** Trained, ingested, UI live. NOT connected to the EV engine.

**What it does:** Predicts per-team corner counts for upcoming matches and computes over/under line probabilities (O3.5, O4.5, O5.5, O6.5). No odds comparison, no EV filtering — raw model output only.

**Data source:** football-data.co.uk historical corner data (HC/AC columns) — 14,007 matches across 11 leagues (EPL, Championship, La Liga, Bundesliga, Serie A, Super Lig) from 3 seasons (2012, 2020, 2021).

**Model:** Two XGBoost regressors (one for home team corners, one for away). Features:
- Team's corner rate (venue-filtered: home corners at home, away corners away)
- Opponent's corners conceded (venue-filtered)
- Baseline = avg of team rate + opponent conceded rate
- Recency-weighted form on corner counts (EW decay 0.85)
- Shots on target (proxy for attacking intent → corners)
- Rest days between matches
- Sample size (confidence proxy)

**Honest backtest (time-ordered 80/20 split, V3 with V2 features):**
- Home MAE: 1.688 corners | Away MAE: 1.682 corners (was 1.82/1.80 in V1)
- R²: 0.34 (was 0.25 in V1 — 36% improvement)
- 80% CI: ±2.1 corners
- Line accuracy: Over 3.5 → 73%, Over 4.5 → 69%, Over 5.5 → 74%, Over 6.5 → 80%
- **70% consistency rule: 39% — BELOW threshold.** Model is not reliable enough for blind betting.
- The line probabilities are the useful output — compare to bookmaker's implied probability to find edge.
- Top feature: H2H corner history (27% importance) — knowing how many corners teams get against each other is the strongest signal.

**Isolation:** Completely separate from h2h/totals:
- Separate D1 table: `corners_predictions`
- Separate training script: `model/scripts/train_corners.py`
- Separate prediction script: `model/scripts/predict_corners.py`
- Separate TypeScript module: `packages/core/src/corners.ts`
- Separate UI page: `/corners`
- No shared models, no shared predictions, no shared bets

**Pipeline:** GitHub Actions predict job → Python model → JSON → POST `/api/corners/ingest` → D1 → UI

**API:**
- `GET /api/corners` — returns all corner predictions (no auth needed)
- `POST /api/corners/ingest` — ingests predictions (requires PREDICT_SECRET)

**Secret:** PREDICT_SECRET starts with `odk` — stored in both Cloudflare Worker secrets and GitHub Actions secrets.

**Gaps / future work:**
- Deep injury history (only starting-XI confirmation available via API-Football free tier)
- Weather data (real factor but not worth complexity until baseline proves signal)
- Live/in-play corner betting (separate infrastructure needed)
- Match-total corners (both teams combined) — V1 is individual team totals only
- 70% consistency not met — model needs more features (tactical data, formation info) to improve

**Data expansion path (to improve MAE from 1.69 toward 0.7-1.3):**
- FBref has match-level corner data for 10+ seasons per league, but blocks cloud servers
- Run `model/scripts/fetch_fbref_corners.py` locally on your machine to download data
- Each season adds ~380 matches (EPL) or ~306 (Bundesliga) of training data
- Going from 3 seasons to 10+ seasons should significantly improve MAE
- API-Football free tier (100 req/day) can also provide match statistics including corners
- Key: more seasons = more team corner history = better recent-form features

---

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

---

## 12. Pass 3 — Mobile Feed, Search & Settlement Upgrades

1. **Mobile Responsive Slips & Bets:**
   - Slips cards stack vertically on small screens without wrapping/colliding.
   - Bets log replaced horizontal table scrolling on mobile with clean finance-grade activity cards.
2. **Instant Search & Detailed Drawers:**
   - Real-time search by team name, league, or pick.
   - Expandable "View Details & Insights" drawer showing true Model Probability, Bookmaker Implied Probability, Potential Payout ₦, and CLV.
3. **Settlement Architecture:**
   - **Batch Cloud Sync (`/api/settle`):** 1-tap `🔄 Auto-Settle All` button on `/bets` and `/settings` queries bookmaker full-time scores and settles all pending bets simultaneously.
   - **Compact Manual Settle:** Single-selector dropdown on `/settings` that keeps the card at a fixed ~140px height regardless of how many bets are logged.
   - **In-card Quick Settle:** Direct score inputs inside the details drawer on `/bets`.
4. **Automated Monthly Retraining:**
   - GitHub Actions workflow runs monthly on the 1st (`.github/workflows/retrain-monthly.yml`) to fetch fresh historical data, retrain XGBoost/sklearn models, generate calibrated predictions, and ingest into the Cloudflare Worker DB automatically.
