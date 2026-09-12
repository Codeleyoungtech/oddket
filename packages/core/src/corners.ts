/**
 * Corners prediction module V5 — Negative Binomial line probabilities.
 *
 * Uses the V5 trained model's sigma (prediction error std) to compute
 * calibrated over/under probabilities via the Negative Binomial distribution.
 *
 * Team lines: O2.5, O3.5, O4.5, O5.5, O6.5, O7.5, O8.5
 * Total lines: O5.5, O6.5, O7.5, O8.5, O9.5, O10.5, O11.5, O12.5
 */

import type { CornerPrediction, Fixture } from "./types";

// V5 model sigma values from backtest (prediction error std)
export const HOME_SIGMA = 2.849;
export const AWAY_SIGMA = 2.456;
export const TOTAL_SIGMA = Math.sqrt(HOME_SIGMA ** 2 + AWAY_SIGMA ** 2); // ~3.76

/** Team corner lines to compute probabilities for. */
export const TEAM_LINES = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5] as const;

/** Total corner lines. */
export const TOTAL_LINES = [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5] as const;

/**
 * Negative Binomial CDF using direct PMF summation.
 * P(X ≤ k) for NB(r, p) where mean = r(1-p)/p, var = μ + μ²/r.
 * Uses log-space for numerical stability.
 */
function nbCDF(k: number, mu: number, sigma: number): number {
  if (mu <= 0 || sigma <= 0) return 0;
  const variance = sigma * sigma;
  if (variance <= mu) {
    // Underdispersed → Poisson approximation
    return poissonCDF(k, mu);
  }
  const r = (mu * mu) / (variance - mu);
  const p = r / (r + mu);
  const q = 1 - p; // = mu / (r + mu)

  // Direct summation of PMF: P(X=i) = C(i+r-1, i) * p^r * q^i
  // Use log-space: log(PMF) = lnGamma(i+r) - lnGamma(r) - lnGamma(i+1) + r*ln(p) + i*ln(q)
  let cdf = 0;
  const lnP = Math.log(p);
  const lnQ = Math.log(q);
  const lnGammaR = lnGamma(r);

  for (let i = 0; i <= Math.floor(k); i++) {
    const logPmf = lnGamma(i + r) - lnGammaR - lnGamma(i + 1) + r * lnP + i * lnQ;
    cdf += Math.exp(logPmf);
  }
  return Math.min(cdf, 1);
}

/** Poisson CDF for underdispersed case. */
function poissonCDF(k: number, lambda: number): number {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  let sum = 0;
  let term = Math.exp(-lambda);
  sum = term;
  for (let i = 1; i <= Math.floor(k); i++) {
    term *= lambda / i;
    sum += term;
  }
  return Math.min(sum, 1);
}

