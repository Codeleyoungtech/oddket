/**
 * Probability & calibration math. Pure functions, no side effects.
 */

/** Decimal odds → raw implied probability (1/odds). */
export function decimalToProb(odds: number): number {
  if (odds <= 1) return 0;
  return 1 / odds;
}

/** Probability → fair decimal odds. */
export function probToDecimal(p: number): number {
  if (p <= 0 || p >= 1) return 1;
  return 1 / p;
}

/**
 * Remove the bookmaker overround from a set of implied probabilities.
 * `probs` should be a complete market (all outcomes sum to > 1).
 * Returns normalized probabilities summing to 1.
 */
export function normalizeImplied(probs: number[]): number[] {
  const sum = probs.reduce((a, b) => a + b, 0);
  if (sum <= 0) return probs.map(() => 0);
  return probs.map((p) => p / sum);
}

/** Brier score for a single prediction: (p − y)², y ∈ {0,1}. */
export function brier(p: number, y: number): number {
  return (p - y) * (p - y);
}

/** Mean Brier score over a set of (p, y) pairs. Lower is better (0..1). */
export function meanBrier(pairs: Array<{ p: number; y: number }>): number {
  if (pairs.length === 0) return 0;
  return pairs.reduce((acc, { p, y }) => acc + brier(p, y), 0) / pairs.length;
}

/**
 * Wilson score interval — a sane confidence interval for a proportion
 * that doesn't collapse to zero width at p=0 or p=1.
 * Returns [low, high].
 */
export function wilsonInterval(p: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [p, p];
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Fractional closing-line value: (odds taken − closing) / closing. */
export function clvFractional(takenOdds: number, closingOdds: number): number {
  if (closingOdds <= 1) return 0;
  return (takenOdds - closingOdds) / closingOdds;
}

/** Compound (joint) probability of independent legs. */
export function compoundProbability(probs: number[]): number {
  return probs.reduce((acc, p) => acc * p, 1);
}

/** True compounded decimal odds implied by a set of independent probabilities. */
export function compoundFairOdds(probs: number[]): number {
  const joint = compoundProbability(probs);
  return joint > 0 ? 1 / joint : 1;
}

/** Total expected goals for a fixture from two Poisson intensities. */
export function poissonCdfGoals(lambda: number, k: number): number {
  // P(X <= k) for Poisson(lambda)
  let sum = 0;
  let term = Math.exp(-lambda);
  sum = term;
  for (let i = 1; i <= k; i++) {
    term = (term * lambda) / i;
    sum += term;
  }
  return sum;
}

/** P(goals > threshold) from Poisson intensities. */
export function overProbability(lambdaHome: number, lambdaAway: number, threshold: number): number {
  const k = Math.floor(threshold);
  return 1 - poissonCdfGoals(lambdaHome + lambdaAway, k);
}

/** P(both teams score) from Poisson intensities. */
export function bttsProbability(lambdaHome: number, lambdaAway: number): number {
  return (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway));
}

/** Deterministic PRNG (mulberry32) — powers the reproducible seed dataset. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box–Muller, using a 0..1 RNG. */
export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-9);
  const v = Math.max(rng(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Clamp into [0,1]. */
export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Poisson sample from a RNG. */
export function poissonSample(lambda: number, rng: () => number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L && k < 20);
  return k - 1;
}

/** Round to a number of decimal places (avoids float dust). */
export function round(x: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON) * f) / f;
}

/** Format a probability as a percentage string. */
export function pct(p: number, dp = 1): string {
  return `${(p * 100).toFixed(dp)}%`;
}
