/**
 * The OddKet RULE BOOK — frozen selection rules.
 *
 * These rules were mined by hand from the graded prediction history (exported
 * from /history as CSV) over the first ~94 settled fixtures, then re-tested
 * against the next batch (118 settled). They are FROZEN: no threshold on this
 * list may ever be adjusted to make a failed rule look better. A rule that
 * loses, loses — we record it and keep the denominator growing.
 *
 * The point of encoding them here (rather than leaving them in a spreadsheet)
 * is that every rule becomes deterministic and reproducible:
 *
 *   1. filter live predictions down to rule-compliant picks,
 *   2. track each rule's record as new fixtures settle (target: 300 fixtures),
 *   3. keep the model and the rule book honest about which is which.
 *
 * Rules are conditions on the MODEL's own probabilities for one fixture. Every
 * metric is a model probability (0..1) pulled from the fixture's predictions,
 * so a rule only applies to a fixture when that fixture has a complete
 * prediction set across the six football markets.
 *
 * ── Status legend ────────────────────────────────────────────────────────────
 *   surviving    — still 100% after the second batch; keep testing hard
 *   experimental — still 100%, but the qualifying sample is too small to trust
 *   failed       — broke on the second batch; recorded, never resurrected by
 *                  moving a threshold
 */

import type { Fixture, Market, Outcome, Prediction, Selection } from "./types";
import { selectionWon } from "./aggregates";

/** Denominators grow; this is the sample size the rule book is being tested to. */
export const RULES_TARGET_FIXTURES = 300;

/** The fixture count the rules were first mined on (before the freeze). */
export const RULES_FREEZE_FIXTURES = 94;

export type RuleStatus = "surviving" | "experimental" | "failed";

/** Raw model probabilities a rule condition can read, for one fixture. */
export type RuleFeatureKey = "H" | "D" | "A" | "O25" | "U25" | "HG" | "AG" | "DC12";

export type RuleFeatures = Partial<Record<RuleFeatureKey, number>>;

/**
 * Derived metrics the rules actually compare — differences between two model
 * probabilities, expressed in probability points (so `>= 0.425` reads as
 * "42.5pp" in the docs).
 */
export type RuleMetric =
  | RuleFeatureKey
  | "H-D"
  | "H-A"
  | "A-D"
  | "O25-U25"
  | "AG-O25"
  | "HG-AG";

export interface RuleCondition {
  /** Metric the threshold applies to. */
  metric: RuleMetric;
  op: ">=" | "<=";
  threshold: number;
  /** Human-readable threshold, e.g. "Home win ≥ 60%". */
  label: string;
}

export interface Rule {
  id: string;
  /** Short name shown in chips, e.g. "Home scores". */
  short: string;
  status: RuleStatus;
  /** The market the rule says to back. */
  market: Market;
  selection: Selection;
  /** Human-readable target, e.g. "Home team to score". */
  targetLabel: string;
  /** All conditions must hold (logical AND — these rules are conjunctions). */
  conditions: RuleCondition[];
  /** Record at the moment the rule was frozen, from the rule-mining pass. */
  frozenRecord: { hits: number; qualifying: number };
  /** Why this rule is in the book — kept verbatim from the mining notes. */
  note: string;
}

/** Human labels for the raw feature keys. */
const FEATURE_LABEL: Record<RuleFeatureKey, string> = {
  H: "Home win",
  D: "Draw",
  A: "Away win",
  O25: "Over 2.5",
  U25: "Under 2.5",
  HG: "Home team scores",
  AG: "Away team scores",
  DC12: "Double chance 12",
};

/** Condition builder — keeps the rule table below readable and typo-proof. */
function cond(metric: RuleMetric, op: ">=" | "<=", threshold: number, label: string): RuleCondition {
  return { metric, op, threshold, label };
}

/**
 * The frozen rule book. Order matters only for display: surviving first.
 *
 * R1–R4 survived the second batch. R5–R13 were perfect on batch 1 and broke on
 * batch 2; they stay listed so the failure stays visible.
 */
