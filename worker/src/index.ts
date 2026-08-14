import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  buildCalibration,
  buildClvSeries,
  buildDashboard,
  buildMultiple,
  enrichBets,
  flagSlips,
  runBacktest,
  type Bet,
  type ClvResult,
  type Database,
  type Fixture,
  type Prediction,
} from "@oddket/core";
import type { Env } from "./db";
import {
  getSettings,
  insertBet,
  insertClv,
  loadDatabase,
  putSettings,
  settlePendingBets,
  upsertOutcomes,
  upsertPredictions,
} from "./db";
import { ingestOdds } from "./odds/ingest";
import { pullClosingOdds } from "./odds/closing";
import { seedDatabase } from "./seed";

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
  const body = await c.req.json().catch(() => ({}));
  const legIds: string[] = body.legIds ?? [];
  const db = await loadDatabase(c.env.DB);
  const legs = flagSlips(slipFixtures(db), db.predictions, db.odds, db.settings);
  const byKey = new Map(legs.map((l) => [`${l.fixture.id}:${l.market}:${l.selection}`, l]));
  const selected = legIds.map((k) => byKey.get(k)).filter((l): l is NonNullable<typeof l> => Boolean(l));
  if (selected.length === 0) {
    return c.json({ ok: false, error: "No valid legs selected." }, 400);
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
  return c.json({ ok: true, outcomesStored: rows.length, betsSettled: settled });
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
