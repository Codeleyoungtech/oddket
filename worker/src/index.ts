import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  buildCalibration,
  buildClvSeries,
  buildDashboard,
  buildMultiple,
  buildParlay,
  checkLegIndependence,
  enrichBets,
  flagSlips,
  runBacktest,
  type Bet,
  type ClvResult,
  type Database,
  type Fixture,
  type Parlay,
  type Prediction,
} from "@oddket/core";
import type { Env } from "./db";
import {
  deletePushSubscription,
  getSettings,
  insertBet,
  insertClv,
  insertParlay,
  listRecentSettlements,
  loadDatabase,
  loadParlays,
  putSettings,
  settleParlayBets,
  settlePendingBets,
  upsertOutcomes,
  upsertPredictions,
  upsertPushSubscription,
} from "./db";
import { notifySettlements, sendTestPush } from "./push";
import { ingestOdds } from "./odds/ingest";
import { pullClosingOdds } from "./odds/closing";
import { ingestTennisOdds, pullTennisClosingOdds } from "./odds/tennis-ingest";
import { settleFinishedMatches } from "./odds/settle";
import { seedDatabase } from "./seed";
import {
  insertTennisBet,
  insertTennisClv,
  loadTennisDatabase,
  settleTennisBets,
  upsertTennisPredictions,
} from "./db";

const app = new Hono<{ Bindings: Env }>();

// Local dev origins + the deployed dashboard origin (set via DASHBOARD_ORIGIN
// secret when you deploy to Vercel/Pages). Everything else gets no CORS.
function corsOrigins(env: Env): string[] {
  const list = ["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001"];
  if (env.DASHBOARD_ORIGIN) list.push(env.DASHBOARD_ORIGIN);
  return list;
}

app.use("/api/*", async (c, next) => {
  const corsMiddleware = cors({
    origin: corsOrigins(c.env),
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "x-predict-key"],
  });
  return corsMiddleware(c, next);
});

/* ---------------- health ---------------- */

app.get("/api/health", (c) =>
  c.json({ ok: true, mode: c.env.ODDS_API_KEY ? "live" : "demo", time: Date.now() }),
);

/* ---------------- dashboard ---------------- */

app.get("/api/dashboard", async (c) => {
  const db = await loadDatabase(c.env.DB);
  return c.json(buildDashboard(db));
});

/* ---------------- raw database (web app computes views via core) ---------------- */

app.get("/api/db", async (c) => c.json(await loadDatabase(c.env.DB)));

/* ---------------- fixtures / predictions ---------------- */

app.get("/api/fixtures", async (c) => {
  const db = await loadDatabase(c.env.DB);
  const only = c.req.query("status");
  const fixtures = db.fixtures
    .filter((f) => (only ? f.status === only : true))
    .sort((a, b) => a.commenceTime - b.commenceTime);
  return c.json(fixtures);
});

app.get("/api/predictions", async (c) => {
  const db = await loadDatabase(c.env.DB);
  return c.json(db.predictions);
});

/**
 * Export UPCOMING real fixtures + their best current odds in the exact shape
 * the Python model consumes (model/data/fixtures.json). The GitHub Actions
 * predict job calls this instead of a local SQLite file, so predictions run
 * in the cloud: fetch here -> predict.py -> POST /api/predictions/ingest.
 */
app.get("/api/fixtures/export", async (c) => {
  const db = await loadDatabase(c.env.DB);
  const now = Math.floor(Date.now() / 1000);
  const scheduled = db.fixtures
    .filter((f) => f.status === "scheduled" && f.sport !== "soccer" && f.commenceTime > now)
    .sort((a, b) => a.commenceTime - b.commenceTime);
  const matches = scheduled.map((f) => {
    const best = (market: string, selection: string): number | null => {
      let b: number | null = null;
      for (const o of db.odds) {
        if (o.fixtureId !== f.id || o.market !== market || o.selection !== selection) continue;
        if (b === null || o.odds > b) b = o.odds;
      }
      return b;
    };
    return {
      id: f.id,
      league: f.league,
      home: f.homeTeam,
      away: f.awayTeam,
      commenceTime: f.commenceTime,
      odds: {
        home: best("h2h", "home"),
        draw: best("h2h", "draw"),
        away: best("h2h", "away"),
        over: best("totals", "over"),
        under: best("totals", "under"),
      },
    };
  });
  return c.json({ meta: { source: "live-odds", n_matches: matches.length }, matches });
});

