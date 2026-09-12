# OddKet — Handoff Document

> **This is the living handoff doc.** It is updated at the end of every build pass and must
> be kept current whenever the repo changes hands. If you are picking this project up,
> start here, then read `OddKet_PRD.md` and `OddKet_Build_Prompt.md`.

**Last updated:** Pass 21 — **model-only accumulators** on the slips page *and* as a Telegram `/modelonly` command: the unpriced markets (O1.5 / team-to-score) combined on probability alone, with break-even odds and no payout claim.

---

## 13. Micro markets — Over 1.5, Team To Score, Double Chance 12 (Pass 13)

Three new markets built on the existing h2h/totals pipeline. Trained on the same
`model/data/historical.json` (football-data.co.uk EPL/La Liga/Bundesliga/Serie A
2019–2026), honest time-ordered holdout 2025-02-06 → 2026-05-24 (2,025 matches).

### Models (all XGBoost + isotonic calibration, `model/scripts/train_micro.py`)

| Market | Selection | Base rate | Brier (cal) | Hit rate @ p≥0.70 | n@≥0.70 |
|---|---|---|---|---|---|
| `ou15` (Over 1.5 goals) | over | 76.2% | 0.179 | **77.4%** | 1,758 |
| `team_home_goals` (home scores) | yes | 76.5% | 0.173 | **78.6%** | 1,782 |
| `team_away_goals` (away scores) | yes | 71.0% | 0.199 | **77.1%** | 1,085 |

Artifacts: `model/models/{ou15,team_home,team_away}_{model,calibrator}.joblib` +
`micro_meta.json`. Predictors: `predict_micro.py` (876 rows/fixture-cycle) and
`predict_dc12.py` (146 rows — derived, no model).

### DC12 — derived, no new model

