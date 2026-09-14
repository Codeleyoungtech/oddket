# OddKet — The Rule Book (frozen selection rules)

> **Status: FROZEN.** These rules were mined by hand from the graded prediction
> history, then re-tested against the next batch. Thresholds are locked. A rule
> that loses is *recorded*, never re-tuned — that is the whole point.

The rule book is code, not a spreadsheet: **`packages/core/src/rules.ts`**.
Everything below (and every filter in the app) is generated from that one file,
and a regression test asserts the thresholds never move.

---

## 1. Why this exists

Logging every flagged pick by hand was never realistic, so the model's accuracy
had to be checked from the predictions that were *already* generated — that is
what **`/history`** does. Exporting that page as CSV gave a per-fixture vector of
model probabilities (`H`, `D`, `A`, `O2.5`, `U2.5`, `Home-scores`,
`Away-scores`, `DC12`) plus the final score.

From that, a rule-mining pass looked for conditions on those probabilities that
*always* produced the right outcome:

```
Batch 1 (~94 fixtures)  →  find candidate rules  →  FREEZE
Batch 2 (next ~24)      →  combine → recalculate  →  see which rules survive
                        →  repeat, denominator always growing
```

No moving goalposts. If a rule loses, it loses, and it stays visible in the book
with its real record.

**Target: 300 settled fixtures.** Currently tracked live in the app.

---

## 2. Status legend

| Status | Meaning |
|---|---|
| 🔥 `surviving` | Still 100% after batch 2. Keep testing hard. |
| 🧪 `experimental` | Still 100%, but the qualifying sample is too small to trust. |
| ❌ `failed` | Broke on batch 2. Kept in the book for the record — never resurrected by moving a threshold. |

---

## 3. The rules

`H` = model P(home win) · `D` = P(draw) · `A` = P(away win) ·
`O2.5`/`U2.5` = P(over/under 2.5) · `HG`/`AG` = P(home/away team scores) ·
`DC12` = P(double chance 12, i.e. no draw). Differences are in **probability
points (pp)**, e.g. `≥ 42.5pp` means `≥ 0.425`.

### Surviving

| ID | Conditions (all must hold) | Backs | Frozen | Now | Rate |
|---|---|---|---|---|---|
| **R1** | `H ≥ 60%` AND `O2.5 ≥ 55%` | Home team to score | 12/12 | 12/12 | **100%** |
| **R2** | `O2.5 − U2.5 ≤ −2.5pp` AND `DC12 ≥ 70%` | Under 2.5 goals | 9/9 | 9/9 | **100%** |
| **R3** | `H ≥ 60%` AND `AG − O2.5 ≤ 12.5pp` | Home win (1X2) | 9/9 | 9/9 | **100%** |

R1 is the strongest survivor: the goal-expectation condition that *used* to look
universal now only holds for the home-to-score leg. R3 is notable because it is
a perfect record on an actual 1X2 market, not just a goal market.

### Experimental

| ID | Conditions | Backs | Frozen | Now | Rate |
|---|---|---|---|---|---|
| **R4** | `H ≤ 60%` AND `H − A ≥ 42.5pp` | Away team NOT to score | 5/5 | 5/5 | **100%** |

Perfect, but 5 fixtures is not evidence. Treat it as a watch-list entry.

### Failed (kept for the record)

| ID | Conditions | Backs | Frozen | Now | Rate |
|---|---|---|---|---|---|
| R5 | `H ≥ 60%` AND `O2.5 ≥ 55%` | Over 2.5 | 11/12 | 11/12 | 91.7% |
| R6 | `H − D ≥ 32.5pp` AND `O2.5 − U2.5 ≥ 17.5pp` | Over 2.5 | 13/14 | 13/14 | 92.9% |
| R7 | `H ≥ 60%` AND `AG ≥ 65%` | Over 1.5 | 11/12 | 11/12 | 91.7% |
| R8 | `H − D ≥ 17.5pp` AND `AG − O2.5 ≤ 10pp` | Over 1.5 | 18/19 | 18/19 | 94.7% |
| R9 | `H − A ≤ 42.5pp` AND `H − D ≥ 22.5pp` | Home team to score | 19/21 | 19/21 | 90.5% |
| R10 | `H − A ≤ 27.5pp` AND `HG − AG ≥ 10pp` | Away team to score | 16/17 | 16/17 | 94.1% |
| R11 | `H ≤ 45%` AND `HG ≥ 80%` | Away team to score | 13/14 | 13/14 | 92.9% |
| R12 | `A − D ≥ −5pp` AND `HG − AG ≥ 15pp` | Away win (1X2) | 5/6 | 5/6 | 83.3% |
| R13 | `DC12 ≥ 77.5%` AND `H ≤ 70%` | Double chance 12 | 19/21 | 19/21 | 90.5% |