/** Ingest model output (from the Python sidecar): [{fixtureId, market, selection, probability, confidenceLow, confidenceHigh, modelVersion}]
 *  When PREDICT_SECRET is set (production), the caller must send it as the
 *  x-predict-key header so strangers can't push fake predictions. */
app.post("/api/predictions/ingest", async (c) => {
  const secret = c.env.PREDICT_SECRET;
  if (secret) {
    const provided = c.req.header("x-predict-key") ?? "";
    if (provided !== secret) {
      return c.json({ ok: false, error: "Unauthorized: missing or wrong x-predict-key." }, 401);
    }
  }
  const body = (await c.req.json()) as Array<Partial<Prediction> & { fixtureId: string; market: Prediction["market"]; selection: Prediction["selection"]; probability: number }>;
  if (!Array.isArray(body) || body.length === 0) {
    return c.json({ ok: false, error: "Expected a non-empty array of predictions." }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  // Stable ids (fixture:market:selection) so re-ingesting REPLACES the previous
  // model's rows instead of accumulating stale duplicates (which made the slip
  // builder show the same bet twice from different model versions).
  const rows: Prediction[] = body.map((p, i) => ({
    id: p.id ?? `${p.fixtureId}:${p.market}:${p.selection}`,
    fixtureId: p.fixtureId,
    market: p.market,
    selection: p.selection,
    probability: p.probability,
    confidenceLow: p.confidenceLow ?? 0,
    confidenceHigh: p.confidenceHigh ?? 1,
    modelVersion: p.modelVersion ?? "sidecar",
    createdAt: p.createdAt ?? now,
  }));
  // Delete any prior predictions for THESE fixtures AND THIS MARKET (any model
  // version, any id format) so only the latest ingest survives. Scoped to the
  // market so pushing h2h doesn't wipe totals and vice versa.
  const fixtureIds = [...new Set(rows.map((r) => r.fixtureId))];
  const market = rows[0]?.market;
  for (const fid of fixtureIds) {
    await c.env.DB.prepare("DELETE FROM predictions WHERE fixture_id = ?1 AND market = ?2").bind(fid, market).run();
  }
  await upsertPredictions(c.env.DB, rows);
  return c.json({ ok: true, ingested: rows.length });
});

/* ---------------- slip builder ---------------- */

/** Only flag slips for REAL fixtures (anything pulled from The Odds API —
 *  seed demo fixtures use sport 'soccer') so demo-seed fabricated predictions
 *  never reach the slip builder. Falls back to all scheduled fixtures only
 *  when no live fixtures exist (demo mode). */
function slipFixtures(db: Database): Fixture[] {
  const scheduled = db.fixtures.filter((f) => f.status === "scheduled");
  const live = scheduled.filter((f) => f.sport !== "soccer");
  return live.length > 0 ? live : scheduled;
}

app.get("/api/slips", async (c) => {
  const db = await loadDatabase(c.env.DB);
  const legs = flagSlips(slipFixtures(db), db.predictions, db.odds, db.settings);
  return c.json(legs);
});

/** Build a multiple from selected leg ids ("fixtureId:market:selection"). */
app.post("/api/slips/multiple", async (c) => {
  const db = await loadDatabase(c.env.DB);
  // Gated: the multiple builder stays OFF until the validation checklist is
  // cleared and the flag is flipped in Settings. OFF → 403, not a silent no-op.
  if (!db.settings.multiplesEnabled) {
    return c.json({ ok: false, error: "Multiples are disabled in Settings." }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const legIds: string[] = body.legIds ?? [];
  const legs = flagSlips(slipFixtures(db), db.predictions, db.odds, db.settings);
  const byKey = new Map(legs.map((l) => [`${l.fixture.id}:${l.market}:${l.selection}`, l]));
  const selected = legIds.map((k) => byKey.get(k)).filter((l): l is NonNullable<typeof l> => Boolean(l));
  if (selected.length === 0) {
    return c.json({ ok: false, error: "No valid legs selected." }, 400);
  }
  if (selected.length > 3) {
    return c.json({ ok: false, error: "Max 3 legs per multiple — calibration error compounds badly beyond that." }, 400);
  }
  const multiple = buildMultiple(selected, db.settings);
  return c.json({ ok: true, legs: selected, multiple });
});

/* ---------------- bet logging ---------------- */

app.get("/api/bets", async (c) => {
  const db = await loadDatabase(c.env.DB);
  const enriched = enrichBets(db.bets, db.fixtures, db.clv.map((r) => ({ betId: r.betId, clv: r.clv, closingOdds: r.closingOdds })));
  return c.json(enriched.sort((a, b) => b.placedAt - a.placedAt));
});

/** Undo a mistaken bet log — removes the bet and its CLV records. */
app.delete("/api/bets/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM clv_results WHERE bet_id = ?1").bind(id).run();
  const res = await c.env.DB.prepare("DELETE FROM bets WHERE id = ?1").bind(id).run();
  if (!res.meta.changes) return c.json({ ok: false, error: "Bet not found." }, 404);
  return c.json({ ok: true, deleted: id });
});

app.post("/api/bets", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { fixtureId, market, selection, odds, stake, edge, modelProbability, placedAt } = body as Partial<Bet>;
  if (!fixtureId || !market || !selection || !odds || !stake) {
    return c.json({ ok: false, error: "fixtureId, market, selection, odds and stake are required." }, 400);
  }

  const db = await loadDatabase(c.env.DB);
  const fixture = db.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return c.json({ ok: false, error: "Unknown fixture." }, 404);

  const settings = await getSettings(c.env.DB);
  if (stake > settings.bankroll * settings.defaultStakeCapPct) {
    return c.json({ ok: false, error: `Stake exceeds the ${(settings.defaultStakeCapPct * 100).toFixed(0)}% single-bet cap.` }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const bet: Bet = {
    id: `bet-${now}-${Math.floor(Math.random() * 1e6)}`,
    fixtureId,
    market,
    selection,
    odds,
    stake,
    bankrollAtBet: settings.bankroll,
    edge: edge ?? 0,
    modelProbability: modelProbability ?? 0,
    status: "pending",
    placedAt: placedAt ?? now,
  };
  await insertBet(c.env.DB, bet);
  return c.json({ ok: true, bet }, 201);
});

app.get("/api/clv", async (c) => {
  const db = await loadDatabase(c.env.DB);
  return c.json({
    records: db.clv.sort((a, b) => b.capturedAt - a.capturedAt),
    series: buildClvSeries(db.bets, db.clv),
  });
});

/* ---------------- outcomes / calibration ---------------- */

app.post("/api/outcomes", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const list = Array.isArray(body) ? body : [body];
  const rows = list
    .filter((o) => o?.fixtureId && typeof o.homeScore === "number" && typeof o.awayScore === "number")
    .map((o, i) => ({
      id: o.id ?? `out-${o.fixtureId}`,
      fixtureId: o.fixtureId,
      homeScore: o.homeScore,
      awayScore: o.awayScore,
      settledAt: o.settledAt ?? Math.floor(Date.now() / 1000),
    }));
  if (rows.length === 0) return c.json({ ok: false, error: "Expected [{fixtureId, homeScore, awayScore}]." }, 400);

  await upsertOutcomes(c.env.DB, rows);
  const settled = await settlePendingBets(c.env.DB);
  const parlaysSettled = await settleParlayBets(c.env.DB);
  if (settled + parlaysSettled > 0) await notifySettlements(c.env);
  return c.json({ ok: true, outcomesStored: rows.length, betsSettled: settled, parlaysSettled });
});

app.get("/api/calibration", async (c) => {
  const db = await loadDatabase(c.env.DB);
  return c.json(buildCalibration(db.predictions, db.outcomes, db.fixtures));
});

/* ---------------- backtest ---------------- */

app.get("/api/backtest", async (c) => {
  const db = await loadDatabase(c.env.DB);
  return c.json(runBacktest(db));
});

/* ---------------- settings ---------------- */

app.get("/api/settings", async (c) => c.json(await getSettings(c.env.DB)));

app.put("/api/settings", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const current = await getSettings(c.env.DB);
  const next: typeof current = {
    bankroll: typeof body.bankroll === "number" ? body.bankroll : current.bankroll,
    kellyFraction: typeof body.kellyFraction === "number" ? body.kellyFraction : current.kellyFraction,
    edgeThreshold: typeof body.edgeThreshold === "number" ? body.edgeThreshold : current.edgeThreshold,
    dailyStopLoss: typeof body.dailyStopLoss === "number" ? body.dailyStopLoss : current.dailyStopLoss,
    weeklyStopLoss: typeof body.weeklyStopLoss === "number" ? body.weeklyStopLoss : current.weeklyStopLoss,
    defaultStakeCapPct: typeof body.defaultStakeCapPct === "number" ? body.defaultStakeCapPct : current.defaultStakeCapPct,
    leagues: Array.isArray(body.leagues) ? body.leagues : current.leagues,
    markets: Array.isArray(body.markets) ? body.markets : current.markets,
    multiplesEnabled: typeof body.multiplesEnabled === "boolean" ? body.multiplesEnabled : current.multiplesEnabled,
    maxMultipleLegs: typeof body.maxMultipleLegs === "number" ? Math.min(6, Math.max(2, body.maxMultipleLegs)) : current.maxMultipleLegs,
  };
  await putSettings(c.env.DB, next);
  return c.json({ ok: true, settings: next });
});

/* ---------------- manual cron triggers (also fire the scheduled jobs) ---------------- */

/** Require the PREDICT_SECRET header on endpoints that cost Odds API credits. */
function requireSecret(c: { env: Env; req: { header: (n: string) => string | undefined } }): boolean {
  const secret = c.env.PREDICT_SECRET;
  if (!secret) return true; // local dev — no secret configured
  return c.req.header("x-predict-key") === secret;
}

/** Trigger the live odds pull — GitHub Actions fires this (09:00/18:00). */
app.post("/api/ingest", async (c) => {
  if (!requireSecret(c)) return c.json({ ok: false, error: "Unauthorized: missing or wrong x-predict-key." }, 401);
  try {
    return c.json(await ingestOdds(c.env));
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 502);
  }
});

