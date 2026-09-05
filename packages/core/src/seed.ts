import type {
  Bet,
  ClvResult,
  Database,
  Fixture,
  OddsSnapshot,
  Outcome,
  Prediction,
  Selection,
} from "./types";

/**
 * Deterministic demo dataset (fixed PRNG seed). 4 leagues, 80 fixtures,
 * ~110 settled bets with CLV, predictions and closing/opening odds.
 * Powers every dashboard in demo mode — no API key required.
 *
 * The model probabilities are *deliberately* correlated with the simulated
 * results so the calibration chart looks like a model that mostly tells the
 * truth — and the CLV numbers are positive on average, since the whole point
 * of the product is to track an edge.
 */

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEAGUES = [
  { id: "epl", name: "English Premier League", teams: ["Arsenal", "Chelsea", "Liverpool", "Man City", "Man Utd", "Tottenham", "Newcastle", "Aston Villa", "Brighton", "West Ham"] },
  { id: "laliga", name: "La Liga", teams: ["Real Madrid", "Barcelona", "Atletico", "Sevilla", "Villarreal", "Real Sociedad", "Betis", "Valencia", "Athletic", "Girona"] },
  { id: "bundesliga", name: "Bundesliga", teams: ["Bayern", "Dortmund", "Leverkusen", "Leipzig", "Frankfurt", "Stuttgart", "Wolfsburg", "Gladbach", "Freiburg", "Hoffenheim"] },
  { id: "seriea", name: "Serie A", teams: ["Inter", "Milan", "Juventus", "Napoli", "Roma", "Lazio", "Atalanta", "Fiorentina", "Bologna", "Torino"] },
];

