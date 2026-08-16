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
 * Deterministic tennis demo dataset (fixed PRNG seed) — the tennis analog of
 * buildSeedDatabase. Powers the tennis views in demo mode with no API key.
 *
 * Tennis is h2h only: fixtures are player-vs-player, outcomes are encoded as
 * winner scores (home wins 1-0, away wins 0-1) so the SHARED selectionWon /
 * calibration / aggregate code works unchanged — no tennis forks needed.
 *
 * The demo "tournaments" use real ATP main-tour names (Grand Slams + Masters +
 * 500s) so the sport selector shows realistic leagues.
 */

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);

/** mulberry32 — same deterministic PRNG as the football seed. */
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

const TOURNAMENTS = [
  { id: "wim", name: "ATP Wimbledon", players: ["Alcaraz", "Sinner", "Djokovic", "Medvedev", "Zverev", "Rune", "Fritz", "Rublev", "Hurkacz", "Shelton", "De Minaur", "Tiafoe"] },
  { id: "usopen", name: "ATP US Open", players: ["Sinner", "Alcaraz", "Djokovic", "Zverev", "Medvedev", "Fritz", "Rune", "Rublev", "Shelton", "De Minaur", "Paul", "Tiafoe"] },
  { id: "iw", name: "ATP Indian Wells", players: ["Alcaraz", "Sinner", "Zverev", "Djokovic", "Medvedev", "Rune", "Fritz", "Rublev", "Hurkacz", "Shelton", "De Minaur", "Paul"] },
  { id: "madrid", name: "ATP Madrid Open", players: ["Alcaraz", "Sinner", "Zverev", "Medvedev", "Rune", "Rublev", "Fritz", "Auger-Aliassime", "Tiafoe", "Cerundolo", "Musetti", "Etcheverry"] },
  { id: "montecarlo", name: "ATP Monte-Carlo Masters", players: ["Sinner", "Alcaraz", "Djokovic", "Zverev", "Rune", "Medvedev", "Musetti", "Rublev", "Auger-Aliassime", "Cerundolo", "Etcheverry", "Bautista Agut"] },
  { id: "canada", name: "ATP Canadian Open", players: ["Sinner", "Alcaraz", "Djokovic", "Zverev", "Medvedev", "Fritz", "Rune", "Rublev", "Shelton", "Paul", "De Minaur", "Tiafoe"] },
  { id: "halle", name: "ATP Halle Open", players: ["Sinner", "Zverev", "Hurkacz", "Rune", "Fritz", "Rublev", "Shelton", "De Minaur", "Tiafoe", "Griekspoor", "Korda", "Mannarino"] },
  { id: "queens", name: "ATP Queen's Club Championships", players: ["Alcaraz", "Sinner", "Fritz", "Rune", "De Minaur", "Shelton", "Tiafoe", "Paul", "Griekspoor", "Korda", "Hurkacz", "Mannarino"] },
];