/** Trigger the closing-odds pull — GitHub Actions fires this (18:30, CLV). */
app.post("/api/closing", async (c) => {
  if (!requireSecret(c)) return c.json({ ok: false, error: "Unauthorized: missing or wrong x-predict-key." }, 401);
  try {
    return c.json(await pullClosingOdds(c.env));
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 502);
  }
});

/* ---------------- TENNIS (isolated from football) ---------------- */

/** Tennis fixtures are always "real" (sport = 'tennis') — no demo-seed blurring. */
function tennisSlipFixtures(db: Database): Fixture[] {
  return db.fixtures.filter((f) => f.status === "scheduled");
}

app.get("/api/tennis/dashboard", async (c) => {
  const db = await loadTennisDatabase(c.env.DB);
  return c.json(buildDashboard(db));
});

app.get("/api/tennis/db", async (c) => c.json(await loadTennisDatabase(c.env.DB)));

app.get("/api/tennis/slips", async (c) => {
  const db = await loadTennisDatabase(c.env.DB);
  return c.json(flagSlips(tennisSlipFixtures(db), db.predictions, db.odds, db.settings));
});

/**
 * Export UPCOMING tennis fixtures + best current h2h odds in the shape the
 * tennis model consumes (model/data/tennis_fixtures.json). GitHub Actions
 * predict job calls this, runs predict_tennis.py, then pushes predictions
 * back via /api/tennis/predictions/ingest.
 */