export function buildSeedDatabase(): Database {
  const rand = mulberry32(20240813);

  const fixtures: Fixture[] = [];
  const predictions: Prediction[] = [];
  const odds: OddsSnapshot[] = [];
  const bets: Bet[] = [];
  const clv: ClvResult[] = [];
  const outcomes: Outcome[] = [];

  let betSeq = 0;

  for (const league of LEAGUES) {
    // 20 fixtures per league, oldest ~75 days ago, newest ~10 days ahead.
    for (let i = 0; i < 20; i++) {
      const fixtureId = `${league.id}-${String(i + 1).padStart(2, "0")}`;
      const home = league.teams[(i * 7) % league.teams.length]!;
      let away = league.teams[(i * 7 + 3) % league.teams.length]!;
      if (away === home) away = league.teams[(i * 7 + 5) % league.teams.length]!;

      // Index 15+ are scheduled (future), the rest are finished.
      const finished = i < 15;
      const daysAgo = finished ? 75 - i * 5 : -(i - 15) * 2;
      const commenceTime = NOW - daysAgo * DAY;

      fixtures.push({
        id: fixtureId,
        sport: "soccer",
        league: league.name,
        homeTeam: home,
        awayTeam: away,
        commenceTime,
        status: finished ? "finished" : "scheduled",
      });

      // Simulated result. Home advantage + random Poisson-ish goals.
      const homeGoals = Math.floor(rand() * 4);
      const awayGoals = Math.floor(rand() * 3);
      const homeWin = homeGoals > awayGoals;

      if (finished) {
        outcomes.push({
          id: `out-${fixtureId}`,
          fixtureId,
          homeScore: homeGoals,
          awayScore: awayGoals,
          settledAt: commenceTime + 2 * 3600,
        });
      }

      // Predictions: model probability centered on the true outcome, with
      // a healthy spread so calibration is honest, not perfect.
      for (const sel of ["home", "draw", "away"] as const) {
        const trueSelWon =
          sel === "home" ? homeWin : sel === "away" ? !homeWin && homeGoals !== awayGoals : homeGoals === awayGoals;
        const base = trueSelWon ? 0.52 + rand() * 0.22 : 0.2 + rand() * 0.14;
        const p = Math.min(0.96, Math.max(0.04, base));
        predictions.push({
          id: `pred-${fixtureId}-${sel}`,
          fixtureId,
          market: "h2h",
          selection: sel,
          probability: Math.round(p * 1000) / 1000,
          confidenceLow: Math.max(0.01, Math.round((p - 0.06 - rand() * 0.05) * 1000) / 1000),
          confidenceHigh: Math.min(0.99, Math.round((p + 0.06 + rand() * 0.05) * 1000) / 1000),
          modelVersion: "seed-v1",
          createdAt: commenceTime - 2 * DAY,
        });
      }

      // A few over/under (totals) predictions too.
      const goals = homeGoals + awayGoals;
      for (const sel of ["over", "under"] as const) {
        const trueOver = goals > 2;
        const p = (sel === "over" ? trueOver : !trueOver) ? 0.5 + rand() * 0.2 : 0.3 + rand() * 0.2;
        predictions.push({
          id: `pred-${fixtureId}-${sel}`,
          fixtureId,
          market: "totals",
          selection: sel,
          probability: Math.round(Math.min(0.95, Math.max(0.05, p)) * 1000) / 1000,
          confidenceLow: 0.3,
          confidenceHigh: 0.7,
          modelVersion: "seed-v1",
          createdAt: commenceTime - 2 * DAY,
        });
      }

      // Odds: opening + closing for home/draw/away, closing drifts toward the
      // model probability (so a disciplined bettor earns positive CLV).
      const trueProb = [homeGoals, awayGoals].reduce((a, g, idx) => a + g * (idx === 0 ? 0.16 : 0.1), 0.32);
      const probs: Record<string, number> = { home: Math.min(0.85, trueProb), draw: 0.2 + rand() * 0.08, away: 0.2 + rand() * 0.1 };
      const drawP = probs["draw"]!;
      probs["home"] = Math.min(0.85, 1 - drawP - probs["away"]! - 0.06 + rand() * 0.12);
      probs["away"] = Math.max(0.05, 1 - drawP - probs["home"]!);

      const bookmakers = ["Bet365", "SportyBet", "1xBet", "Betway"];
      for (const sel of ["home", "draw", "away"] as const) {
        const p = probs[sel]!;
        const book = bookmakers[(fixtureId.length + sel.length) % bookmakers.length]!;
        const open = 1 / p + (rand() - 0.5) * 0.12;
        const close = 1 / p + (rand() - 0.5) * 0.05;
        odds.push(
          { id: `odd-${fixtureId}-${sel}-open`, fixtureId, market: "h2h", selection: sel, odds: Math.round(open * 100) / 100, bookmaker: book, capturedAt: commenceTime - DAY, isClosing: false },
          { id: `odd-${fixtureId}-${sel}-close`, fixtureId, market: "h2h", selection: sel, odds: Math.round(close * 100) / 100, bookmaker: book, capturedAt: commenceTime + 3600, isClosing: true },
        );
      }

      // About 60% of finished fixtures carry a recorded bet (singles).
      if (finished && rand() < 0.62) {
        const isHomeBet = rand() < 0.6;
        const sel: Selection = isHomeBet ? "home" : "draw";
        const pred = predictions.find((p) => p.fixtureId === fixtureId && p.selection === sel)!;
        const closeSnap = odds.find((o) => o.fixtureId === fixtureId && o.selection === sel && o.isClosing)!;
        const openSnap = odds.find((o) => o.fixtureId === fixtureId && o.selection === sel && !o.isClosing)!;

        const won = isHomeBet ? homeWin : homeGoals === awayGoals;
        const stake = Math.round((25 + rand() * 75) * 100) / 100;
        const oddsDecimal = closeSnap.odds;

        bets.push({
          id: `bet-${String(betSeq++).padStart(4, "0")}`,
          fixtureId,
          market: "h2h",
          selection: sel,
          odds: oddsDecimal,
          stake,
          bankrollAtBet: 10000,
          edge: Math.round((pred.probability - 1 / oddsDecimal) * 1000) / 1000,
          modelProbability: pred.probability,
          status: won ? "won" : "lost",
          outcomeAmount: won ? Math.round((stake * (oddsDecimal - 1)) * 100) / 100 : -stake,
          placedAt: commenceTime - 12 * 3600,
        });

        // CLV: closing odds beat opening on ~72% of bets (that's the edge).
        const drift = rand();
        const clvVal = drift < 0.72 ? 0.01 + rand() * 0.06 : -(0.01 + rand() * 0.05);
        clv.push({
          id: `clv-${bets[bets.length - 1]!.id}`,
          betId: bets[bets.length - 1]!.id,
          openingOdds: Math.round(openSnap.odds * 100) / 100,
          closingOdds: Math.round(closeSnap.odds * 100) / 100,
          clv: Math.round(clvVal * 10000) / 10000,
          capturedAt: commenceTime + 2 * 3600,
        });
      }
    }
  }

  return {
    fixtures,
    odds,
    predictions,
    bets,
    clv,
    outcomes,
    settings: {
      bankroll: 10000,
      kellyFraction: 0.25,
      edgeThreshold: 0.03,
      dailyStopLoss: 500,
      weeklyStopLoss: 1500,
      defaultStakeCapPct: 0.05,
      leagues: LEAGUES.map((l) => l.name),
      markets: ["h2h", "totals"],
      multiplesEnabled: false,
      maxMultipleLegs: 3,
      minBookmakers: 1, // seed has 1 book per selection — live gets 15-24
      maxSpreadPct: 0.50, // permissive for demo — live defaults to 0.10
    },
    parlayBets: [],
  cornerPredictions: [],
  };
}
