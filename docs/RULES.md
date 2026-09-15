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

## 7. What a fresh mining pass would produce (and why nothing was added)

Asked directly: *"if you were to generate new 100% rules, what would they be?"*
The honest answer needed evidence, so the search was run properly — **walk-forward**,
not in-sample:

- mine on the **first 94** settled fixtures (the batch the current book was mined on),
- test on the **next 23** (the batch that killed nine rules).
- Candidate conditions: every metric (`H`, `D`, `A`, `O2.5`, `U2.5`, `HomeScores`,
  `AwayScores`, `DC12`, and the six pairwise differences) compared `>=` / `<=`
  against **every threshold actually observed in the data** → 1,842 distinct
  conditions, then all 1-condition and 2-condition conjunctions across 11 targets.

### Result

| | |
|---|---|
| Distinct 1–2 condition rules hitting **100% on batch 1** (n ≥ 5) | **146,773** |
| Collapsed to structural patterns (adjacent thresholds are the same rule) | **767** |
| Patterns where a variant broke on batch 2 | **624** |
| Patterns where at least one variant survived batch 2 | 481 (62.7%) |

**That number is the answer to the question.** With ~1,800 candidate conditions you
can always manufacture thousands of "100%" rules out of 94 fixtures. A search like
this finding perfect rules is not evidence of edge — it is the definition of the
overfitting trap the freeze exists to resist. And "survived" here is generous: it
means *some* variant was still perfect over **23** fixtures, several on an n of 1.

### The knife-edge problem, in one line of output

```
A >= 21.25% AND A-D <= 2.89%  → Home to score   b1 23/23  b2 5/5   ← survives
A >= 19.42% AND A-D <= 2.89%  → Home to score   b1 26/26  b2 5/6   ← bigger sample, BREAKS
```

The rule that breaks is the one with the **larger**, more impressive batch-1 sample,
and it breaks by widening a single threshold by less than 2 percentage points. This is
exactly the R8 story (18/19) playing out in real time.

### Family distribution of surviving patterns

| Backs | Patterns |
|---|---|
| Home team to score | 132 |
| Away team to score | 113 |
| Over 1.5 | 104 |
| DC12 | 72 |
| Over 2.5 | 43 |
| Under 2.5 | 9 |
| Home win | 8 |

**Zero** surviving patterns for the draw, away win, home-goal-no, or Over/Under 1.5 —
which independently confirms the original mining notes ("no trustworthy rule" for draw,
Under 1.5, home-goal-no).

### Watch-list (NOT in the book)

The strongest survivors, recorded for observation only. **These are not rules, they are
candidate hypotheses** — they are deliberately *absent* from `rules.ts` so the
300-fixture test stays clean:

| # | Conditions | Backs | Batch 1 | Batch 2 | Knife-edge |
|---|---|---|---|---|---|
| C1 | `A ≥ 21.25%` AND `A − D ≤ 2.89pp` | Home team to score | 23/23 | 5/5 | ⚠️ yes |
| C2 | `H − A ≤ 27.08pp` AND `A − D ≤ 2.89pp` | Home team to score | 21/21 | 4/4 | no |
| C3 | `A ≤ 29.20%` AND `H − A ≤ 27.08pp` | Home team to score | 17/17 | 4/4 | no |
| C4 | `O2.5 ≥ 60.77%` AND `A − D ≥ −14.84pp` | Over 1.5 | 15/15 | 5/5 | ⚠️ yes |
| C5 | `HomeScores ≥ 76.42%` AND `H − D ≤ 13.36pp` | Away team to score | 15/15 | 5/5 | ⚠️ yes |

C1 and C2 read sensibly — *"the away side is a live threat but not clearly ahead of the
draw"* → the home team scores. That is the mirror of the failed R9, which is a reason
for curiosity and not yet a reason for money. They get promoted only if they clear a
full 300-fixture run **as written**, thresholds untouched.

---

### §7b. Second mining run (124 settled fixtures) — and the one candidate it produced

The search was repeated after the denominator grew from 118 to **124** settled
fixtures, using the same walk-forward split and the new standalone tool
`model/scripts/mine_rules.py` (bitset search — the naive version is 26M
conjunctions and does not finish):

```
batch 1 = 99 oldest settled fixtures   (mine here)
batch 2 = 25 newest                    (test here)
```

| | |
|---|---|
| Candidate conditions | 6,516 |
| 1–2 condition rules hitting **100% on batch 1** (n ≥ 5) | **2,003** |
| Also held on batch 2 | 814 (**40.6%**) |

**40.6% of search-generated "100%" rules survived a fresh 25 fixtures.** If the
book were assembled by this search, two out of five of its rules would be
artifacts — and it would look like a great book on batch 1, with samples like
13/13 and 14/14. That number is the case for the freeze, not against it.

### C6 — watch-list candidate (NOT in the book)

The strongest *shape* to recur, chosen for recurrence rather than for its best
single sample:

| # | Conditions | Backs | Batch 1 | Batch 2 | Knife-edge |
|---|---|---|---|---|---|
| **C6** | `D − O25 ≤ −39.68pp` | Over 1.5 goals | **8/8** | **3/3** | ⚠️ yes |

It reads sensibly — *the draw is priced much less likely than Over 2.5 is priced
likely* → a decisive, high-tempo match → at least two goals. It is the mirror of
**R2**, which backs Under 2.5 on `O25 − U25 ≤ −2.5pp AND DC12 ≥ 70%`.

The variants are the reason it is only a watch-list entry: `D − O25 ≤ −39.52pp`
and `D − O25 ≤ −39.68pp` both hit 100% on batch 1, so a neighbour one fifth of a
percentage point away is the same rule at a different knife edge. Batch 2 gave it
**three** fixtures. Three fixtures is not evidence — it is a reason to keep
looking.

**Nothing was added to `rules.ts`.** The rule book is being validated, not
expanded; adding C6 now would reset the 300-fixture clock for a rule with an n of
three. It gets promoted only if it clears 300 fixtures **as written**, with every
threshold untouched.

Also worth noting from the same run: the surviving patterns remain heavily
concentrated in the *safe goal* markets, and **zero** patterns survived for
draw, away win, home-goal-no or Under 1.5 — the third independent confirmation
of the original mining notes.

---

## 8. Verifying the rule book

```bash
pnpm test:core        # core assertions: frozen thresholds, evaluation, standings
pnpm test             # core + worker e2e (134)

# Re-run the mining pass against the live database:
curl -s "$ODDKET_WORKER_URL/api/db" -o model/output/db_live.json
cd model && .venv/bin/python scripts/mine_rules.py output/db_live.json
```

The test builds the real TypeScript module and asserts, among other things:

- the 13 thresholds are byte-identical to the frozen values,
- a missing market **fails closed** (never a silent hit),
- an unsettled fixture moves the denominator, not the rate,
- `activeOnly` drops failed rules from filters.