app.get("/api/tennis/fixtures/export", async (c) => {
  const db = await loadTennisDatabase(c.env.DB);
  const now = Math.floor(Date.now() / 1000);
  const scheduled = db.fixtures
    .filter((f) => f.status === "scheduled" && f.commenceTime > now)
    .sort((a, b) => a.commenceTime - b.commenceTime);
  const matches = scheduled.map((f) => {
    const best = (selection: string): number | null => {
      let b: number | null = null;
      for (const o of db.odds) {
        if (o.fixtureId !== f.id || o.market !== "h2h" || o.selection !== selection) continue;
        if (b === null || o.odds > b) b = o.odds;
      }
      return b;
    };
    return {
      id: f.id,
      league: f.league,
      home: f.homeTeam,
      away: f.awayTeam,
      commenceTime: f.commenceTime,
      odds: { home: best("home"), away: best("away") },
    };
  });
  return c.json({ meta: { source: "live-odds", n_matches: matches.length }, matches });
});

app.get("/api/tennis/bets", async (c) => {
  const db = await loadTennisDatabase(c.env.DB);
  const enriched = enrichBets(db.bets, db.fixtures, db.clv.map((r) => ({ betId: r.betId, clv: r.clv, closingOdds: r.closingOdds })));
  return c.json(enriched.sort((a, b) => b.placedAt - a.placedAt));
});

