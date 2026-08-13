import type { Settings } from "./types";

/**
 * Full Kelly fraction: f* = (b·p − q) / b, where b = decimal odds − 1,
 * p = model probability, q = 1 − p. Returns 0 when the bet has no edge.
 */
export function fullKelly(p: number, decimalOdds: number): number {
  const b = decimalOdds - 1;
  if (b <= 0 || p <= 0 || p >= 1) return 0;
  const q = 1 - p;
  return (b * p - q) / b;
}

/**
 * Suggested stake in currency units.
 *   stake = min(bankroll × fullKelly × kellyFraction, bankroll × stakeCapPct)
 * Never negative — no edge ⇒ no stake. Also guards a floor of 0.
 */
export function suggestedStake(
  p: number,
  decimalOdds: number,
  bankroll: number,
  settings: Pick<Settings, "kellyFraction" | "defaultStakeCapPct">,
): number {
  const f = fullKelly(p, decimalOdds);
  if (f <= 0) return 0;
  const raw = bankroll * f * settings.kellyFraction;
  const cap = bankroll * settings.defaultStakeCapPct;
  const stake = Math.min(raw, cap);
  return stake > 0 ? Math.round(stake * 100) / 100 : 0;
}

/** Return the stake cap (currency) implied by a stop-loss — smallest of the caps in play. */
export function stopLossRemaining(
  spentToday: number,
  spentThisWeek: number,
  settings: Pick<Settings, "dailyStopLoss" | "weeklyStopLoss">,
): number {
  const dailyLeft = settings.dailyStopLoss - spentToday;
  const weeklyLeft = settings.weeklyStopLoss - spentThisWeek;
  return Math.max(0, Math.min(dailyLeft, weeklyLeft));
}

/**
 * Validate a stake against stop-losses. Returns the reason string when blocked,
 * null when the stake is allowed.
 */
export function stopLossViolation(
  stake: number,
  spentToday: number,
  spentThisWeek: number,
  settings: Pick<Settings, "dailyStopLoss" | "weeklyStopLoss">,
): string | null {
  if (settings.dailyStopLoss > 0 && spentToday + stake > settings.dailyStopLoss) {
    return `Daily stop-loss ($${settings.dailyStopLoss.toFixed(0)}) exceeded`;
  }
  if (settings.weeklyStopLoss > 0 && spentThisWeek + stake > settings.weeklyStopLoss) {
    return `Weekly stop-loss ($${settings.weeklyStopLoss.toFixed(0)}) exceeded`;
  }
  return null;
}