export const RULES: Rule[] = [
  {
    id: "R1",
    short: "Home scores",
    status: "surviving",
    market: "team_home_goals",
    selection: "yes",
    targetLabel: "Home team to score",
    conditions: [
      cond("H", ">=", 0.6, "Home win ≥ 60%"),
      cond("O25", ">=", 0.55, "Over 2.5 ≥ 55%"),
    ],
    frozenRecord: { hits: 12, qualifying: 12 },
    note: "The strongest survivor. Same goal-expectation condition that used to look universal — but now only the home-to-score leg still holds.",
  },
  {
    id: "R2",
    short: "Under 2.5",
    status: "surviving",
    market: "totals",
    selection: "under",
    targetLabel: "Under 2.5 goals",
    conditions: [
      cond("O25-U25", "<=", -0.025, "O2.5 − U2.5 ≤ −2.5pp"),
      cond("DC12", ">=", 0.7, "Double chance 12 ≥ 70%"),
    ],
    frozenRecord: { hits: 9, qualifying: 9 },
    note: "The model leaning Under AND the fixture not being a coin-flip between home and away.",
  },
  {
    id: "R3",
    short: "Home win",
    status: "surviving",
    market: "h2h",
    selection: "home",
    targetLabel: "Home win",
    conditions: [
      cond("H", ">=", 0.6, "Home win ≥ 60%"),
      cond("AG-O25", "<=", 0.125, "Away scores − Over 2.5 ≤ 12.5pp"),
    ],
    frozenRecord: { hits: 9, qualifying: 9 },
    note: "Notable because it is a perfect record on an actual 1X2 market, not just a goal market.",
  },
  {
    id: "R4",
    short: "Away no score",
    status: "experimental",
    market: "team_away_goals",
    selection: "no",
    targetLabel: "Away team NOT to score",
    conditions: [
      cond("H", "<=", 0.6, "Home win ≤ 60%"),
      cond("H-A", ">=", 0.425, "Home − Away ≥ 42.5pp"),
    ],
    frozenRecord: { hits: 5, qualifying: 5 },
    note: "Still perfect, but sample is too small to call production-grade.",
  },
  {
    id: "R5",
    short: "Over 2.5 (broke)",
    status: "failed",
    market: "totals",
    selection: "over",
    targetLabel: "Over 2.5 goals",
    conditions: [
      cond("H", ">=", 0.6, "Home win ≥ 60%"),
      cond("O25", ">=", 0.55, "Over 2.5 ≥ 55%"),
    ],
    frozenRecord: { hits: 11, qualifying: 12 },
    note: "Used to look like a universal confirmation rule. Galatasaray 1–0 Kocaelispor broke it. The condition is still useful — just not for every market.",
  },
  {
    id: "R6",
    short: "Over 2.5 (broke)",
    status: "failed",
    market: "totals",
    selection: "over",
    targetLabel: "Over 2.5 goals",
    conditions: [
      cond("H-D", ">=", 0.325, "Home − Draw ≥ 32.5pp"),
      cond("O25-U25", ">=", 0.175, "O2.5 − U2.5 ≥ 17.5pp"),
    ],
    frozenRecord: { hits: 13, qualifying: 14 },
    note: "Broke on the second batch.",
  },
  {
    id: "R7",
    short: "Over 1.5 (broke)",
    status: "failed",
    market: "ou15",
    selection: "over",
    targetLabel: "Over 1.5 goals",
    conditions: [
      cond("H", ">=", 0.6, "Home win ≥ 60%"),
      cond("AG", ">=", 0.65, "Away team scores ≥ 65%"),
    ],
    frozenRecord: { hits: 11, qualifying: 12 },
    note: "Broke on the second batch.",
  },
  {
    id: "R8",
    short: "Over 1.5 (broke)",
    status: "failed",
    market: "ou15",
    selection: "over",
    targetLabel: "Over 1.5 goals",
    conditions: [
      cond("H-D", ">=", 0.175, "Home − Draw ≥ 17.5pp"),
      cond("AG-O25", "<=", 0.1, "Away scores − Over 2.5 ≤ 10pp"),
    ],
    frozenRecord: { hits: 18, qualifying: 19 },
    note: "Broke on the second batch.",
  },
  {
    id: "R9",
    short: "Home scores (broke)",
    status: "failed",
    market: "team_home_goals",
    selection: "yes",
    targetLabel: "Home team to score",
    conditions: [
      cond("H-A", "<=", 0.425, "Home − Away ≤ 42.5pp"),
      cond("H-D", ">=", 0.225, "Home − Draw ≥ 22.5pp"),
    ],
    frozenRecord: { hits: 19, qualifying: 21 },
    note: "Broke on the second batch — R1's weaker sibling.",
  },
  {
    id: "R10",
    short: "Away scores (broke)",
    status: "failed",
    market: "team_away_goals",
    selection: "yes",
    targetLabel: "Away team to score",
    conditions: [
      cond("H-A", "<=", 0.275, "Home − Away ≤ 27.5pp"),
      cond("HG-AG", ">=", 0.1, "Home scores − Away scores ≥ 10pp"),
    ],
    frozenRecord: { hits: 16, qualifying: 17 },
    note: "Broke on the second batch.",
  },
  {
    id: "R11",
    short: "Away scores (broke)",
    status: "failed",
    market: "team_away_goals",
    selection: "yes",
    targetLabel: "Away team to score",
    conditions: [
      cond("H", "<=", 0.45, "Home win ≤ 45%"),
      cond("HG", ">=", 0.8, "Home team scores ≥ 80%"),
    ],
    frozenRecord: { hits: 13, qualifying: 14 },
    note: "Broke on the second batch.",
  },
  {
    id: "R12",
    short: "Away win (broke)",
    status: "failed",
    market: "h2h",
    selection: "away",
    targetLabel: "Away win",
    conditions: [
      cond("A-D", ">=", -0.05, "Away − Draw ≥ −5pp"),
      cond("HG-AG", ">=", 0.15, "Home scores − Away scores ≥ 15pp"),
    ],
    frozenRecord: { hits: 5, qualifying: 6 },
    note: "Broke on the second batch.",
  },
  {
    id: "R13",
    short: "DC12 (broke)",
    status: "failed",
    market: "dc12",
    selection: "12",
    targetLabel: "Double chance 12 (no draw)",
    conditions: [
      cond("DC12", ">=", 0.775, "Double chance 12 ≥ 77.5%"),
      cond("H", "<=", 0.7, "Home win ≤ 70%"),
    ],
    frozenRecord: { hits: 19, qualifying: 21 },
    note: "Broke on the second batch.",
  },
];