app.delete("/api/tennis/bets/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare("DELETE FROM tennis_clv_results WHERE bet_id = ?1").bind(id).run();
  const res = await c.env.DB.prepare("DELETE FROM tennis_bets WHERE id = ?1").bind(id).run();
  if (!res.meta.changes) return c.json({ ok: false, error: "Tennis bet not found." }, 404);
  return c.json({ ok: true, deleted: id });
});

app.post("/api/tennis/bets", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { fixtureId, market, selection, odds, stake, edge, modelProbability, placedAt } = body as Partial<Bet>;
  if (!fixtureId || !selection || !odds || !stake) {
    return c.json({ ok: false, error: "fixtureId, selection, odds and stake are required." }, 400);
  }

  const db = await loadTennisDatabase(c.env.DB);
  const fixture = db.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return c.json({ ok: false, error: "Unknown tennis fixture." }, 404);

  const settings = await getSettings(c.env.DB);
  if (stake > settings.bankroll * settings.defaultStakeCapPct) {
    return c.json({ ok: false, error: `Stake exceeds the ${(settings.defaultStakeCapPct * 100).toFixed(0)}% single-bet cap.` }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const bet: Bet = {
    id: `tbet-${now}-${Math.floor(Math.random() * 1e6)}`,
    fixtureId,
    market: market ?? "h2h",
    selection,
    odds,
    stake,
    bankrollAtBet: settings.bankroll,
    edge: edge ?? 0,
    modelProbability: modelProbability ?? 0,
    status: "pending",
    placedAt: placedAt ?? now,
  };
  await insertTennisBet(c.env.DB, bet);
  return c.json({ ok: true, bet }, 201);
});

app.get("/api/tennis/clv", async (c) => {
  const db = await loadTennisDatabase(c.env.DB);
  return c.json({
    records: db.clv.sort((a, b) => b.capturedAt - a.capturedAt),
    series: buildClvSeries(db.bets, db.clv),
  });
});

app.post("/api/tennis/clv", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { betId, openingOdds, closingOdds, capturedAt } = body as Partial<ClvResult>;
  if (!betId || !openingOdds || !closingOdds) {
    return c.json({ ok: false, error: "betId, openingOdds, closingOdds required." }, 400);
  }
  const record: ClvResult = {
    id: `tclv-${betId}-${capturedAt ?? Date.now()}`,
    betId,
    openingOdds,
    closingOdds,
    clv: Math.round(((openingOdds - closingOdds) / closingOdds) * 10000) / 10000,
    capturedAt: capturedAt ?? Math.floor(Date.now() / 1000),
  };
  await insertTennisClv(c.env.DB, record);
  return c.json({ ok: true, clv: record }, 201);
});

