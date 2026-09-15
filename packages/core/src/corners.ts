/**
 * Corners prediction module V5 — Negative Binomial line probabilities.
 *
 * Uses the V5 trained model's sigma (prediction error std) to compute
 * calibrated over/under probabilities via the Negative Binomial distribution.
 *
 * Team lines: O2.5, O3.5, O4.5, O5.5, O6.5, O7.5, O8.5
 * Total lines: O5.5, O6.5, O7.5, O8.5, O9.5, O10.5, O11.5, O12.5
 */

import type { CornerOutcome, CornerPrediction, Fixture } from "./types";

/**
 * v6 dispersion curves: sigma(mu) = slope * sqrt(mu) + intercept.
 *
 * Dispersion grows with the expected count, so a single sigma is wrong at both
 * ends of the ladder. These are the out-of-fold curves from
 * `train_corners_v6.py` (fitted on a model that never saw the evaluation slice,
 * because in-sample residuals understate real error and made every line
 * probability too extreme).
 *
 * These are FALLBACKS ONLY. The trainer stores the curves in
 * `corners_meta.json` and the predictor ships per-fixture probabilities, so in
 * production the numbers here are never used — they exist so demo mode and
 * older stored rows still render. The v5 constants were 2.849 / 2.456, which did
 * not even match that model's own metadata (2.832 / 2.4585).
 */
export const HOME_SIGMA_CURVE = { slope: 0.7686, intercept: 0.5117 };
export const AWAY_SIGMA_CURVE = { slope: 0.8386, intercept: 0.432 };
export const TOTAL_SIGMA_CURVE = { slope: 0.2702, intercept: 2.0637 };

/** sigma(mu) for a fitted curve, floored at 1 corner. */
export function sigmaFor(mu: number, curve: { slope: number; intercept: number }): number {
  return Math.max(1, curve.slope * Math.sqrt(Math.max(mu, 1)) + curve.intercept);
}

/** v6 curves evaluated at a typical team/total expectation, for callers that
 *  genuinely need one number (e.g. a demo row with no stored sigma). */
export const HOME_SIGMA = Math.round(sigmaFor(5.4, HOME_SIGMA_CURVE) * 1000) / 1000;
export const AWAY_SIGMA = Math.round(sigmaFor(4.6, AWAY_SIGMA_CURVE) * 1000) / 1000;
export const TOTAL_SIGMA = Math.round(sigmaFor(10.0, TOTAL_SIGMA_CURVE) * 1000) / 1000;

/** Team corner lines to compute probabilities for. */
export const TEAM_LINES = [2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5] as const;

/**
 * Total corner lines.
 *
 * 5.5 was dropped in v6: no bookmaker prices a 5.5 total in a top division, and
 * offering it invited a meaningless "Under 5.5" tail.
 */
export const TOTAL_LINES = [6.5, 7.5, 8.5, 9.5, 10.5, 11.5, 12.5] as const;

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
/**
 * Numbers the Python model computed itself and the worker should store verbatim.
 *
 * Passing these through matters: recomputing them here from constants is what
 * made the displayed probabilities differ from the model's output.
 */
export interface CornerPrecomputed {
  /** "O5.5" → probability, as emitted by the predictor. */
  homeLines?: Record<string, number>;
  awayLines?: Record<string, number>;
  totalLines?: Record<string, number>;
  totalCorners?: number;
  sigmaHome?: number;
  sigmaAway?: number;
  sigmaTotal?: number;
  hasOdds?: boolean;
  league?: string;
}

type TeamLines = {
  over25: number; over35: number; over45: number; over55: number;
  over65: number; over75: number; over85: number;
};

type TotalLines = {
  over55: number; over65: number; over75: number; over85: number;
  over95: number; over105: number; over115: number; over125: number;
};

/**
 * Translate the predictor's `{ "O5.5": 0.61 }` into the stored key shape,
 * falling back per-line when a rung is missing. Returning the fallback rather
 * than a partial object keeps the stored shape stable across model versions.
 */
