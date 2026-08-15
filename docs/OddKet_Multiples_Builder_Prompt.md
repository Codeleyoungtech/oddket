# OddKet — Multiple (Parlay) Builder — Build Prompt

Use with your AI coding agent on the existing OddKet codebase (football + tennis both live). Read the current slip builder, staking module, and both sports' prediction pipelines before starting.

## Non-negotiable constraints
- **Gated behind proven edge — do not surface live yet.** Build this as a complete, working feature, but put it behind a config flag (e.g. `MULTIPLES_ENABLED = false`) that stays off until real CLV on the underlying singles (football and/or tennis) has cleared the validation checklist already established: 100+ logged bets, positive real CLV vs. closing line, 95% CI not straddling zero, result survives removing top-N winners. Right now, neither sport has cleared this. The feature can be fully built and tested in backtest/paper-trade mode now — it just doesn't go live to real suggestions until the flag is flipped, and that flag only gets flipped on my explicit confirmation that a sport has cleared the checklist.
- **Multiples are not lower-risk than singles — do not build or describe them as risk-reducing.** They increase variance by construction. The goal is "well-constructed given that risk," not "risk-minimized." Do not generate any UI copy, docstring, or log message implying multiples reduce risk.
- **Max 3 legs per multiple, hard cap.** Football's own validation data showed calibration error compounds badly with each additional leg at longer combined odds (the longshot-bleed pattern). Do not allow configuration to exceed 3 legs.
- **Every leg must individually clear the existing single-bet EV threshold on its own before it's eligible for a multiple.** Never include a leg in a multiple that wouldn't already be flagged as a positive-EV single. No "weak leg propped up by strong leg" combinations.
- **$0 budget, same as always** — no new paid data sources for this feature.

## Core logic

### 1. Correlation filter
- Before combining any two legs, check whether they're statistically independent
- Same-match legs are the primary risk: e.g. "Team A wins" + "Over 2.5 goals" in the same football match, or in tennis, correlated markets within the same match if/when multiple tennis markets exist
- Reject same-match leg combinations by default unless a specific, documented correlation adjustment is implemented (do not assume independence and just multiply probabilities naively for same-match legs)
- Cross-match legs (different fixtures, potentially different sports — one football leg + one tennis leg) are the safer default combination, since they're genuinely independent

### 2. Combined probability and staking
- True combined probability = product of individual (calibrated) leg probabilities — only valid because correlation filter has already excluded non-independent combinations
- Combined odds = product of individual leg odds
- Stake sizing: run Kelly (same fractional Kelly used elsewhere in the codebase) on the *combined* probability and combined odds — do not just sum or average the individual legs' single-bet stakes
- Display both the bookmaker's advertised combined odds/multiplier AND the model's true combined probability, side by side, same as the existing single-market slip builder already does for individual bets

### 3. Multi-sport support
- Multiples can mix football and tennis legs (cross-sport is actually the safest combination type, since correlation risk is near-zero across sports)
- Pull eligible legs from both sports' existing flagged-bet endpoints (`/api/slips` and `/api/tennis/slips`) — do not duplicate the underlying EV logic, reuse what already exists
- UI: when building a multiple, let the user select legs from a combined pool (football + tennis), tagged by sport

### 4. Portfolio view (the more useful default, not just single-slip optimization)
- In addition to (or instead of) one large multiple, show several independent smaller 2-leg options in parallel, each separately staked
- This avoids concentrating risk into one large combined position
- Rank these portfolio options by combined EV, same transparency as the existing single-bet ranking

## What NOT to build
- No auto-placement (same as everything else — output is a slip summary for manual entry)
- No "optimal multiple" black-box scoring that hides the underlying leg-by-leg math — always show each leg's individual probability/odds/edge alongside the combined figures
- No default leg count above 3
- No live surfacing to the user until `MULTIPLES_ENABLED` is explicitly flipped on

## Testing requirement
Backtest the multiple-builder logic against historical data from both sports' existing holdout sets. Report combined ROI/win-rate honestly, same rules as every other backtest in this project — including if it's negative, and including a version of the "remove top-N winners" fragility check applied to multiples specifically, since multiples are structurally more exposed to exactly that fragility pattern.