/** Log-gamma (Lanczos approximation). */
function lnGamma(z: number): number {
  if (z <= 0) return 0;
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  }
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) {
    x += c[i] / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/**
 * P(X > line) using Negative Binomial distribution.
 */
function overProb(mu: number, sigma: number, line: number): number {
  if (mu <= 0 || sigma <= 0) return 0;
  const prob = 1 - nbCDF(line, mu, sigma);
  return Math.round(prob * 1000) / 1000; // 3 decimal places
}

/**
 * 80% confidence interval: μ ± 1.28σ
 */
function confidenceInterval(
  predicted: number,
  sigma: number,
): { low: number; high: number } {
  const z80 = 1.28;
  return {
    low: Math.round(Math.max(0, predicted - z80 * sigma) * 100) / 100,
    high: Math.round((predicted + z80 * sigma) * 100) / 100,
  };
}

/**
 * Build corner predictions for a fixture from the Python model's raw output.
 *
 * @param fixture - The match
 * @param homeCorners - Python model's predicted corner count for home team
 * @param awayCorners - Python model's predicted corner count for away team
 * @param modelVersion - e.g. "corners-lgb-v5"
 */
export function buildCornerPredictions(
  fixture: Fixture,
  homeCorners: number,
  awayCorners: number,
  modelVersion: string = "corners-lgb-v5",
): CornerPrediction[] {
  const now = Math.floor(Date.now() / 1000);
  const homeCI = confidenceInterval(homeCorners, HOME_SIGMA);
  const awayCI = confidenceInterval(awayCorners, AWAY_SIGMA);

  const totalExpected = homeCorners + awayCorners;

  const makePred = (
    side: "home" | "away",
    team: string,
    predicted: number,
    sigma: number,
    ci: { low: number; high: number },
  ): CornerPrediction => ({
    id: `${fixture.id}:corners:${side}`,
    fixtureId: fixture.id,
    team,
    side,
    predictedCorners: Math.round(predicted * 100) / 100,
    confidenceLow: ci.low,
    confidenceHigh: ci.high,
    lineProbs: {
      over25: overProb(predicted, sigma, 2.5),
      over35: overProb(predicted, sigma, 3.5),
      over45: overProb(predicted, sigma, 4.5),
      over55: overProb(predicted, sigma, 5.5),
      over65: overProb(predicted, sigma, 6.5),
      over75: overProb(predicted, sigma, 7.5),
      over85: overProb(predicted, sigma, 8.5),
    },
    totalCorners: {
      expected: Math.round(totalExpected * 100) / 100,
      lines: {
        over55: overProb(totalExpected, TOTAL_SIGMA, 5.5),
        over65: overProb(totalExpected, TOTAL_SIGMA, 6.5),
        over75: overProb(totalExpected, TOTAL_SIGMA, 7.5),
        over85: overProb(totalExpected, TOTAL_SIGMA, 8.5),
        over95: overProb(totalExpected, TOTAL_SIGMA, 9.5),
        over105: overProb(totalExpected, TOTAL_SIGMA, 10.5),
        over115: overProb(totalExpected, TOTAL_SIGMA, 11.5),
        over125: overProb(totalExpected, TOTAL_SIGMA, 12.5),
      },
    },
    modelVersion,
    createdAt: now,
  });

  return [
    makePred("home", fixture.homeTeam, homeCorners, HOME_SIGMA, homeCI),
    makePred("away", fixture.awayTeam, awayCorners, AWAY_SIGMA, awayCI),
  ];
}

/**
 * Format a corner prediction for display.
 * Returns lines like "Over 4.5 corners: 63% probability"
 */
export function formatCornerLines(pred: CornerPrediction): string[] {
  const lp = pred.lineProbs;
  return [
    `Over 2.5 corners: ${(lp.over25 * 100).toFixed(0)}%`,
    `Over 3.5 corners: ${(lp.over35 * 100).toFixed(0)}%`,
    `Over 4.5 corners: ${(lp.over45 * 100).toFixed(0)}%`,
    `Over 5.5 corners: ${(lp.over55 * 100).toFixed(0)}%`,
    `Over 6.5 corners: ${(lp.over65 * 100).toFixed(0)}%`,
    `Over 7.5 corners: ${(lp.over75 * 100).toFixed(0)}%`,
    `Over 8.5 corners: ${(lp.over85 * 100).toFixed(0)}%`,
  ];
}

/**
 * Format total corners prediction for display.
 */
export function formatTotalLines(pred: CornerPrediction): string[] {
  if (!pred.totalCorners) return [];
  const tl = pred.totalCorners.lines;
  return [
    `Total Over 5.5: ${(tl.over55 * 100).toFixed(0)}%`,
    `Total Over 6.5: ${(tl.over65 * 100).toFixed(0)}%`,
    `Total Over 7.5: ${(tl.over75 * 100).toFixed(0)}%`,
    `Total Over 8.5: ${(tl.over85 * 100).toFixed(0)}%`,
    `Total Over 9.5: ${(tl.over95 * 100).toFixed(0)}%`,
    `Total Over 10.5: ${(tl.over105 * 100).toFixed(0)}%`,
    `Total Over 11.5: ${(tl.over115 * 100).toFixed(0)}%`,
    `Total Over 12.5: ${(tl.over125 * 100).toFixed(0)}%`,
  ];
}

/**
 * Compute team corner line probabilities from expected corners count.
 */
export function computeTeamCornerLines(
  predicted: number,
  side: "home" | "away" = "home",
): Record<string, number> {
  const sigma = side === "home" ? HOME_SIGMA : AWAY_SIGMA;
  return {
    over25: overProb(predicted, sigma, 2.5),
    over35: overProb(predicted, sigma, 3.5),
    over45: overProb(predicted, sigma, 4.5),
    over55: overProb(predicted, sigma, 5.5),
    over65: overProb(predicted, sigma, 6.5),
    over75: overProb(predicted, sigma, 7.5),
    over85: overProb(predicted, sigma, 8.5),
  };
}

/**
 * Compute match total corner line probabilities from expected total corners count.
 */
export function computeTotalCornerLines(totalExpected: number): Record<string, number> {
  return {
    over55: overProb(totalExpected, TOTAL_SIGMA, 5.5),
    over65: overProb(totalExpected, TOTAL_SIGMA, 6.5),
    over75: overProb(totalExpected, TOTAL_SIGMA, 7.5),
    over85: overProb(totalExpected, TOTAL_SIGMA, 8.5),
    over95: overProb(totalExpected, TOTAL_SIGMA, 9.5),
    over105: overProb(totalExpected, TOTAL_SIGMA, 10.5),
    over115: overProb(totalExpected, TOTAL_SIGMA, 11.5),
    over125: overProb(totalExpected, TOTAL_SIGMA, 12.5),
  };
}

/** Standard normal CDF via the Abramowitz–Stegun erf approximation. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** A probability side of the "safe band" — the tightest line still ≥ 70%. */
export interface CornerBandSide {
  line: number;
  probability: number;
}

export interface CornerBand {
  /** Highest Over line the model still rates ≥70% (null if none qualifies). */
  over: CornerBandSide | null;
  /** Lowest Under line the model still rates ≥70% (null if none qualifies). */
  under: CornerBandSide | null;
}

/**
 * The "safe band" for a corner line ladder: the most aggressive Over and the
 * most aggressive Under that the model still rates at ≥70%.
 *
 * This replaces the old "best line" heuristic, which picked the line FURTHEST
 * from 50% — that always lands on a useless tail ("Under 11.5", "Over 2.5",
 * both ~85–90% at near-zero odds) and buried the genuinely useful lines.
 * The band answers the real question: "which line can I actually be confident
 * in?" If neither side clears 70%, the match is a genuine coin-flip and we
 * say so instead of inventing a pick.
 */
export function cornerSafeBand(
  expected: number,
  sigma: number,
  lines: readonly number[],
  minProb = 0.7,
): CornerBand {
  const overs = lines
    .map((line) => ({ line, probability: overProb(expected, sigma, line) }))
    .filter((o) => o.probability >= minProb)
    .sort((a, b) => b.line - a.line); // most aggressive (highest) qualifying Over
  const unders = lines
    .map((line) => ({ line, probability: 1 - overProb(expected, sigma, line) }))
    .filter((u) => u.probability >= minProb)
    .sort((a, b) => a.line - b.line); // most aggressive (lowest) qualifying Under
  return { over: overs[0] ?? null, under: unders[0] ?? null };
}

/** Total-corners safe band from the expected match total. */
export function totalCornerSafeBand(totalExpected: number, minProb = 0.7): CornerBand {
  return cornerSafeBand(totalExpected, TOTAL_SIGMA, TOTAL_LINES, minProb);
}

/** Team-corners safe band from the team's expected corners. */
export function teamCornerSafeBand(
  expected: number,
  side: "home" | "away",
  minProb = 0.7,
): CornerBand {
  return cornerSafeBand(
    expected,
    side === "home" ? HOME_SIGMA : AWAY_SIGMA,
    TEAM_LINES,
    minProb,
  );
}

/**
 * "Most corners" — a 1X2-style read on which team wins the corner count.
 *
 * Corners are a discrete count so ties are real: the difference of two
 * independent count distributions is modelled as Normal around
 * μ = homeExpected − awayExpected with σ² = HOME_SIGMA² + AWAY_SIGMA², and the
 * tie band is the ±0.5 continuity window. Bookmakers rarely price this market
 * well in niche leagues, which is exactly why it is worth surfacing.
 */
export function mostCorners3Way(
  homeExpected: number,
  awayExpected: number,
): { home: number; draw: number; away: number } {
  const mean = homeExpected - awayExpected;
  const sd = Math.sqrt(HOME_SIGMA ** 2 + AWAY_SIGMA ** 2);
  const pUnderUpper = normalCdf((0.5 - mean) / sd); // P(diff <= 0.5)
  const pUnderLower = normalCdf((-0.5 - mean) / sd); // P(diff <= -0.5)
  const home = Math.max(0, 1 - pUnderUpper);
  const away = Math.max(0, pUnderLower);
  const draw = Math.max(0, 1 - home - away);
  const total = home + draw + away || 1;
  const r = (x: number) => Math.round((x / total) * 1000) / 1000;
  return { home: r(home), draw: r(draw), away: r(away) };
}