/** Record a tennis match result: [{fixtureId, winner: 'home'|'away'}] → settles bets. */
app.post("/api/tennis/outcomes", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const list = Array.isArray(body) ? body : [body];
  const rows = list.filter((o) => o?.fixtureId && (o.winner === "home" || o.winner === "away"));
  if (rows.length === 0) return c.json({ ok: false, error: "Expected [{fixtureId, winner: 'home'|'away'}]." }, 400);

  for (const o of rows) {
    await c.env.DB.prepare(
      "UPDATE tennis_matches SET status = 'finished', winner = ?1 WHERE id = ?2",
    ).bind(o.winner, o.fixtureId).run();
  }
  const settled = await settleTennisBets(c.env.DB);
  const parlaysSettled = await settleParlayBets(c.env.DB);
  if (settled + parlaysSettled > 0) await notifySettlements(c.env);
  return c.json({ ok: true, outcomesStored: rows.length, betsSettled: settled, parlaysSettled });
});

app.get("/api/tennis/calibration", async (c) => {
  const db = await loadTennisDatabase(c.env.DB);
  return c.json(buildCalibration(db.predictions, db.outcomes, db.fixtures));
});

app.get("/api/tennis/backtest", async (c) => {
  const db = await loadTennisDatabase(c.env.DB);
  return c.json(runBacktest(db));
});

app.post("/api/tennis/predictions/ingest", async (c) => {
  const secret = c.env.PREDICT_SECRET;
  if (secret) {
    const provided = c.req.header("x-predict-key") ?? "";
    if (provided !== secret) {
      return c.json({ ok: false, error: "Unauthorized: missing or wrong x-predict-key." }, 401);
    }
  }
  const body = (await c.req.json()) as Array<Partial<Prediction> & { fixtureId: string; selection: Prediction["selection"]; probability: number }>;
  if (!Array.isArray(body) || body.length === 0) {
    return c.json({ ok: false, error: "Expected a non-empty array of predictions." }, 400);
  }
  const now = Math.floor(Date.now() / 1000);
  const rows: Prediction[] = body.map((p) => ({
    id: p.id ?? `${p.fixtureId}:${p.market ?? "h2h"}:${p.selection}`,
    fixtureId: p.fixtureId,
    market: p.market ?? "h2h",
    selection: p.selection,
    probability: p.probability,
    confidenceLow: p.confidenceLow ?? 0,
    confidenceHigh: p.confidenceHigh ?? 1,
    modelVersion: p.modelVersion ?? "tennis-sidecar",
    createdAt: p.createdAt ?? now,
  }));
  const fixtureIds = [...new Set(rows.map((r) => r.fixtureId))];
  const market = rows[0]?.market ?? "h2h";
  for (const fid of fixtureIds) {
    await c.env.DB.prepare("DELETE FROM tennis_predictions WHERE fixture_id = ?1 AND market = ?2").bind(fid, market).run();
  }
  await upsertTennisPredictions(c.env.DB, rows);
  return c.json({ ok: true, ingested: rows.length });
});

/** Tennis odds pull — GitHub Actions fires this (or cron). Demo no-op without key. */
app.post("/api/tennis/ingest", async (c) => {
  if (!requireSecret(c)) return c.json({ ok: false, error: "Unauthorized: missing or wrong x-predict-key." }, 401);
  try {
    return c.json(await ingestTennisOdds(c.env));
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 502);
  }
});