/** Rules still worth acting on (surviving + experimental), in book order. */
export const ACTIVE_RULES: Rule[] = RULES.filter((r) => r.status !== "failed");

export const RULES_BY_ID: Record<string, Rule> = Object.fromEntries(RULES.map((r) => [r.id, r]));

/** Resolved metric value for a fixture, or null when the input is missing. */
export function metricValue(f: RuleFeatures, metric: RuleMetric): number | null {
  const diff = (a: RuleFeatureKey, b: RuleFeatureKey): number | null => {
    const x = f[a];
    const y = f[b];
    return x == null || y == null ? null : x - y;
  };
  switch (metric) {
    case "H-D":
      return diff("H", "D");
    case "H-A":
      return diff("H", "A");
    case "A-D":
      return diff("A", "D");
    case "O25-U25":
      return diff("O25", "U25");
    case "AG-O25":
      return diff("AG", "O25");
    case "HG-AG":
      return diff("HG", "AG");
    default: {
      const v = f[metric];
      return v == null ? null : v;
    }
  }
}

/** Does a fixture's probability set satisfy every condition on the rule? */
export function ruleMatches(rule: Rule, f: RuleFeatures): boolean {
  for (const c of rule.conditions) {
    const v = metricValue(f, c.metric);
    if (v == null) return false;
    if (c.op === ">=" ? !(v >= c.threshold) : !(v <= c.threshold)) return false;
  }
  return true;
}

/**
 * Pull a fixture's rule features out of its prediction rows.
 *
 * A rule needs the whole six-market set (1X2, 2.5 line, both team-goal lines,
 * DC12). Missing pieces leave the metric null, `ruleMatches` returns false, and
 * the fixture is excluded from BOTH the numerator and the denominator — an
 * incomplete fixture is never counted as a hit or a miss.
 */
export function extractRuleFeatures(predictions: readonly Prediction[]): RuleFeatures {
  const f: RuleFeatures = {};
  for (const p of predictions) {
    if (p.market === "h2h" && p.selection === "home") f.H = p.probability;
    else if (p.market === "h2h" && p.selection === "draw") f.D = p.probability;
    else if (p.market === "h2h" && p.selection === "away") f.A = p.probability;
    else if (p.market === "totals" && p.selection === "over") f.O25 = p.probability;
    else if (p.market === "totals" && p.selection === "under") f.U25 = p.probability;
    else if (p.market === "team_home_goals" && p.selection === "yes") f.HG = p.probability;
    else if (p.market === "team_away_goals" && p.selection === "yes") f.AG = p.probability;
    else if (p.market === "dc12" && p.selection === "12") f.DC12 = p.probability;
  }
  return f;
}

/** A rule that fires on a fixture, and the leg it selects. */
export interface RuleApplication {
  ruleId: string;
  rule: Rule;
  market: Market;
  selection: Selection;
}

/** Every rule that fires on this fixture's probability set. */
export function ruleApplications(predictions: readonly Prediction[]): RuleApplication[] {
  const f = extractRuleFeatures(predictions);
  if (Object.keys(f).length === 0) return [];
  const out: RuleApplication[] = [];
  for (const rule of RULES) {
    if (ruleMatches(rule, f)) out.push({ ruleId: rule.id, rule, market: rule.market, selection: rule.selection });
  }
  return out;
}

