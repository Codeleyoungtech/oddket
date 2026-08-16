import { TENNIS_SPORTS } from "@oddket/core";
import type { Env } from "../db";
import { getSettings, loadTennisDatabase, upsertTennisFixtures, upsertTennisOdds, insertTennisClv } from "../db";
import { fetchTennisOdds } from "./tennis-client";

export interface TennisIngestResult {
  mode: "live" | "demo";
  tournaments: number;
  eventsPulled: number;
  fixturesStored: number;
  snapshotsStored: number;
  activeSports?: string[];
  note?: string;
}

/**
 * Cron job: pull current odds for the selected tennis tournaments and store
 * snapshots in the tennis_* tables (fully isolated from football).
 * Env-gated — demo no-op without ODDS_API_KEY.
 *
 * Budget: each tournament sport key = 1 API credit, and out-of-season
 * tournaments return empty. The tenant selects which tournaments to track
 * (settings.leagues, defaulting to all ATP main-tour keys); only in-season
 * keys actually consume credits on data, but every key tried costs 1 credit.
 */
export async function ingestTennisOdds(env: Env): Promise<TennisIngestResult> {
  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) {
    return {
      mode: "demo",
      tournaments: 0,
      eventsPulled: 0,
      fixturesStored: 0,
      snapshotsStored: 0,
      note: "No ODDS_API_KEY configured — demo mode, nothing pulled.",
    };
  }

  const settings = await getSettings(env.DB);
  const selected = (settings.leagues ?? [])
    .map((name) => TENNIS_SPORTS[name])
    .filter((k): k is string => Boolean(k));

  // Settings (UI toggles) take precedence; env TENNIS_SPORTS=key1,key2 is a
  // deploy-level fallback; otherwise all ATP main-tour keys are tried
  // (empty = out of season, safe, costs 0 credits).
  const envKeys = (env.TENNIS_SPORTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sportKeys = selected.length > 0 ? selected : envKeys.length > 0 ? envKeys : Object.values(TENNIS_SPORTS);

  const { events, activeSports } = await fetchTennisOdds(apiKey, sportKeys, {
    regions: env.ODDS_REGIONS ?? "eu",
    fetchLimit: Number(env.ODDS_FETCH_LIMIT ?? 50),
  });

  const fixtures = events.map((e) => e.fixture);
  const snapshots = events.flatMap((e) => e.snapshots);

  await upsertTennisFixtures(env.DB, fixtures);
  await upsertTennisOdds(env.DB, snapshots);

  return {
    mode: "live",
    tournaments: activeSports.length,
    eventsPulled: events.length,
    fixturesStored: fixtures.length,
    snapshotsStored: snapshots.length,
    activeSports,
  };
}

export interface TennisClosingResult {
  mode: "live" | "demo";
  pendingBets: number;
  clvStored: number;
  note?: string;
}

/**
 * Daily closing-odds pull for logged TENNIS bets → CLV records.
 * For each pending tennis bet, find the closing snapshot for its selection
 * and write a clv_results row. Env-gated demo no-op without ODDS_API_KEY.
 */
export async function pullTennisClosingOdds(env: Env): Promise<TennisClosingResult> {
  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) {
    return { mode: "demo", pendingBets: 0, clvStored: 0, note: "No ODDS_API_KEY — demo no-op." };
  }

  const db = await loadTennisDatabase(env.DB);
  const pending = db.bets.filter((b) => b.status === "pending");

  const settings = await getSettings(env.DB);
  const selected = (settings.leagues ?? [])
    .map((name) => TENNIS_SPORTS[name])
    .filter((k): k is string => Boolean(k));
  const envKeys = (env.TENNIS_SPORTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Settings (UI toggles) take precedence — same rule as ingest, so closing
  // tracks exactly the tournaments the tenant enabled.
  const sportKeys = selected.length > 0 ? selected : envKeys.length > 0 ? envKeys : Object.values(TENNIS_SPORTS);

  const { events } = await fetchTennisOdds(apiKey, sportKeys, {
    regions: env.ODDS_REGIONS ?? "eu",
    fetchLimit: Number(env.ODDS_FETCH_LIMIT ?? 50),
  });

  // Current best price per (fixture, selection) from this pull = the line we
  // compare against. Closing odds are the freshest snapshot before kickoff.
  const bestByKey = new Map<string, number>();
  for (const e of events) {
    for (const s of e.snapshots) {
      const key = `${s.fixtureId}:${s.selection}`;
      const cur = bestByKey.get(key);
      if (cur === undefined || s.odds > cur) bestByKey.set(key, s.odds);
    }
  }

  let clvStored = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const bet of pending) {
    const closing = bestByKey.get(`${bet.fixtureId}:${bet.selection}`);
    if (!closing || closing <= 1) continue;
    const record = {
      id: `tclv-${bet.id}-${now}`,
      betId: bet.id,
      openingOdds: bet.odds,
      closingOdds: closing,
      clv: Math.round(((bet.odds - closing) / closing) * 10000) / 10000,
      capturedAt: now,
    };
    await insertTennisClv(env.DB, record);
    clvStored++;
  }

  return { mode: "live", pendingBets: pending.length, clvStored };
}