/** Tennis closing-odds pull for CLV. Demo no-op without key. */
app.post("/api/tennis/closing", async (c) => {
  if (!requireSecret(c)) return c.json({ ok: false, error: "Unauthorized: missing or wrong x-predict-key." }, 401);
  try {
    return c.json(await pullTennisClosingOdds(c.env));
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 502);
  }
});

/** Auto-settle: pull live scores for football + tennis, settle pending bets. */
app.post("/api/settle", async (c) => {
  if (!requireSecret(c)) return c.json({ ok: false, error: "Unauthorized: missing or wrong x-predict-key." }, 401);
  try {
    const result = await settleFinishedMatches(c.env);
    // True parlays settle all-or-nothing from the same outcomes.
    const parlaysSettled = await settleParlayBets(c.env.DB);
    if (result.footballSettled + result.tennisSettled + parlaysSettled > 0) await notifySettlements(c.env);
    return c.json({ ...result, parlaysSettled });
  } catch (err) {
    return c.json({ ok: false, error: String(err) }, 502);
  }
});

/** List logged parlays (true parlay units, settled all-or-nothing). */
app.get("/api/parlays", async (c) => {
  const db = await loadParlays(c.env.DB);
  return c.json(db.sort((a, b) => b.placedAt - a.placedAt));
});

/**
 * Log a parlay as ONE unit: [{legIds, stake}]. All-or-nothing settlement.
 * Validates the gate, the max-legs cap, and correlation independence.
 */
app.post("/api/parlays", async (c) => {
  const db = await loadDatabase(c.env.DB);
  if (!db.settings.multiplesEnabled) {
    return c.json({ ok: false, error: "Multiples are disabled in Settings." }, 403);
  }
  const body = await c.req.json().catch(() => ({}));
  const legIds: string[] = body.legIds ?? [];
  const stake = Number(body.stake ?? 0);
  if (!Array.isArray(legIds) || legIds.length < 2) {
    return c.json({ ok: false, error: "A parlay needs at least 2 legs." }, 400);
  }
  if (legIds.length > db.settings.maxMultipleLegs) {
    return c.json({ ok: false, error: `Max ${db.settings.maxMultipleLegs} legs per parlay (set in Settings).` }, 400);
  }
  if (!(stake > 0)) {
    return c.json({ ok: false, error: "Stake is required and must be > 0." }, 400);
  }

  // Resolve legs from the flagged-singles pool — football + tennis, so
  // cross-sport parlays work too (sport = 'mixed').
  const football = flagSlips(slipFixtures(db), db.predictions, db.odds, db.settings);
  const tdb = await loadTennisDatabase(c.env.DB);
  const tennis = flagSlips(tennisSlipFixtures(tdb), tdb.predictions, tdb.odds, tdb.settings);
  const legs = [...football, ...tennis];
  const byKey = new Map(legs.map((l) => [`${l.fixture.id}:${l.market}:${l.selection}`, l]));
  const selected = legIds.map((k) => byKey.get(k)).filter((l): l is NonNullable<typeof l> => Boolean(l));
  if (selected.length !== legIds.length) {
    return c.json({ ok: false, error: "Some legs aren't flagged singles — every leg must clear the EV threshold on its own." }, 400);
  }

  // Correlation: same-match or same-kickoff-window legs are NOT independent.
  const corr = checkLegIndependence(selected.map((l) => ({ fixture: l.fixture, market: l.market, selection: l.selection, probability: l.probability })));
  if (!corr.independent) {
    return c.json({ ok: false, error: `Correlated legs rejected: ${corr.warnings[0] ?? "legs are not independent."}` }, 400);
  }

  const sport = selected.every((l) => l.fixture.sport === "tennis")
    ? "tennis"
    : selected.every((l) => l.fixture.sport !== "tennis")
      ? "football"
      : "mixed";
  const parlay: Parlay = {
    id: `parlay-${Math.floor(Date.now() / 1000)}-${Math.floor(Math.random() * 1e6)}`,
    ...buildParlay(selected, sport),
    stake,
    bankrollAtBet: db.settings.bankroll,
    status: "pending",
    placedAt: Math.floor(Date.now() / 1000),
  };
  await insertParlay(c.env.DB, parlay);
  return c.json({ ok: true, parlay }, 201);
});

