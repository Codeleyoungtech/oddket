/**
 * Corners prediction module — isolated from h2h/totals.
 *
 * No EV/odds layer. Just raw model output: predicted corner count per team
 * with confidence intervals and over/under line probabilities.
 *
 * The Python model (train_corners.py) outputs a predicted corner count.
 * This module computes line probabilities from that prediction using
 * a normal approximation calibrated to the model's MAE.
 */

import type { CornerPrediction, Fixture } from "./types";

/** Model's measured MAE from the backtest — used to derive σ for line probs. */
const HOME_MAE = 1.821;
const AWAY_MAE = 1.803;
/** MAE ≈ 0.8 * σ for a normal distribution → σ = MAE / 0.8 */
const HOME_SIGMA = HOME_MAE / 0.8;
const AWAY_SIGMA = AWAY_MAE / 0.8;

/** Common corner lines to compute probabilities for. */
const LINES = [3.5, 4.5, 5.5, 6.5] as const;

/**
 * Standard normal CDF approximation (Abramowitz & Stegun).
 * P(X ≤ x) for X ~ N(0,1).
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1.0 / (1.0 + p * Math.abs(x));
  const y =
    1.0 -
    ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x * 0.5);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Probability that a team clears a corner line, given predicted count and σ.
 * P(X > line) = 1 - Φ((line - μ) / σ)
 */
function overProbability(predicted: number, sigma: number, line: number): number {
  const z = (line - predicted) / sigma;
  return Math.round((1 - normalCDF(z)) * 1000) / 1000; // 3 decimal places
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
    low: Math.round((predicted - z80 * sigma) * 100) / 100,
    high: Math.round((predicted + z80 * sigma) * 100) / 100,
  };
}

/**
 * Build corner predictions for a fixture from the Python model's raw output.
 *
 * @param fixture - The match
 * @param homeCorners - Python model's predicted corner count for home team
 * @param awayCorners - Python model's predicted corner count for away team
 * @param modelVersion - e.g. "corners-xgb-v2"
 */
export function buildCornerPredictions(
  fixture: Fixture,
  homeCorners: number,
  awayCorners: number,
  modelVersion: string = "corners-xgb-v2",
): CornerPrediction[] {
  const now = Math.floor(Date.now() / 1000);
  const homeCI = confidenceInterval(homeCorners, HOME_SIGMA);
  const awayCI = confidenceInterval(awayCorners, AWAY_SIGMA);

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
      over35: overProbability(predicted, sigma, 3.5),
      over45: overProbability(predicted, sigma, 4.5),
      over55: overProbability(predicted, sigma, 5.5),
      over65: overProbability(predicted, sigma, 6.5),
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
  return [
    `Over 3.5 corners: ${(pred.lineProbs.over35 * 100).toFixed(0)}%`,
    `Over 4.5 corners: ${(pred.lineProbs.over45 * 100).toFixed(0)}%`,
    `Over 5.5 corners: ${(pred.lineProbs.over55 * 100).toFixed(0)}%`,
    `Over 6.5 corners: ${(pred.lineProbs.over65 * 100).toFixed(0)}%`,
  ];
}

/**
 * Get the "recommended" line for a team — the line where the model has
 * the strongest opinion (furthest from 50%).
 *
 * Returns the line and its probability, or null if no line is interesting.
 */
export function bestCornerLine(
  pred: CornerPrediction,
): { line: number; over: boolean; probability: number } | null {
  const probs = [
    { line: 3.5, over: true, probability: pred.lineProbs.over35 },
    { line: 3.5, over: false, probability: 1 - pred.lineProbs.over35 },
    { line: 4.5, over: true, probability: pred.lineProbs.over45 },
    { line: 4.5, over: false, probability: 1 - pred.lineProbs.over45 },
    { line: 5.5, over: true, probability: pred.lineProbs.over55 },
    { line: 5.5, over: false, probability: 1 - pred.lineProbs.over55 },
    { line: 6.5, over: true, probability: pred.lineProbs.over65 },
    { line: 6.5, over: false, probability: 1 - pred.lineProbs.over65 },
  ];
  // Find the line furthest from 50% (strongest opinion)
  let best: (typeof probs)[0] | null = null;
  let bestDist = 0;
  for (const item of probs) {
    const dist = Math.abs(item.probability - 0.5);
    if (dist > bestDist && item.probability >= 0.55) {
      bestDist = dist;
      best = item;
    }
  }
  return best;
}