**The lesson R5 taught us:** `H ≥ 60% AND O2.5 ≥ 55%` once looked like a
universal confirmation rule, hitting Over 2.5, Over 1.5 *and* Home-scores at
100%. Batch 2 broke two of the three (Galatasaray 1–0 Kocaelispor), and only
Home-scores survived. A condition can be genuinely useful without guaranteeing
every market it touches.

---

## 4. Where the rules appear in the app

| Surface | What it does |
|---|---|
| **`/history` → Rule book card** | Live record of all 13 rules against every settled fixture, with a progress bar toward 300 and the frozen `was → now` comparison. Click a rule to filter the table to its picks. |
| **`/history` → rule filter** | Narrows the graded list to rule picks only (`📕 Rule picks` = all non-failed rules, or one specific rule). The summary cards then show **that rule's** hit rate. |
| **`/history` → row chips** | Each graded row carries a `📕 R#` chip when a rule fires on that fixture + market + selection. Hover for the full conditions. |
| **`/slips` → rule filter** | Filters live, upcoming predictions down to rule-compliant legs. `📕 Rule picks` covers all four active rules. |
| **CSV export** | `/history` now includes a `rules` column (`R1 R3`) so external analysis can slice by rule without re-deriving the conditions. |
| **`packages/core/src/rules.ts`** | The single source of truth. |

### Reading the slips filter honestly

Rule picks span markets the odds feed does not price:

| Rule | Bookmaker market | Priced by the odds feed? |
|---|---|---|
| R1 Home team to score | "Home Team Over 0.5 Goals" | ❌ model-only — check the line yourself |
| R2 Under 2.5 | "Under 2.5 Goals" | ✅ EV-checked in the flagged view |
| R3 Home win | "Home Win (1)" | ✅ EV-checked in the flagged view |
| R4 Away NOT to score | "Away Team Under 0.5 Goals" | ❌ model-only — check the line yourself |

That is why selecting a rule filter auto-switches the slips page to **👁️ All**:
R1/R4 have a probability but no bookmaker price, so they can only ever appear
there. A **rule pick is not a licence to bet** — it is a *filter on the model's
own probabilities*. You still need the price to beat `1/p`:

> R1 at 82.8% needs odds **above 1.21** to be worth anything. R2/R3 legs come
> with a verified price and an EV check; R1/R4 do not.

---

## 5. Rules for using the rule book

1. **Do not add rules yet.** The book is being validated, not expanded. New
   rules would just reset the clock on the 300-fixture test.
2. **Do not move a threshold.** The regression test asserts the exact numbers;
   moving one fails the suite.
3. **Treat a rule pick as a candidate, not a bet.** Check the bookmaker's price.
   Where a leg is also EV-flagged, prefer that leg — it has a verified price.
4. **One rule pick per fixture per market.** Rules share conditions (R1 and R5
   fire together), so they are *not* independent legs and must not be stacked
   into one accumulator.
5. **Read the denominator.** 9/9 is promising; 9/9 is not proof. The card's
   progress bar exists so "100% over 9 fixtures" is never mistaken for
   "100% over 100 fixtures".
6. **Never blend rule picks with the failed rules' markets.** R5–R13 lost for a
   reason; they are in the book as evidence, not as options.

---

## 6. Known limits

- **The rules describe the model's own probabilities.** If the underlying model
  is retrained and its calibration shifts, a rule's *meaning* shifts with it even
  though its thresholds are frozen. Any retrain should be followed by a
  re-scoring pass — the rule book card recomputes automatically from the live
  data, so it will show a break immediately.
- **Held-out-market caveat.** R2/R3/R4 were mined on fixtures the model has
  predictions for; the rule book is a post-hoc pattern search on one dataset, so
  the honest expectation is regression toward the mean as the denominator grows.
  That is exactly what the 300-fixture target is for.
- **Partial fixtures never count.** A fixture missing any of the six markets is
  excluded from both the numerator and the denominator (currently 1 of 118).
- **Rules are football-only.** Nothing here touches tennis or corners.

---

## 7. Verifying the rule book

```bash
pnpm test:core        # 41 assertions: frozen thresholds, evaluation, standings
pnpm test             # core + worker e2e (104)
```

The test builds the real TypeScript module and asserts, among other things:

- the 13 thresholds are byte-identical to the frozen values,
- a missing market **fails closed** (never a silent hit),
- an unsettled fixture moves the denominator, not the rate,
- `activeOnly` drops failed rules from filters.