/* ---------------- settlement alerts ---------------- */

/** Recent settlement events — powers the in-app banner + the SW notification
 *  text (the push itself is data-less; the SW fetches this for detail). */
app.get("/api/settlements/recent", async (c) => {
  const raw = Number(c.req.query("hours"));
  const hours = Number.isFinite(raw) ? Math.min(168, Math.max(1, raw)) : 48;
  return c.json({ events: await listRecentSettlements(c.env.DB, hours) });
});

/** VAPID public key for the push subscribe flow. configured=false when the
 *  worker has no VAPID keys → alerts fall back to in-app only. */
app.get("/api/push/public-key", (c) =>
  c.json({
    vapidPublicKey: c.env.VAPID_PUBLIC_KEY ?? null,
    configured: Boolean(c.env.VAPID_PUBLIC_KEY && c.env.VAPID_PRIVATE_KEY),
  }),
);

/** Store this device's browser push subscription. */
app.post("/api/push/subscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const auth = body.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    !endpoint.startsWith("https://") ||
    typeof p256dh !== "string" ||
    typeof auth !== "string"
  ) {
    return c.json({ ok: false, error: "endpoint (https://), keys.p256dh and keys.auth are required." }, 400);
  }
  await upsertPushSubscription(c.env.DB, { endpoint, p256dh, auth });
  return c.json({ ok: true }, 201);
});

/** Remove this device's push subscription (alerts turned off). */
app.post("/api/push/unsubscribe", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.endpoint === "string") await deletePushSubscription(c.env.DB, body.endpoint);
  return c.json({ ok: true });
});

/** Send a test push to one device (Settings → Test notification). */
app.post("/api/push/test", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body.endpoint !== "string") return c.json({ ok: false, error: "endpoint required." }, 400);
  const sent = await sendTestPush(c.env, body.endpoint);
  if (!sent) {
    return c.json({
      ok: false,
      error: "Push not sent — VAPID keys missing on the worker, or this device isn't subscribed.",
    }, 400);
  }
  return c.json({ ok: true });
});

/* ---------------- seed (demo / local dev) ---------------- */

app.post("/api/seed", async (c) => {
  const force = c.req.query("force") === "1";
  const result = await seedDatabase(c.env.DB, force);
  return c.json(result, result.seeded ? 200 : 409);
});

/* ---------------- manual CLV entry ---------------- */

app.post("/api/clv", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { betId, openingOdds, closingOdds, capturedAt } = body as Partial<ClvResult>;
  if (!betId || !openingOdds || !closingOdds) {
    return c.json({ ok: false, error: "betId, openingOdds, closingOdds required." }, 400);
  }
  const record: ClvResult = {
    id: `clv-${betId}-${capturedAt ?? Date.now()}`,
    betId,
    openingOdds,
    closingOdds,
    clv: Math.round(((openingOdds - closingOdds) / closingOdds) * 10000) / 10000,
    capturedAt: capturedAt ?? Math.floor(Date.now() / 1000),
  };
  await insertClv(c.env.DB, record);
  return c.json({ ok: true, clv: record }, 201);
});

/* ---------------- cron (scheduled) ---------------- */

export default {
  fetch: app.fetch,

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<unknown> {
    const cron = event.cron;
    let result: unknown;

    if (cron === "0 9,18 * * *") {
      result = await ingestOdds(env);
    } else if (cron === "30 18 * * *") {
      result = await pullClosingOdds(env);
    } else {
      result = { ok: false, note: `Unhandled cron: ${cron}` };
    }

    // Fire-and-forget log line (visible in `wrangler tail`).
    ctx.waitUntil(Promise.resolve());

    console.log(`[cron ${cron}]`, JSON.stringify(result));
    return result;
  },
};