function teamLinesFrom(src: Record<string, number> | undefined, fallback: TeamLines): TeamLines {
  if (!src || Object.keys(src).length === 0) return fallback;
  const at = (line: number, key: keyof TeamLines): number => {
    const v = src[`O${line}`];
    return typeof v === "number" ? v : fallback[key];
  };
  return {
    over25: at(2.5, "over25"), over35: at(3.5, "over35"), over45: at(4.5, "over45"),
    over55: at(5.5, "over55"), over65: at(6.5, "over65"), over75: at(7.5, "over75"),
    over85: at(8.5, "over85"),
  };
}

function totalLinesFrom(src: Record<string, number> | undefined, fallback: TotalLines): TotalLines {
  if (!src || Object.keys(src).length === 0) return fallback;
  const at = (line: number, key: keyof TotalLines): number => {
    const v = src[`O${line}`];
    return typeof v === "number" ? v : fallback[key];
  };
  return {
    over55: at(5.5, "over55"), over65: at(6.5, "over65"), over75: at(7.5, "over75"),
    over85: at(8.5, "over85"), over95: at(9.5, "over95"), over105: at(10.5, "over105"),
    over115: at(11.5, "over115"), over125: at(12.5, "over125"),
  };
}

/**
 * Build corner predictions for a fixture from the Python model's raw output.
 *
 * When `precomputed` is supplied (the v6 pipeline always supplies it) the model's
 * own line probabilities and sigmas are used unchanged. The NB fallback below is
 * only reached for legacy rows and demo data.
 *
 * @param fixture - The match
 * @param homeCorners - Python model's predicted corner count for home team
 * @param awayCorners - Python model's predicted corner count for away team
 * @param modelVersion - e.g. "corners-lgb-v6"
 * @param precomputed - the model's own line probs / sigmas / total, if available
 */
export function buildCornerPredictions(
  fixture: Fixture,
  homeCorners: number,
  awayCorners: number,
  modelVersion: string = "corners-lgb-v6",
  precomputed?: CornerPrecomputed,
): CornerPrediction[] {
  const now = Math.floor(Date.now() / 1000);
  const sigmaH = precomputed?.sigmaHome ?? sigmaFor(homeCorners, HOME_SIGMA_CURVE);
  const sigmaA = precomputed?.sigmaAway ?? sigmaFor(awayCorners, AWAY_SIGMA_CURVE);
  const homeCI = confidenceInterval(homeCorners, sigmaH);
  const awayCI = confidenceInterval(awayCorners, sigmaA);

  const totalExpected = precomputed?.totalCorners ?? homeCorners + awayCorners;
  const sigmaT = precomputed?.sigmaTotal ?? sigmaFor(totalExpected, TOTAL_SIGMA_CURVE);

  const fallbackTeamLines = (predicted: number, sigma: number): TeamLines => ({
    over25: overProb(predicted, sigma, 2.5),
    over35: overProb(predicted, sigma, 3.5),
    over45: overProb(predicted, sigma, 4.5),
    over55: overProb(predicted, sigma, 5.5),
    over65: overProb(predicted, sigma, 6.5),
    over75: overProb(predicted, sigma, 7.5),
    over85: overProb(predicted, sigma, 8.5),
  });

  // Total ladder keeps the historical key set so stored rows stay readable; the
  // 5.5 rung is the only one v6 no longer emits a probability for, and it is
  // filled from the same NB fallback rather than left undefined.
  const fallbackTotalLines = (mu: number): TotalLines => ({
    over55: overProb(mu, sigmaT, 5.5),
    over65: overProb(mu, sigmaT, 6.5),
    over75: overProb(mu, sigmaT, 7.5),
    over85: overProb(mu, sigmaT, 8.5),
    over95: overProb(mu, sigmaT, 9.5),
    over105: overProb(mu, sigmaT, 10.5),
    over115: overProb(mu, sigmaT, 11.5),
    over125: overProb(mu, sigmaT, 12.5),
  });

  const totalPre = totalLinesFrom(precomputed?.totalLines, fallbackTotalLines(totalExpected));

  const makePred = (
    side: "home" | "away",
    team: string,
    predicted: number,
    sigma: number,
    ci: { low: number; high: number },
    precomputedLines?: Record<string, number>,
  ): CornerPrediction => ({
    id: `${fixture.id}:corners:${side}`,
    fixtureId: fixture.id,
    team,
    side,
    predictedCorners: Math.round(predicted * 100) / 100,
    confidenceLow: ci.low,
    confidenceHigh: ci.high,
    lineProbs: teamLinesFrom(precomputedLines, fallbackTeamLines(predicted, sigma)),
    sigmaHome: sigmaH,
    sigmaAway: sigmaA,
    sigmaTotal: sigmaT,
    hasOdds: precomputed?.hasOdds,
    league: precomputed?.league,
    totalCorners: {
      expected: Math.round(totalExpected * 100) / 100,
      lines: totalPre,
    },
    modelVersion,
    createdAt: now,
  });

  return [
    makePred("home", fixture.homeTeam, homeCorners, sigmaH, homeCI, precomputed?.homeLines),
    makePred("away", fixture.awayTeam, awayCorners, sigmaA, awayCI, precomputed?.awayLines),
  ];
}