export function buildTennisSeedDatabase(): Database {
  const rand = mulberry32(20260815);

  const fixtures: Fixture[] = [];
  const predictions: Prediction[] = [];
  const odds: OddsSnapshot[] = [];
  const bets: Bet[] = [];
  const clv: ClvResult[] = [];
  const outcomes: Outcome[] = [];

  let betSeq = 0;

  for (const t of TOURNAMENTS) {
    for (let i = 0; i < 15; i++) {
      const fixtureId = `${t.id}-${String(i + 1).padStart(2, "0")}`;
      const home = t.players[(i * 5) % t.players.length]!;
      let away = t.players[(i * 5 + 2) % t.players.length]!;
      if (away === home) away = t.players[(i * 5 + 7) % t.players.length]!;

      const finished = i < 11;
      const daysAgo = finished ? 70 - i * 5 : -(i - 11) * 2;
      const commenceTime = NOW - daysAgo * DAY;

      fixtures.push({
        id: fixtureId,
        sport: "tennis",
        league: t.name,
        homeTeam: home,
        awayTeam: away,
        commenceTime,
        status: finished ? "finished" : "scheduled",
      });

      // Simulated result. Better player (lower index) wins more often, with
      // an upset chance so calibration is honest, not perfect.
      const homeIdx = t.players.indexOf(home);
      const awayIdx = t.players.indexOf(away);
      const upset = rand() < 0.18;
      const homeWins = (homeIdx < awayIdx) !== upset;

      if (finished) {
        // Encode winner as a score so shared selectionWon("h2h") works.
        outcomes.push({
          id: `tout-${fixtureId}`,
          fixtureId,
          homeScore: homeWins ? 1 : 0,
          awayScore: homeWins ? 0 : 1,
          settledAt: commenceTime + 2 * 3600,
        });
      }

      // Predictions: h2h only, model probability centered on the true outcome.
      for (const sel of ["home", "away"] as const) {
        const trueWon = sel === "home" ? homeWins : !homeWins;
        const base = trueWon ? 0.52 + rand() * 0.22 : 0.22 + rand() * 0.16;
        const p = Math.min(0.96, Math.max(0.04, base));
        predictions.push({
          id: `tpred-${fixtureId}-${sel}`,
          fixtureId,
          market: "h2h",
          selection: sel,
          probability: Math.round(p * 1000) / 1000,
          confidenceLow: Math.max(0.01, Math.round((p - 0.06 - rand() * 0.05) * 1000) / 1000),
          confidenceHigh: Math.min(0.99, Math.round((p + 0.06 + rand() * 0.05) * 1000) / 1000),
          modelVersion: "tennis-seed-v1",
          createdAt: commenceTime - 2 * DAY,
        });
      }

      // Odds: opening + closing for home/away (no draw). Closing drifts
      // toward the model probability so disciplined bets earn positive CLV.
      const favProb = homeWins ? 0.55 + rand() * 0.15 : 0.35 + rand() * 0.1;
      const homeP = Math.min(0.88, Math.max(0.12, favProb));
      const bookmakers = ["Bet365", "Pinnacle", "1xBet", "Betway"];
      for (const sel of ["home", "away"] as const) {
        const p = sel === "home" ? homeP : 1 - homeP;
        const book = bookmakers[(fixtureId.length + sel.length) % bookmakers.length]!;
        const open = 1 / p + (rand() - 0.5) * 0.12;
        const close = 1 / p + (rand() - 0.5) * 0.05;
        odds.push(
          { id: `todd-${fixtureId}-${sel}-open`, fixtureId, market: "h2h", selection: sel, odds: Math.round(open * 100) / 100, bookmaker: book, capturedAt: commenceTime - DAY, isClosing: false },
          { id: `todd-${fixtureId}-${sel}-close`, fixtureId, market: "h2h", selection: sel, odds: Math.round(close * 100) / 100, bookmaker: book, capturedAt: commenceTime + 3600, isClosing: true },
        );
      }

      // ~60% of finished fixtures carry a logged bet (h2h singles only).
      if (finished && rand() < 0.6) {
        const sel: Selection = rand() < 0.62 ? "home" : "away";
        const pred = predictions.find((p) => p.fixtureId === fixtureId && p.selection === sel)!;
        const closeSnap = odds.find((o) => o.fixtureId === fixtureId && o.selection === sel && o.isClosing)!;
        const openSnap = odds.find((o) => o.fixtureId === fixtureId && o.selection === sel && !o.isClosing)!;

        const won = sel === "home" ? homeWins : !homeWins;
        const stake = Math.round((25 + rand() * 75) * 100) / 100;
        const oddsDecimal = closeSnap.odds;

        bets.push({
          id: `tbet-${String(betSeq++).padStart(4, "0")}`,
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

        const drift = rand();
        const clvVal = drift < 0.7 ? 0.01 + rand() * 0.06 : -(0.01 + rand() * 0.05);
        clv.push({
          id: `tclv-${bets[bets.length - 1]!.id}`,
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
      leagues: TOURNAMENTS.map((t) => t.name),
      markets: ["h2h"],
      multiplesEnabled: false,
    },
  };
}