`dc12` (home OR away — no draw) is the sum of the calibrated h2h home + away
probabilities from the existing model. **The EV engine prices it off the book's
own 1X2 odds** (books construct DC12 from their 1X2 book, so no dedicated DC
odds feed is needed — `ev.ts` maps `dc12` → the fixture's `h2h` snapshots and
derives the fair DC price from the book's own 1X2 book). It needs a full 1X2
book to be priced; incomplete books are skipped.

### Honest caveats

- These markets have **no live odds feed from The Odds API** (bulk endpoint only
  prices h2h + totals 2.5). The EV engine evaluates them against the h2h/totals
  odds it already stores (team-goals lines like "Over 0.5 home goals" map onto
  the h2h book's implied scoring probability; O1.5 maps onto the totals book).
  Like corners, the user can compare against their bookmaker manually.
- `team_away` has the lowest base rate (71%) — away teams score less — so it
  flags fewer picks at p≥0.70. That's the honest market, not a bug.

---

## 14. EV engine fix — DC12 + model-only predictions (Pass 14)

Fixed `allPredictionsAsLegs` in `ev.ts` so the "Show All" view on the slips
page actually surfaces DC12 and the three model-only markets (ou15,
team_home_goals, team_away_goals).

### What was broken

- `allPredictionsAsLegs` silently dropped ou15/team_home_goals/team_away_goals
  because these markets have NO bookmaker odds in The Odds API bulk feed —
  `marketOdds.length === 0` caused an early `continue`.
- DC12 was missing from "Show All" because `allPredictionsAsLegs` had no h2h
  odds derivation logic (unlike `flagSlips` which already handled it).

### What was fixed

- **DC12 in Show All:** derived from h2h market odds (same as flagSlips).
- **Model-only markets:** ou15/team_home_goals/team_away_goals now appear with
  an amber "📊 Model Only" badge, no odds/stake UI, non-selectable for
  multiples. The user compares the model probability against their bookmaker's
  line manually.
- **D1 settings:** all 12 leagues restored (League Two + Turkish Super Lig
  were missing), minBookmakers=4 restored, all 6 markets enabled.
- **Worker deployed** with the fixed EV engine.

### What DC12 looks like on slips

```
Cambridge United vs Reading — No Draw (DC12)
  🟢 +3.7% EV  |  Win Prob: 75.6% (68%–83% CI)
  @1.39  ₦329   [Log Bet]
```

### What model-only predictions look like in Show All

```
Arsenal vs Chelsea — Over 1.5 Goals
  📊 Model Only  |  Win Prob: 85.2% (79%–91% CI)
  [Check bookmaker]    ← no Log Bet button
```

---

## 15. Multiple crash fix + tomorrow filter + micro-market validation (Pass 15)

### The multiple crash — root cause + fix

Toggling Multiples ON froze/crashed the slips page. Root cause: `suggestParlays`
(`packages/core/src/parlay.ts`) generated EVERY combination of sizes 2..maxLegs
over the full flagged-singles pool — 108 live legs × sizes 2–6 = **2.03 billion
combinations**, computed synchronously on the main thread on every render.

Fixed by bounding the search:
- Pool capped to the **top 18 legs by edge** (suggestions are candidates for
  manual review — beyond the strongest edge is noise).
- Odds guards: only legs with finite odds > 1 enter the pool (model-only
  predictions with odds=0 can never poison the parlay math).
- New worst case ≈ 31k combos → <5 ms.

### Tomorrow filter

Slips and corners pages now have an **All / Today / Tomorrow / This Week** time
filter — "Tomorrow" is the next UTC day (today+1d → +2d).

### Micro-market naming aligned with bookmakers

"Home/Away team to score" is exactly the **Team Goals Over 0.5** line that
bookmakers price (SportyBet: Goals → Home/Away Team Goals). Labels updated to
`Home to score (O0.5 goals)` / `Home not to score (U0.5 goals)` etc. in
`marketLabel` + the Settings market list so users can find the line on any book.

### Honest validation of the micro markets (holdout 2025-02 → 2026-05, 2,025 matches)

| Market | Base rate | Hit @ p≥0.65 | @0.70 | @0.75 | @0.80 | n@0.80 |
|---|---|---|---|---|---|---|
| ou15 (Over 1.5) | 76.2% | 76.4% | 77.4% | 80.2% | 82.0% | 649 |
| team_home (home scores) | 76.5% | 77.5% | 78.6% | 80.9% | 84.0% | 1,002 |
| team_away (away scores) | 71.0% | 75.5% | 77.1% | 80.7% | 86.2% | 261 |

**Not home-bias:** away has the LOWEST base rate (71%) yet the HIGHEST hit rate
at p≥0.80 (86.2%) — the model discriminates, it does not just say "home". The
monotonic rise (higher threshold → higher hit rate) is the signature of honest
calibration, not overfit. Best staking band: **p ≥ 0.75** (≈80%+ hit);
**p ≥ 0.80** for the highest-confidence plays (82–86%), but n shrinks — always
require bookmaker odds > 1/p before staking.

---

## 16. Intelligent parlay picker + UI/mobile pass (Pass 16)

### suggestParlays v2 — risk-tiered, probability-first (replaces EV-combo picker)

The old picker ranked combinations by EV, which floats longshots (high edge,
low probability) to the top — producing parlays that mathematically never
land. New algorithm in `packages/core/src/parlay.ts`:

- Pool = flagged singles sorted by **model probability descending** (not EV).
- Three tiers, each built greedily from the next highest-probability
  independent leg (correlation checked incrementally — same-match and
  same-league same-kickoff legs skipped):
  - 🟢 **Safe accumulator** — 2–4 legs, legs ≥ 68%
  - 🟡 **Balanced accumulator** — 5–8 legs, legs ≥ 58%
  - 🔴 **Risky accumulator** — 9–20 legs, legs ≥ 50% (honest warning shown:
    big multiplier = low chance of ALL landing)
- One suggestion per tier, ranked by **chance to land** (combined
  probability), not by EV. 20-leg risky is built from the highest-probability
  legs available so it's the "risky but live" profile the owner asked for.
- Verified: 60-leg pool → 2ms, 3 suggestions; 200-leg pool → 20-leg risky at
  ~2.9% combined chance; odds=0 model-only legs can't poison the pool.

### Corners page — mobile-first revamp

- Team cards now full-width rows (stack on mobile, 2-up on sm+) with Home/
  Away chips, big corner count, 80% range, "Best:" line callout.
- Line probabilities moved to **horizontally scrollable pill strips**
  (`.scrollbar-none`) — no more 14 cramped badges crammed into 2 columns.
- Total Expected moved to a highlighted badge; league goldmine note moved
  under the match header.

### Mobile bottom nav — 5 tabs + More sheet

Was 7 items in the bottom bar (cluttered). Now: Overview, Slips, Corners,
Bet Log, Settings + a **More** button opening a bottom sheet with
Calibration and Backtest (with descriptions). Desktop top bar unchanged.

### e2e suite repaired (pre-existing breakage, now 104/104)

- `test/e2e.mjs` MIGRATIONS list was missing `0001_corners.sql` → seed
  crashed on `no such table: corners_predictions`.
- `d1-adapter.mjs` returned SYNC results but the worker (since the Sep 8
  pipeline fix) calls `.all().catch()` — made `all/first/run` async to match
  the real D1 API.
- `losingScore` for a **draw** selection returned 1-1 (a draw = the leg
  WINS) — fixed to 2-0 so a draw leg genuinely loses.

---

## 17. Pass 17 — mobile UX + virtualization pass

### Bottom nav — 4 primary tabs + More sheet (no 2-row wrap)

Previous pass had 5 links + More = 6 items in a 5-col grid → wrapped into two
rows on mobile and More/Settings vanished on desktop. Now:
- **Mobile:** Overview, Slips, Corners, Bet Log + More (sheet holds Settings,
  Calibration, Backtest). 5 items total, single row, no wrap.
- **Desktop:** unchanged top bar; More items render inline.

### Corners page — fits 360px screens

- Filter bar now scrolls horizontally instead of wrapping/overflowing.
- Cards constrain to viewport width; line strips are horizontally scrollable
  pills (`.scrollbar-none`) so nothing forces page-level zoom.
- Added a search input (team / league) to the corners page.

### Multiple builder UX

- Panel moved ABOVE the prediction list on mobile (CSS order) — no more
  scrolling through hundreds of slips to see suggestions.
- `suggestParlays` now returns **multiple suggestions per tier** (default 6)
  using varied pool windows, so Safe/Balanced/Risky each show a few distinct
  tickets instead of one.

### Virtualized slips list

- New `apps/web/components/virtual-list.tsx`: windowed renderer (~10 rows
  mounted, overscan 6) — no dependency added, pure React.
- "Show All" toggle on `/slips` now renders ~1,700 rows through the
  VirtualList: only in/near-viewport rows are mounted, so the toggle and
  scroll stay instant. Works with the existing grouping/filter/search.
- Avoids `contain: strict` so sticky elements keep working.

### Verification (Pass 17)

- `pnpm --filter @oddket/core typecheck` green
- `pnpm --filter web typecheck` + production build green
- worker e2e **104/104** passing
- Committed `2973d5d` (no co-author)

---

## 18. Pass 18 — PWA reliability, share-as-image, Telegram share, skeletons, hero picks

### PWA — install reliability

- `public/sw.js` bumped to `oddket-v2` cache:
  - **Install:** precaches the app shell (`/`, `/slips`, `/corners`, `/bets`,
    manifest, icons) so the installed PWA opens instantly and works offline
    even on first launch.
  - **Fetch:** hashed static assets (`/_next/static/*`, `/icons/*`) are now
    cache-first (stale-while-revalidate) so the installed app renders fully
    offline; navigations stay network-first so fresh deploys always win.
- Old `oddket-v1` caches are purged on activate.

### Share-as-image

- New `apps/web/lib/slip-image.ts`: zero-dep canvas renderer that draws the
  slip as a dark-themed PNG (header, per-leg rows with odds/stake/prob,
  combined-odds footer). Client-side only; returns a data URL.
- `/slips` multiple builder: **📤 Share slip** button renders the image and
  opens a panel with preview + **Save** (download), **Telegram**, and
  **Share…** (native share sheet with the image attached).

### Telegram share (backend-sent)

- Worker `POST /api/telegram/share`: forwards a text + optional base64 PNG
  data URL to your chat via the Bot API `sendPhoto`/`sendMessage`. Requires
  two new worker secrets:
  - `TELEGRAM_BOT_TOKEN` — bot token from @BotFather
  - `TELEGRAM_CHAT_ID` — your chat id (e.g. via @userinfobot)
  - Not configured → 501 with a clear message (UI shows the error instead of
    failing silently). No client-side keys anywhere.
- Client: `api.telegramShare({ text, imageDataUrl })` in `lib/api.ts`.

### Skeleton loaders

- `ui.tsx` gained `Skeleton`, `PageSkeleton`, `SkeletonStatGrid`,
  `SkeletonCard`, `SkeletonList` (pulsing placeholders matching the card
  layout). All 7 pages (Overview, Slips, Corners, Bets, Calibration,
  Backtest, Settings) now render page-shaped skeletons instead of the bare
  spinner while data loads.

### Home screen hero picks

- Overview now shows a **Today's Picks** hero row above the stat grid:
  💎 **Best edge** and 🎯 **Highest probability** from today's flagged slips,
  each card showing fixture, pick, odds, win prob, EV, and kickoff — tapping
  jumps to `/slips`. Friendly nudge card when nothing is flagged today.

### Verification (Pass 18)

- core + web + worker typechecks green
- web production build green
- worker e2e **104/104** passing
- Committed (no co-author)

---

## 19. Pass 19 — Telegram bot (@oddketbot)

The bot is a read-only front desk for the model: it surfaces what the engine has
*already* flagged and never places, logs, or auto-bets anything.

### Files

- `worker/src/telegram.ts` — bot module: Bot API sender, command router,
  message builders, alert broadcasts, webhook registration.
- `worker/src/db.ts` — `upsertTelegramChat`, `setTelegramDigestEnabled`,
  `listTelegramChats`.
- `worker/migrations/0006_telegram.sql` — `telegram_chats` table
  (`chat_id`, `label`, `digest_enabled`, `created_at`, `last_seen_at`).

### Routes

| Route | Purpose |
|---|---|
| `POST /api/telegram/webhook` | Receives every message/button tap. Verified against the `X-Telegram-Bot-Api-Secret-Token` header when `TELEGRAM_WEBHOOK_SECRET` is set; replies are sent via the Bot API inside `waitUntil`. |
| `POST /api/telegram/setup` | Registers the webhook at this worker's own origin + uploads the `/` command list. Requires `PREDICT_SECRET`. |
| `POST /api/telegram/digest` | Pushes the daily digest to every subscribed chat. Fired by GitHub Actions, gated by `PREDICT_SECRET`. |
| `POST /api/telegram/share` | (Pass 18) forwards a rendered slip image + text to the configured chat. |

### Commands

`/picks` (flagged singles, edge-ranked) · `/multiples` (safe · balanced · risky
accumulators) · `/corners` (team corner line probs) · `/leagues` (coverage +
what's flagged) · `/settled` (last 7 days, net P&L) · `/status` (model + data
health) · `/alerts` (toggle notifications) · `/menu` (inline-keyboard buttons) ·
`/help`. Plain text ("hi") shows the menu rather than an "unknown command" error.

### Notifications

- **Daily digest** — 07:00 UTC (08:00 WAT) via a new entry in
  `.github/workflows/cron.yml` → `POST /api/telegram/digest`. Top 5 flagged
  picks + the three accumulator tiers.
- **Settlement alerts** — `/api/settle` now also calls
  `notifyTelegramSettlements` after a run that changed something (alongside the
  existing web-push). Reports only the last 3 hours so quiet re-runs stay quiet.
- Recipients = every row in `telegram_chats` with `digest_enabled = 1`, plus
  `TELEGRAM_CHAT_ID`. A chat is registered automatically the first time it talks
  to the bot; `/alerts` toggles its preference.

### Secrets (values deliberately NOT committed)

| Secret | Where |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Cloudflare Worker secret (from @BotFather) |
| `TELEGRAM_CHAT_ID` | Cloudflare Worker secret (owner chat: `6559982001`) |
| `TELEGRAM_WEBHOOK_SECRET` | Cloudflare Worker secret — also sent to Telegram as `secret_token` |

Read them back with `wrangler secret list` (names only) — Cloudflare never
returns secret values.

### Deployed state (verified)

- `wrangler d1 migrations apply oddket --remote` → `0006_telegram.sql` applied.
- Worker deployed (`oddket-worker`, version `a870de8b`).
- Webhook registered; `getWebhookInfo` → `pending: 0`, `last_error: null`.
- D1 `telegram_chats` contains `6559982001 · Eleazar Ogoyemi (@codeleyoungtech) · digest_enabled = 1`,
  which also proves the webhook → worker → D1 path works end to end.
- Typecheck green, e2e **104/104** passing.

### ⚠️ Gotcha found + resolved during this pass

**The `PREDICT_SECRET` literal recorded in section 13 was STALE**, so
`POST /api/telegram/setup` returned `{"ok":false,"error":"Unauthorized."}` and the
webhook had to be registered directly against the Bot API.

Diagnosis: GitHub Actions held the *correct* (Sep 9) value while the doc and the
doc-derived attempts used the old one — which is why the scheduled crons kept
authenticating fine and only the doc-led path failed.

**Resolved Sep 10, 2026:** `PREDICT_SECRET` rotated to a fresh value, set
identically on Cloudflare and GitHub Actions, and the stale literal removed from
this doc. Verified: old value → `401`, new value → `200`, webhook healthy.
**Never record the value here again** — see section 13 for the rotation command.

---

## 20. Pass 20 — secret rotation + share from suggested accumulators

### PREDICT_SECRET rotated (Sep 10, 2026)

The value committed in this doc (`odk85c6…`) was **leaked by being in the repo**.
Rotated to a fresh `odk…` value, set identically on the Cloudflare Worker and
GitHub Actions. Verified: old value → `401`, new value → `200`. The literal was
removed from section 13 — that section now documents *where* the secret lives
and the exact rotation command instead of its value.

**Leak audit result:** `docs/HANDOFF.md` was the only tracked file containing a
secret-shaped literal. `.gitignore` already covers `.dev.vars`, `.env`,
`.env.local` and `.env.*.local`; no env files are tracked.

### Share any accumulator as an image

`/slips` previously let you share the **manual builder** selection only — each
*suggested* accumulator had a single "Log parlay" button, so the only way to
share a suggested tier was to hand-pick all of its legs back into the builder.

- Each suggestion card now has **📤 Share** beside "Log parlay".
- `openShare(legs?, combined?)` is parameterised: no args shares the manual
  selection, passing legs+stats shares that exact ticket.
- `shareState` now records the `legs` + `combined` it rendered, so the copy
  text, Telegram caption, and native share sheet all describe the ticket that
  was actually rendered rather than the builder's current selection.
- The share panel auto-scrolls into view (it sits lower in the builder than
  the suggestion cards).

### Verification (Pass 20)

- web typecheck + production build green
- worker e2e **104/104** passing
- rotation verified against the live worker (401 old / 200 new)

---

## 21. Pass 21 — model-only accumulators

### Why these markets can't go in the EV-checked builder

An accumulator needs two independent things: **probability** (the chance all legs
land — we have it) and **payout** (what the bookmaker pays — we don't). A parlay's
multiplier *is* the product of its leg prices, so a leg with no price has no
multiplier, no EV, and no Kelly stake. Putting them in the priced builder would
mean fabricating the payout number the user stakes against — so they stay out,
by necessity rather than by choice.

Measured on the live worker: **1,002 model-only predictions across 167 scheduled
matches** (the feed requests only `h2h,totals`, so `ou15` / `team_home_goals` /
`team_away_goals` never get an odds row).

### What was added

`packages/core/src/parlay.ts` — `suggestParlays(..., pricing: "priced" | "model-only")`:

- `"priced"` (default, unchanged) — only legs with `odds > 1`.
- `"model-only"` — only legs with **no** price (`!(odds > 1)`). Same greedy
  high-probability selection and the same tier/correlation gate. `combinedOdds`,
  `ev` and `stake` are forced to `0`; `fairOdds` (= 1/p) is kept because it is
  derived purely from the model probabilities.
- `ParlaySuggestion.priced: boolean` was added so consumers can tell the two
  kinds apart. All existing callers (slips page, Telegram) get `priced: true`.

`apps/web/app/slips/page.tsx` — a new **Model-only accumulators** block inside
multiple builder, visually separated (amber border) with a `⚠ NOT EV-CHECKED`
badge. Per ticket: each leg's model probability + "check bookmaker", the true
joint chance, and the **break-even odds** (the price the bookmaker must beat).
No multiplier, no EV, no stake, no log button.

### Correlation — why this is safe to combine

O1.5 and both team-to-score lines in the **same** fixture are strongly dependent
(if both teams score, O1.5 is nearly guaranteed). The existing strict
**same-match** rule already blocks that, so at most one leg per match can be
chosen. Verified: 167 eligible matches in every tier (safe/balanced/risky), so
all three tiers fill comfortably — 20-leg risky included.

### Telegram `/modelonly`

- `modelOnlyMessage()` in `worker/src/telegram.ts` builds from the raw prediction
  rows (`allPredictionsAsLegs(...).filter(l => !(l.odds > 1))`) rather than
  `flagSlips`, which requires a price to compute edge against.
- Shows **one ticket per tier** (highest-probability of each) — not three of the
  same tier — with each leg's probability, the true joint chance, and the
  break-even price. Legs capped at 8 per ticket with a "+N more" line so the
  message stays well under Telegram's 4096-char limit.
- Added to `/help`, the inline menu (row 4, beside 🧾 Settled), and
  `setMyCommands` autocomplete.
- Verified Sep 10, 2026 by POSTing a synthetic `/modelonly` update through the
  live webhook: `200`, handler ran (`telegram_chats.last_seen_at` advanced),
  `getWebhookInfo` → `pending: 0`, `last_error: none`.
- Note: the web section is gated by `multiplesEnabled` (it lives inside the
  multiple builder); the bot command is **not** gated, since it is explicit user
  intent and makes no staking claim.

### Still open

- `settings.maxMultipleLegs` (currently 6) is **not** enforced on the model-only
  tickets; the tiers cap at 4/8/20. Fine for a no-stake display, but worth
  aligning if it ever gains a stake field.

### Verification (Pass 21)

- core + web typechecks green, production build green
- worker e2e **104/104** passing
- live-data check: 1,002 model-only legs, 167 eligible matches per tier,
  strongest legs O1.5 95.3% / team-to-score 93.6%

---

## 22. Pass 22 — model-vs-market audit, list UX, history page, settle fix

### 22.1 🔴 THE BIG FINDING: both live models are worse than the closing line

This pass started as "validate the to-score models" and turned up the single
most important fact about the project so far. Measured on the **same holdout the
models report** (2025-02-06 → 2026-05-24, n=2025), Brier score (lower is better):

| | base rate | market (open) | market (close) | **our model** |
|---|---|---|---|---|
| **h2h (3-way)** | 0.6527 | 0.5806 | **0.5794** | 0.5899 |
| **O/U 2.5** | 0.2496 | 0.2428 | **0.2414** | 0.2455 |

- h2h skill vs. base rate: **+9.6%** (a genuinely competent model)
- h2h skill vs. **closing line: −1.8%** ← the market is *sharper than us*
- O/U skill vs. **closing line: −1.7%** ← same story

**This is the root cause of the negative backtests.** ROI −8.9% (h2h) and −3.5%
(OU) with *positive* claimed edge (+5.3% / +5.4%) is not bad luck — it is the
arithmetic consequence of a model that is slightly worse than the price it is
trading against. Wherever the model "disagrees" with the close, it is more
likely that the model is wrong than that the market is.

Calibration is **not** the problem: the h2h reliability curve tracks closely
(predicted 0.1612 → observed 0.1596, 0.254 → 0.2434, 0.3392 → 0.3381,
0.5477 → 0.5651). The probabilities mean what they say. The model is simply not
sharp enough to beat a ~5% margin on top of a sharper opponent.

**Consequence for the paper trade:** measure CLV, but expect it to confirm what
the holdout already shows. Do not read "+5% edge" as an expected profit.

**What this does *not* kill:** the corner markets. Niche-line corners and
"most corners" are priced badly by bookies in exactly the leagues we cover,
which is why the model-only corner tool remains the most credible candidate for
real edge in the whole app. That is the direction to push, not more 1X2.

Reproduce with a throwaway script that normalizes `1/odds` over the 3-way book
and compares Brier on the holdout window against `models/model_meta.json`.

### 22.2 To-score micro model — validated, NOT faulty

The owner suspected Home/Away to score was broken. It is not. `micro-xgb-v1`,
2025-match holdout:

| market | base rate | Brier | hit @ p≥0.70 | @ p≥0.80 |
|---|---|---|---|---|
| Home to score (O0.5) | 76.49% | 0.1721 | 78.9% (n=1764) | 83.8% (n=1020) |
| Away to score (O0.5) | 71.01% | 0.1992 | 76.9% (n=1044) | 85.3% (n=320) |
| Over 1.5 goals | 76.25% | 0.1787 | 76.9% (n=1816) | 83.6% (n=615) |

Reliability is tight (home-to-score 0.8–0.9 bin → 81.8% observed; away 0.7–0.8 →
73.2%). **These are well-calibrated probabilities.**

Attempted improvement this pass: added goal-volume features (`ou_combined_avg_goals`,
`ou_home/away_scored_rate`, `ou_home/away_conceded_rate`, `ou_h2h_avg_total`,
`ou_poisson_expected_total`) to `train_micro.py` + `predict_micro.py`, and
replaced the old ±1.28σ interval with a **calibration-derived** interval. Result:
**metrics essentially flat** (team_home Brier 0.1725 → 0.1721, acc 76.59% →
76.54%; team_away 0.1988 → 0.1992). Honest read: the model was already at its
information ceiling for this target — which makes sense, since "does a team
score at all" is mostly a function of match goal volume, which the Poisson
features already captured.

The model-only micro markets need **fair odds > 1/p** to be worth anything:
home-to-score at 82.8% needs a bookmaker price **above 1.21**; at 1.15 it is a
losing bet (0.828 × 1.15 = 0.952). Bookies typically price it 1.20–1.30, i.e.
at or below break-even.

### 22.3 Virtualization replaced with native CSS (not a JS windowing lib)

The previous `VirtualList` windowing component was janky: it guessed row heights
(`estimatedHeight`), so variable-height cards made the scroll position jump.
**Deleted** `apps/web/components/virtual-list.tsx` entirely and replaced it with
`content-visibility: auto` (`.cv-row` in `globals.css`) plus
`contain-intrinsic-size: auto 200px`.

Why this is the correct tool: the browser still lays out real cards, so heights
are always exact — no estimate, no jump — while layout/paint for off-screen rows
is skipped natively. `contain-intrinsic-size` keeps the scrollbar honest for
never-measured rows. Result: ~1,700 rows stay in the DOM untouched by JS, and
scrolling is smooth.

### 22.4 Share from a *suggested* accumulator was actually broken

The share panel was rendered **inside** the `selectedLegs.length > 0` branch of
the manual builder. Pressing 📤 on a *suggested* ticket set `shareState` but the
panel did not exist → the button appeared to do nothing. Fixed by hoisting
`sharePanel` above both branches so it is always rendered. Also bumped
`suggestParlays` to `perTierCount = 2` for the risky tier (was 1).

### 22.5 Multiple builder: matchday scope ("build the day's card")

Added a **Matchday** filter (All / Today / Tmrw / Week) that scopes the builder
pool by `fixture.commenceTime`, with a "N legs in scope" readout. Both the priced
suggestions and the model-only tickets respect it. This is what lets you build
several separate accumulators across one matchday instead of mixing legs from a
week-long window.

### 22.6 New page: `/history` — Past predictions graded (no logging required)

Validation can no longer depend on manually logging bets. `apps/web/app/history/page.tsx`
lists **every prediction made for a fixture that has already kicked off**, graded
against the recorded final score. Shows: model-pick hit rate, **Brier score over
every settled row** (not just picks), and a per-market scoreboard
(picks / won / hit rate / Brier). Filters: 7d / 30d / all, league, market,
settled-vs-pending, search. Linked from desktop nav + the mobile More sheet, and
added to the SW precache (`oddket-v3`).

### 22.7 Corners: safe band instead of the generic "Under 11.5"

The old `bestTotalCornerLine` picked the line **furthest from 50%**, which always
lands on a worthless tail — "Under 11.5" · 88% at near-zero odds, repeated for
every fixture. Deleted `bestCornerLine` / `bestTotalCornerLine` and added:

- `cornerSafeBand(expected, sigma, lines, minProb=0.7)` — the **most aggressive
  Over and most aggressive Under that still clear 70%**. If neither does, the UI
  says *"genuine coin-flip"* instead of inventing a pick.
- `totalCornerSafeBand(totalExpected)` / `teamCornerSafeBand(expected, side)`
- `mostCorners3Way(homeExp, awayExp)` — a 1X2-style read on the corner count,
  modelled as Normal(μ = H−A, σ² = HOME_SIGMA² + AWAY_SIGMA²) with a ±0.5
  continuity window for the draw. Bookies price this poorly in niche leagues.
- Removed the unused `LEAGUE_GOLDMINES` badge block (it was pure decoration and
took space on mobile). The full line ladder now renders on **phones** too — it
used to be `hidden sm:block`, which is why only one lazily-picked line ever showed.

### 22.8 Auto-settle cron — root cause was odds-credit exhaustion

Symptom: bets stayed pending for days, settling only by hand. Root cause: the
settle run pulled `/scores` for **every selected league + every tennis
tournament on every run** — ~1,900 requests/month against a 500/key free tier, so
every key 429'd and the run silently returned "0 completed".

Fix in `worker/src/odds/settle.ts`: new `relevantSports(env, now, windowDays=3)`
queries D1 for only the sports that **actually have unfinished business**
(a pending bet on a kicked-off fixture, or a not-yet-finished fixture inside the
window). Returns early with an explicit note when there is nothing to settle.
`SettleResult` now reports `scoresPulls` + `sportsQueried` for diagnosis, and a
failed key logs an explicit "credit budget likely exhausted" line instead of
failing silently.

`cron.yml` also gained a `workflow_dispatch` **choice input**
(ingest / settle / closing / digest) so settle can be re-run on demand after a
match finishes, without waiting for a slot or handling `PREDICT_SECRET` locally.

### 22.9 📌 Selection guidelines for a ~90% hit-rate ticket (owner-requested)

Recorded here at the owner's request. **The honest framing first:** a 90% *hit
rate* is achievable; 90% hit rate **is not** the same as profit. `EV = p·odds − 1`,
so a 90% leg needs **odds > 1.111** to make money. At odds 1.05 a 90% leg returns
0.90 × 1.05 = 0.945 → −5.5% per bet even though it wins 9 times in 10.

Rules for assembling a high-confidence ticket:

1. **Probability floor.** Only legs the model rates ≥ **0.90** (for a singles
   "banker" list) or ≥ 0.95 (for legs meant to be stacked).
2. **Price floor.** Require `bookmaker odds > 1/p` always. At p=0.90 that is
   odds > 1.111; at p=0.95, > 1.053. Below that, skip it no matter how "safe".
3. **Joint-probability budget.** For a target hit rate H, the product of leg
   probabilities must stay ≥ H: with n legs each at p, need `p^n ≥ H`.
   - H=0.90: 1 leg ≥ 0.900 · 2 legs ≥ 0.949 each · 3 legs ≥ 0.965 each
   - H=0.80: 1 leg ≥ 0.800 · 2 legs ≥ 0.894 · 3 legs ≥ 0.928 · 5 legs ≥ 0.956
4. **Stop rule.** Add legs highest-probability-first, then **stop before** the
   next leg would push the running product below H. Never reorder to chase odds.
5. **No longshots.** A single 0.25 leg destroys the budget — at H=0.90 the
   *average* leg probability must be ≥ 0.90^(1/n), so there is no room for one.
6. **One leg per match (strict).** Same-match legs are correlated and the engine
   blocks them; double-counting one event inflates the apparent joint chance.
7. **Only EV-checked markets** for anything you stake against a price. The
   model-only markets have no price feed, so their "break-even odds" is the only
   decision rule — treat them as a line-shopping tool, not a bet.
8. **Verify before trusting.** Read the realized hit rate per bucket on
   `/history` and `/calibration`; a bucket is only "90%" once ~100+ settled
   samples say so.

Realistically available ~90% candidates (to be validated on `/history` before
use): *at least one goal in the match* (~92% historically in top-division
football), and the ≥0.90 legs the micro model already produces. Note that most
of these are exactly the markets the odds feed **cannot** price for free — which
is the honest tension: the safest outcomes are the cheapest, and often unlisted.

### 22.10 🏀 Parked: basketball (owner's next major idea)

Owner intent, recorded so it is not lost: after football has run live for ~a
week, add **basketball** in the same shape as football — mostly leagues/games
bookmakers price generically, where a 70%+ model could find value. Notes for
whoever picks this up:

- Odds feed uses the same The-Odds-API keys (`basketball_nba`,
  `basketball_euroleague`, plus regional/college keys); **check the credit budget
  first** — the football settle bug in §22.8 was a credit-budget bug.
- Free/statistical route mirrors the corner pipeline: point totals and spreads are
  continuous, so a Normal/Poisson-style total model + a line-ladder
  (`overProb`, safe-band style) transfers directly.
- Niche leagues (EuroLeague, NBL, NCAA mid-majors) are the inefficient-pricing
  candidates — same thesis as niche corner lines.
- **Do not repeat the 1X2 mistake:** validate against the *closing* line on a
  time-ordered holdout before building any UI. §22.1 is the cautionary tale.

### Verification (Pass 22)

- core / web / worker typechecks all clean
- production build green
- worker e2e **104/104** passing
- micro model retrained; `micro_meta.json` + all `team_*` / `ou15` joblibs rewritten
- new `/history` route linked in nav + SW precache

### Still open

- **The model does not beat the close (§22.1).** The highest-value work in the
  repo is either (a) corner/niche markets where the close is soft, or
  (b) blending model output with market implied probabilities and betting only
  the residual disagreement — and validating that honestly before shipping.
- `settings.maxMultipleLegs` still not enforced on model-only tickets.
- 4 pre-`§21` logged bets still show as untagged in `/api/bets` while the
  dashboard counts them as "model" — must be resolved before the paper-trade
  numbers are trusted.

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

## 13. Corners Predictions (V5 — 8-layer feature system)

**Status:** Trained, ingested, UI live. NOT connected to the EV engine.

**What it does:** Predicts per-team corner counts for upcoming matches and computes Negative Binomial line probabilities. Supports team lines (O2.5–O8.5) and total match corner lines (O5.5–O12.5). No odds comparison, no EV filtering — raw model output only.

**Data source:** 17,351 matches from football-data.co.uk (12 seasons × 4 leagues: EPL, La Liga, Bundesliga, Serie A, 2014–2026). Includes shots, SOT, fouls, cards, goals, half-time data, and odds.

**Model:** Two LightGBM regressors (home + away), 98 features across 8 layers:
- **Layer 1:** Corner production (CF/CA L5/L10/L15/season, EW form)
- **Layer 2:** Consistency (std dev, CV, over-rate %)
- **Layer 3:** Home/away strength (venue-filtered stats)
- **Layer 4:** Opponent interaction (attack × defense profiles)
- **Layer 5:** Shots/fouls/cards/goals (attacking pressure)
- **Layer 6:** Team strength Elo rating
- **Layer 7:** Odds-derived features (1X2, O/U 2.5, Asian handicap)
- **Layer 8:** Context (rest days, sample size, league encoding)

**Honest backtest (time-ordered 80/20 split):**
- Home MAE: 2.25 corners | Away MAE: 1.96 corners
- Total MAE: 2.74 corners
- Team line accuracy: O3.5 → 66%, O4.5 → 61%, O5.5 → 66%, O6.5 → 75%, O7.5 → 83%
- Total line accuracy: O7.5 → 73%, O8.5 → 61%, O9.5 → 54%, O10.5 → 59%, O12.5 → 80%
- **70% consistency rule: 29% — BELOW threshold.** The MAE is honest (not overfitting) — corner counts have inherent variance.
- Line probabilities are the useful output — Negative Binomial distribution calibrated to model sigma.
- σ_home = 2.85, σ_away = 2.46, σ_total = 3.76

**Line probabilities:** Uses Negative Binomial distribution (handles overdispersion better than Poisson/Poisson). P(X > line) computed from predicted count + model sigma.

**Isolation:** Completely separate from h2h/totals:
- Separate D1 table: `corners_predictions`
- Separate training script: `model/scripts/train_corners_v5.py`
- Separate prediction script: `model/scripts/predict_corners_v5.py`
- Separate TypeScript module: `packages/core/src/corners.ts` (NB CDF implementation)
- Separate UI page: `/corners`
- No shared models, no shared predictions, no shared bets

**Pipeline:** GitHub Actions predict job → Python V5 model → JSON → worker ingest endpoint → D1 → UI

**API:**
- `GET /api/corners` — returns all corner predictions with line probs (no auth)
- `POST /api/corners/ingest` — ingests `{fixtureId, homeCorners, awayCorners}` (requires PREDICT_SECRET)

**PREDICT_SECRET:** value is **deliberately not recorded here.** It lives in exactly two
places — the Cloudflare Worker (`wrangler secret list`) and GitHub Actions
(`gh secret list`) — and the two must match. Format: `odk` + 40 hex chars.

> **Why no literal:** a secret written into a tracked file is effectively burned —
> anyone with repo read access can drive `/api/predictions/ingest`, `/api/settle`,
> and the manual cron triggers. The value previously recorded in this doc leaked
> and was rotated on **Sep 10, 2026**. Rotate again with:
> ```bash
> NEW="odk$(openssl rand -hex 20)"
> echo "$NEW" | (cd worker && npx wrangler secret put PREDICT_SECRET)
> gh secret set PREDICT_SECRET --body "$NEW"
> ```
> Then re-register the Telegram webhook (`POST /api/telegram/setup`) since that
> route is gated by this secret.

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

## 14. Sep 9 Pipeline Repair — multi-league corners was showing demo data

**Symptom:** The app showed only demo/seed data everywhere; corners page had no live predictions.

**Root causes found (all three were live breaks):**
1. **`predict.yml` YAML was invalid.** The corners push step embedded a `python3 -c "..."` block
   whose continuation lines sat at column 0, breaking the whole workflow parse — every push-triggered
   predict run failed in 0s, so no h2h/totals/corners predictions were ever pushed by CI.
   Fixed by extracting the conversion into `model/scripts/corners_to_ingest.py`.
2. **`model/requirements.txt` was missing `lightgbm`.** `predict_corners_v5.py` loads LGBM
   regressors, so the corners predict step died with `ModuleNotFoundError` in the cloud.
3. **PREDICT_SECRET mismatch.** The worker had a regenerated `odk…` secret but GitHub Actions
   still held the old value, so every scheduled ingest POST returned 401 (masked as "success"
   because the cron `curl` doesn't use `-f`). No live odds were ever pulled → D1 had only seed
   fixtures → `/api/db` and `/api/fixtures/export` fell back to demo seed.

**Fixes applied:**
- Rotated `PREDICT_SECRET` to a fresh `odk…` value, set identically on the Cloudflare Worker
  and GitHub Actions (verify current value with `wrangler secret list` / `gh secret list`).
- Repaired `predict.yml` (delegates to `corners_to_ingest.py`), added `lightgbm` to requirements.
- Redeployed worker, purged ALL seed residue from D1 (fixtures/odds/predictions/bets/clv/
  outcomes/corners with `sport='soccer'`), so the app now shows 100% live data.

**Verified live (Sep 9):** 147 real fixtures across 10 leagues (EPL, La Liga, Bundesliga, Serie A,
Championship, Segunda, 2. Bundesliga, Serie B, League 1, J League), 735 h2h/totals predictions,
294 corner predictions (147 fixtures × home/away), `/api/fixtures/export` source = `live-odds`.

**PENDING (D1 free-tier daily write limit exhausted — resets midnight UTC):**
- Settings row currently has `min_bookmakers = 1` and `max_spread_pct = 0.5` (the agent's
  testing wrote these). The 4-book depth gate MUST be restored to `min_bookmakers = 4`,
  `max_spread_pct = 0.10` once the write limit resets:
  `UPDATE settings SET min_bookmakers = 4, max_spread_pct = 0.10 WHERE id = 1`
- Add `English League Two` and `Turkish Super Lig` to `settings.leagues` (they're valid
  `LEAGUE_SPORTS` keys) so the 12-league config is complete.
- NOTE: the agent's repeated force-reseeds wiped any previously logged real bets — D1 had only
  seed bets (1969 timestamps) at audit time.

**D1 budget lesson:** each odds ingest writes ~11K snapshot rows (147 fixtures × ~76 snapshots).
4 scheduled ingests/day + closing + tennis ≈ near the 100K row-write/day free-tier cap. Do NOT
run extra manual ingests on the same day as the scheduled ones, or the daily quota is blown.

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