/* ------------------------------------------------------------------ *
 * Grading — how the corner predictions actually turned out
 * ------------------------------------------------------------------ */

/** One graded corner line: what the model claimed vs what happened. */
export interface GradedCornerLine {
  /** e.g. "O5.5" */
  line: number;
  side: "over" | "under";
  /** Model probability for this side. */
  probability: number;
  /** Did the line land? */
  won: boolean;
  /** Probability subtracted for a Brier score. */
  brier: number;
}

/** Every line of one prediction, graded against the real corner count. */
export interface GradedCornerPrediction {
  fixtureId: string;
  team: string;
  side: "home" | "away";
  market: "team" | "total";
  predicted: number;
  actual: number;
  error: number;
  /** sigma the model used, for the +/- band display. */
  sigma?: number;
  /** True when the real count fell inside the model's 80% band. */
  inBand: boolean;
  lines: GradedCornerLine[];
  /** Mean Brier across this prediction's lines — lower is better. */
  brier: number;
}

export interface CornerCalibrationBin {
  /** Bin label, e.g. "0.70-0.80". */
  label: string;
  predicted: number;
  observed: number;
  n: number;
}

export interface CornerScoreboard {
  /** 'team' lines and 'total' lines scored separately — they are different bets
   *  and they performed very differently. */
  team: { n: number; brier: number; lineAccuracy: number };
  total: { n: number; brier: number; lineAccuracy: number };
  mae: { home: number; away: number; total: number };
  /** How often the real count landed inside the 80% interval. Should be ~0.80. */
  bandCoverage: number;
  /** Predicted-vs-observed reliability, across both markets. */
  calibration: CornerCalibrationBin[];
  /** Only rows whose fixture has a recorded result. */
  graded: number;
  /** Predictions with no result yet. */
  pending: number;
}

function lineToNumber(key: string): number | null {
  const m = /^over(\d)(\d)?$/.exec(key);
  if (!m) return null;
  return m[2] !== undefined ? Number(`${m[1]}.${m[2]}`) : Number(m[1]);
}

/**
 * Grade every corner line of one prediction against the real count.
 *
 * Both sides of each ladder rung are scored, because a model can be right about
 * "Over 4.5" and wrong about "Under 4.5" in the same match — only scoring the
 * Over side would flatter it.
 */
function gradeLines(
  lines: Record<string, number>,
  actual: number,
): GradedCornerLine[] {
  const out: GradedCornerLine[] = [];
  for (const [key, probability] of Object.entries(lines)) {
    const line = lineToNumber(key);
    if (line === null || typeof probability !== "number") continue;
    // A line is never exactly a whole number of corners, so no push handling is
    // needed: >5.5 is decided by the integer count.
    const overWon = actual > line;
    out.push({
      line, side: "over", probability, won: overWon, brier: (probability - (overWon ? 1 : 0)) ** 2,
    });
    const underProb = 1 - probability;
    out.push({
      line, side: "under", probability: underProb, won: !overWon,
      brier: (underProb - (overWon ? 0 : 1)) ** 2,
    });
  }
  return out;
}

