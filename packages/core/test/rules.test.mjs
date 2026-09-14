/**
 * Rule book regression test.
 *
 * The rule book is FROZEN (see packages/core/src/rules.ts). This test exists to
 * make two failure modes loud:
 *
 *   1. Someone quietly moves a threshold to rescue a rule that lost. The exact
 *      threshold values are asserted below, so a "small tweak" fails the suite.
 *   2. The feature extraction or settle logic drifts and starts counting hits
 *      that did not happen.
 *
 * Runs against the real TypeScript module (bundled with esbuild), so it tests
 * what the app actually ships rather than a copy.
 *
 *   node packages/core/test/rules.test.mjs   (from the repo root)
 */

import { build } from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const outDir = mkdtempSync(join(tmpdir(), "oddket-rules-"));
const outfile = join(outDir, "rules.mjs");
await build({
  entryPoints: [join(ROOT, "packages", "core", "src", "rules.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile,
  logLevel: "warning",
});

const R = await import(pathToFileURL(outfile).href);
rmSync(outDir, { recursive: true, force: true });

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/* ---------------- synthetic fixtures ---------------- */

/** Build one fixture's full six-market prediction set from a feature vector. */
function predictionsFor(fixtureId, f) {
  const now = 1_700_000_000;
  const rows = [
    ["h2h", "home", f.H],
    ["h2h", "draw", f.D],
    ["h2h", "away", f.A],
    ["totals", "over", f.O25],
    ["totals", "under", f.U25],
    ["team_home_goals", "yes", f.HG],
    ["team_away_goals", "yes", f.AG],
    ["dc12", "12", f.DC12],
  ];
  return rows
    .filter(([, , p]) => p !== undefined)
    .map(([market, selection, probability], i) => ({
      id: `${fixtureId}-p${i}`,
      fixtureId,
      market,
      selection,
      probability,
      confidenceLow: Math.max(0, probability - 0.1),
      confidenceHigh: Math.min(1, probability + 0.1),
      modelVersion: "test",
      createdAt: now,
    }));
}

const fixture = (id) => ({
  id,
  sport: "soccer_epl",
  league: "EPL",
  homeTeam: `H-${id}`,
  awayTeam: `A-${id}`,
  commenceTime: 1_700_000_000,
  status: "finished",
});

const outcome = (id, homeScore, awayScore) => ({
  id: `o-${id}`,
  fixtureId: id,
  homeScore,
  awayScore,
  settledAt: 1_700_100_000,
});

// A: strong home favourite, goals expected, home wins 2–0.
const F_A = { H: 0.62, D: 0.22, A: 0.16, O25: 0.6, U25: 0.4, HG: 0.8, AG: 0.7, DC12: 0.78 };
// B: away favourite, model leans Under, away wins 0–3 (R2 loses).
const F_B = { H: 0.2, D: 0.28, A: 0.52, O25: 0.48, U25: 0.52, HG: 0.55, AG: 0.75, DC12: 0.72 };

console.log("\nRule book — frozen thresholds");

check("13 rules in the book", R.RULES.length === 13, `got ${R.RULES.length}`);
check(
  "ids are R1..R13 in order",
  R.RULES.map((r) => r.id).join(",") === Array.from({ length: 13 }, (_, i) => `R${i + 1}`).join(","),
  R.RULES.map((r) => r.id).join(","),
);
check("status split is 3 surviving / 1 experimental / 9 failed", (() => {
  const s = R.RULES.map((r) => r.status);
  return s.filter((x) => x === "surviving").length === 3 && s.filter((x) => x === "experimental").length === 1 && s.filter((x) => x === "failed").length === 9;
})());
check("4 active rules (non-failed)", R.ACTIVE_RULES.length === 4, `got ${R.ACTIVE_RULES.length}`);
check("every condition carries a human label", R.RULES.every((r) => r.conditions.every((c) => c.label.length > 0)));
check("target of 300 fixtures", R.RULES_TARGET_FIXTURES === 300);
check("freeze recorded at 94 fixtures", R.RULES_FREEZE_FIXTURES === 94);

// The anti-goalpost-move guard: these numbers may never change.
const FROZEN_THRESHOLDS = {
  R1: [["H", ">=", 0.6], ["O25", ">=", 0.55]],
  R2: [["O25-U25", "<=", -0.025], ["DC12", ">=", 0.7]],
  R3: [["H", ">=", 0.6], ["AG-O25", "<=", 0.125]],
  R4: [["H", "<=", 0.6], ["H-A", ">=", 0.425]],
  R5: [["H", ">=", 0.6], ["O25", ">=", 0.55]],
  R6: [["H-D", ">=", 0.325], ["O25-U25", ">=", 0.175]],
  R7: [["H", ">=", 0.6], ["AG", ">=", 0.65]],
  R8: [["H-D", ">=", 0.175], ["AG-O25", "<=", 0.1]],
  R9: [["H-A", "<=", 0.425], ["H-D", ">=", 0.225]],
  R10: [["H-A", "<=", 0.275], ["HG-AG", ">=", 0.1]],
  R11: [["H", "<=", 0.45], ["HG", ">=", 0.8]],
  R12: [["A-D", ">=", -0.05], ["HG-AG", ">=", 0.15]],
  R13: [["DC12", ">=", 0.775], ["H", "<=", 0.7]],
};
for (const rule of R.RULES) {
  const expected = FROZEN_THRESHOLDS[rule.id];
  const actual = rule.conditions.map((c) => [c.metric, c.op, c.threshold]);
  check(
    `${rule.id} thresholds unchanged`,
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`,
  );
}

console.log("\nRule book — evaluation");

check("R1 fires on a 60%+ home favourite with goals expected", R.ruleMatches(R.RULES_BY_ID.R1, F_A));
check(
  "R1 does not fire without the goal expectation",
  !R.ruleMatches(R.RULES_BY_ID.R1, { ...F_A, O25: 0.54 }),
);
check(
  "missing feature fails closed (never a silent hit)",
  !R.ruleMatches(R.RULES_BY_ID.R1, { ...F_A, O25: undefined }),
);
check(
  "missing derived metric fails closed",
  !R.ruleMatches(R.RULES_BY_ID.R13, { ...F_A, DC12: undefined }),
);
check("R4 needs a weak home side", !R.ruleMatches(R.RULES_BY_ID.R4, F_A));
check("R4 fires on a weak home side with a big H−A gap", R.ruleMatches(R.RULES_BY_ID.R4, { ...F_A, H: 0.44, A: 0.0 }));

check(
  "extractRuleFeatures maps the six markets",
  (() => {
    const f = R.extractRuleFeatures(predictionsFor("x", F_A));
    return f.H === 0.62 && f.D === 0.22 && f.A === 0.16 && f.O25 === 0.6 && f.U25 === 0.4 && f.HG === 0.8 && f.AG === 0.7 && f.DC12 === 0.78;
  })(),
);

check(
  "R2 fires on the Under-leaning away favourite",
  R.ruleApplications(predictionsFor("b", F_B)).some((a) => a.ruleId === "R2"),
);
check(
  "applicationsForLeg matches market + selection only",
  (() => {
    const apps = R.ruleApplications(predictionsFor("a", F_A));
    return (
      R.applicationsForLeg(apps, "team_home_goals", "yes").some((a) => a.ruleId === "R1") &&
      R.applicationsForLeg(apps, "totals", "under").length === 0
    );
  })(),
);
check(
  "activeOnly drops failed rules",
  (() => {
    const apps = R.ruleApplications(predictionsFor("a", F_A));
    return (
      R.applicationsForLeg(apps, "totals", "over", { activeOnly: true }).length === 0 &&
      R.applicationsForLeg(apps, "totals", "over").length > 0
    );
  })(),
);

console.log("\nRule book — standings over settled fixtures");

const fixtures = [fixture("a"), fixture("b"), fixture("c")];
const predictions = [
  ...predictionsFor("a", F_A),
  ...predictionsFor("b", F_B),
  ...predictionsFor("c", F_A),
];
const outcomes = [outcome("a", 2, 0), outcome("b", 0, 3)]; // "c" is unsettled

const standings = Object.fromEntries(R.evaluateRuleStandings(fixtures, predictions, outcomes).map((s) => [s.rule.id, s]));

// Fixture "a" is the only settled fixture R1 fires on. Fixture "c" has identical
// probabilities but NO outcome, so it must not appear in the denominator.
check("settledFixtureCount ignores fixtures without an outcome", R.settledFixtureCount(fixtures, outcomes) === 2);
check("R1 qualifies once (the settled lookalike) and wins", standings.R1.qualifying === 1 && standings.R1.hits === 1, JSON.stringify(standings.R1));
check("R1 rate is 100%", standings.R1.hitRate === 1);
check("R2 qualifies once and loses", standings.R2.qualifying === 1 && standings.R2.hits === 0, JSON.stringify(standings.R2));
check("R2 is flagged as broken since freeze", standings.R2.brokenSinceFreeze);
check("R3 (Home Win) wins on the 2–0", standings.R3.qualifying >= 1 && standings.R3.hits === standings.R3.qualifying);
check("failed R5 counts its loss in the denominator", standings.R5.qualifying === 1 && standings.R5.hits === 0, JSON.stringify(standings.R5));
check(
  "settling the pending lookalike moves the denominator, not the rate",
  (() => {
    const after = Object.fromEntries(
      R.evaluateRuleStandings(fixtures, predictions, [...outcomes, outcome("c", 2, 0)]).map((s) => [s.rule.id, s]),
    );
    return after.R1.qualifying === 2 && after.R1.hits === 2 && after.R1.hitRate === 1;
  })(),
);
check(
  "sinceFreeze is measured against the frozen record",
  standings.R1.sinceFreeze.qualifying === 1 - 12 && standings.R2.sinceFreeze.qualifying === 1 - 9,
);
check(
  "a rule with zero qualifying fixtures reports a null rate, not 0%",
  (() => {
    const empty = Object.fromEntries(R.evaluateRuleStandings(fixtures, predictions, []).map((s) => [s.rule.id, s]));
    return empty.R1.qualifying === 0 && empty.R1.hitRate === null;
  })(),
);

// A middling fixture no rule should touch (H 33%, even 2.5 line, no DC12 lean).
const F_Z = { H: 0.33, D: 0.3, A: 0.37, O25: 0.5, U25: 0.5, HG: 0.6, AG: 0.6, DC12: 0.4 };
check(
  "ruleApplicationsByFixture groups per fixture and omits fixtures no rule fires on",
  (() => {
    const map = R.ruleApplicationsByFixture([...predictions, ...predictionsFor("z", F_Z)]);
    return map.get("a").some((x) => x.ruleId === "R1") && (map.get("z") ?? []).length === 0;
  })(),
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