/**
 * Index rule applications by fixture id, for the whole database.
 *
 * Grouping predictions first means one pass over predictions + one per fixture,
 * instead of scanning every prediction for every rule — the difference between
 * a smooth filter and a frozen one on a 3,000-row prediction set.
 */
export function ruleApplicationsByFixture(
  predictions: readonly Prediction[],
): Map<string, RuleApplication[]> {
  const byFixture = new Map<string, Prediction[]>();
  for (const p of predictions) {
    const arr = byFixture.get(p.fixtureId);
    if (arr) arr.push(p);
    else byFixture.set(p.fixtureId, [p]);
  }
  const out = new Map<string, RuleApplication[]>();
  for (const [fixtureId, preds] of byFixture) {
    const apps = ruleApplications(preds);
    if (apps.length > 0) out.set(fixtureId, apps);
  }
  return out;
}

/** Would this leg be a rule pick? Used for chips on slips and history rows. */
export function applicationsForLeg(
  apps: readonly RuleApplication[] | undefined,
  market: Market,
  selection: Selection,
  opts: { activeOnly?: boolean } = {},
): RuleApplication[] {
  if (!apps) return [];
  return apps.filter(
    (a) => a.market === market && a.selection === selection && (!opts.activeOnly || a.rule.status !== "failed"),
  );
}

/** One rule's live record against every settled fixture. */
export interface RuleStanding {
  rule: Rule;
  /** Settled fixtures whose probabilities satisfy the rule. */
  qualifying: number;
  /** How many of those the rule's target leg actually won. */
  hits: number;
  /** hits / qualifying, or null while nothing has qualified yet. */
  hitRate: number | null;
  /** Change since the freeze: qualifying fixtures added on this run. */
  sinceFreeze: { qualifying: number; hits: number };
  /** True once the rule has ever lost — a status change, not a threshold change. */
  brokenSinceFreeze: boolean;
}

/**
 * Score every rule in the book against the settled fixtures.
 *
 * Only fixtures with a recorded outcome count, and only when the rule's own
 * target market has a prediction to grade. Everything else is skipped rather
 * than guessed at.
 */
export function evaluateRuleStandings(
  fixtures: readonly Fixture[],
  predictions: readonly Prediction[],
  outcomes: readonly Outcome[],
): RuleStanding[] {
  const outcomeBy = new Map(outcomes.map((o) => [o.fixtureId, o]));
  const appsByFixture = ruleApplicationsByFixture(predictions);

  const tally = new Map<string, { qualifying: number; hits: number }>();
  for (const rule of RULES) tally.set(rule.id, { qualifying: 0, hits: 0 });

  for (const fixture of fixtures) {
    const outcome = outcomeBy.get(fixture.id);
    if (!outcome) continue;
    const apps = appsByFixture.get(fixture.id);
    if (!apps) continue;
    for (const app of apps) {
      const bucket = tally.get(app.ruleId);
      if (!bucket) continue;
      const won = selectionWon(app.market, app.selection, outcome.homeScore, outcome.awayScore);
      bucket.qualifying += 1;
      if (won) bucket.hits += 1;
    }
  }

  return RULES.map((rule) => {
    const t = tally.get(rule.id) ?? { qualifying: 0, hits: 0 };
    return {
      rule,
      qualifying: t.qualifying,
      hits: t.hits,
      hitRate: t.qualifying > 0 ? t.hits / t.qualifying : null,
      sinceFreeze: {
        qualifying: t.qualifying - rule.frozenRecord.qualifying,
        hits: t.hits - rule.frozenRecord.hits,
      },
      brokenSinceFreeze: t.hits < t.qualifying,
    };
  });
}

/** Settled fixtures available to score against — the growing denominator. */
export function settledFixtureCount(
  fixtures: readonly Fixture[],
  outcomes: readonly Outcome[],
): number {
  const settled = new Set(outcomes.map((o) => o.fixtureId));
  let n = 0;
  for (const f of fixtures) if (settled.has(f.id)) n += 1;
  return n;
}

/** Rule pick for one fixture — the leg(s) the book says to back. */
export function rulePicksForFixture(
  predictions: readonly Prediction[],
  opts: { activeOnly?: boolean } = {},
): RuleApplication[] {
  const apps = ruleApplications(predictions);
  return opts.activeOnly ? apps.filter((a) => a.rule.status !== "failed") : apps;
}