/**
 * Grade a set of corner predictions against recorded results.
 *
 * Nothing here is filtered to "picks" — every stored line is scored, so the
 * scoreboard cannot be improved by declining to publish the bad lines.
 */
export function gradeCornerPredictions(
  predictions: readonly CornerPrediction[],
  outcomes: readonly CornerOutcome[],
  fixtures: readonly Fixture[] = [],
): { rows: GradedCornerPrediction[]; scoreboard: CornerScoreboard } {
  const byFixture = new Map(outcomes.map((o) => [o.fixtureId, o]));
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  const rows: GradedCornerPrediction[] = [];
  const teamLines: GradedCornerLine[] = [];
  const totalLines: GradedCornerLine[] = [];
  const muErr: { home: number[]; away: number[]; total: number[] } = { home: [], away: [], total: [] };
  let inBand = 0;
  let bandTotal = 0;

  for (const p of predictions) {
    const outcome = byFixture.get(p.fixtureId);
    if (!outcome) continue;
    const actual = p.side === "home" ? outcome.homeCorners : outcome.awayCorners;
    const sigma = p.side === "home" ? p.sigmaHome : p.sigmaAway;
    const lines = gradeLines(p.lineProbs as unknown as Record<string, number>, actual);
    const brier = lines.length > 0 ? lines.reduce((a, l) => a + l.brier, 0) / lines.length : 0;

    muErr[p.side].push(Math.abs(p.predictedCorners - actual));
    if (sigma != null) {
      bandTotal += 1;
      if (Math.abs(actual - p.predictedCorners) <= 1.28 * sigma) inBand += 1;
    }
    teamLines.push(...lines);

    rows.push({
      fixtureId: p.fixtureId,
      team: p.team,
      side: p.side,
      market: "team",
      predicted: p.predictedCorners,
      actual,
      error: Math.round(Math.abs(p.predictedCorners - actual) * 100) / 100,
      sigma,
      inBand: sigma == null ? true : Math.abs(actual - p.predictedCorners) <= 1.28 * sigma,
      lines,
      brier: Math.round(brier * 10000) / 10000,
    });

    // The total is stored on BOTH team rows; grade it once, from the home row.
    if (p.side === "home" && p.totalCorners) {
      const totalActual = outcome.totalCorners;
      const tLines = gradeLines(p.totalCorners.lines as unknown as Record<string, number>, totalActual);
      const tBrier = tLines.length > 0 ? tLines.reduce((a, l) => a + l.brier, 0) / tLines.length : 0;
      muErr.total.push(Math.abs(p.totalCorners.expected - totalActual));
      if (p.sigmaTotal != null) {
        bandTotal += 1;
        if (Math.abs(totalActual - p.totalCorners.expected) <= 1.28 * p.sigmaTotal) inBand += 1;
      }
      totalLines.push(...tLines);
      rows.push({
        fixtureId: p.fixtureId,
        team: `${fixtureById.get(p.fixtureId)?.homeTeam ?? p.team} + ${fixtureById.get(p.fixtureId)?.awayTeam ?? ""}`.trim(),
        side: "home",
        market: "total",
        predicted: p.totalCorners.expected,
        actual: totalActual,
        error: Math.round(Math.abs(p.totalCorners.expected - totalActual) * 100) / 100,
        sigma: p.sigmaTotal,
        inBand: p.sigmaTotal == null
          ? true
          : Math.abs(totalActual - p.totalCorners.expected) <= 1.28 * p.sigmaTotal,
        lines: tLines,
        brier: Math.round(tBrier * 10000) / 10000,
      });
    }
  }

  const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const lineAccuracy = (ls: GradedCornerLine[]) => (ls.length > 0 ? ls.filter((l) => l.won).length / ls.length : 0);

  // Reliability bins over every graded line from both markets.
  const all = [...teamLines, ...totalLines];
  const calibration: CornerCalibrationBin[] = [];
  for (let lo = 0.5; lo < 0.95; lo += 0.1) {
    const hi = lo + 0.1;
    const bin = all.filter((l) => l.probability >= lo && l.probability < hi);
    if (bin.length === 0) continue;
    calibration.push({
      label: `${lo.toFixed(2)}-${hi.toFixed(2)}`,
      predicted: Math.round(mean(bin.map((l) => l.probability)) * 10000) / 10000,
      observed: Math.round((bin.filter((l) => l.won).length / bin.length) * 10000) / 10000,
      n: bin.length,
    });
  }

  const gradedFixtures = new Set(rows.map((r) => r.fixtureId));
  return {
    rows,
    scoreboard: {
      team: {
        n: teamLines.length,
        brier: Math.round(mean(teamLines.map((l) => l.brier)) * 10000) / 10000,
        lineAccuracy: Math.round(lineAccuracy(teamLines) * 10000) / 10000,
      },
      total: {
        n: totalLines.length,
        brier: Math.round(mean(totalLines.map((l) => l.brier)) * 10000) / 10000,
        lineAccuracy: Math.round(lineAccuracy(totalLines) * 10000) / 10000,
      },
      mae: {
        home: Math.round(mean(muErr.home) * 100) / 100,
        away: Math.round(mean(muErr.away) * 100) / 100,
        total: Math.round(mean(muErr.total) * 100) / 100,
      },
      bandCoverage: bandTotal > 0 ? Math.round((inBand / bandTotal) * 10000) / 10000 : 0,
      calibration,
      graded: gradedFixtures.size,
      pending: predictions.length > 0
        ? new Set(predictions.map((p) => p.fixtureId)).size - gradedFixtures.size
        : 0,
    },
  };
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
  const curve = side === "home" ? HOME_SIGMA_CURVE : AWAY_SIGMA_CURVE;
  const sigma = sigmaFor(predicted, curve);
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
  const sigma = sigmaFor(totalExpected, TOTAL_SIGMA_CURVE);
  return {
    over55: overProb(totalExpected, sigma, 5.5),
    over65: overProb(totalExpected, sigma, 6.5),
    over75: overProb(totalExpected, sigma, 7.5),
    over85: overProb(totalExpected, sigma, 8.5),
    over95: overProb(totalExpected, sigma, 9.5),
    over105: overProb(totalExpected, sigma, 10.5),
    over115: overProb(totalExpected, sigma, 11.5),
    over125: overProb(totalExpected, sigma, 12.5),
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
  return cornerSafeBand(
    totalExpected,
    sigmaFor(totalExpected, TOTAL_SIGMA_CURVE),
    TOTAL_LINES,
    minProb,
  );
}

/** Team-corners safe band from the team's expected corners. */
export function teamCornerSafeBand(
  expected: number,
  side: "home" | "away",
  minProb = 0.7,
): CornerBand {
  const curve = side === "home" ? HOME_SIGMA_CURVE : AWAY_SIGMA_CURVE;
  return cornerSafeBand(expected, sigmaFor(expected, curve), TEAM_LINES, minProb);
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
  // sigma(mu) at each side's own expectation; the difference's variance is the
  // sum only because the model gives no cross-side correlation for this read.
  const sd = Math.sqrt(
    sigmaFor(homeExpected, HOME_SIGMA_CURVE) ** 2 + sigmaFor(awayExpected, AWAY_SIGMA_CURVE) ** 2,
  );
  const pUnderUpper = normalCdf((0.5 - mean) / sd); // P(diff <= 0.5)
  const pUnderLower = normalCdf((-0.5 - mean) / sd); // P(diff <= -0.5)
  const home = Math.max(0, 1 - pUnderUpper);
  const away = Math.max(0, pUnderLower);
  const draw = Math.max(0, 1 - home - away);
  const total = home + draw + away || 1;
  const r = (x: number) => Math.round((x / total) * 1000) / 1000;
  return { home: r(home), draw: r(draw), away: r(away) };
}
