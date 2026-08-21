import { LEAGUE_SPORTS } from "@oddket/core";
import type { Env } from "../db";
import { getSettings, upsertFixtures, upsertOdds } from "../db";
import { fetchOdds, mapEvent } from "./client";

export interface IngestResult {
  mode: "live" | "demo";
  eventsPulled: number;
  fixturesStored: number;
  snapshotsStored: number;
  cleanedLeagues?: number;
  note?: string;
}

/**
 * Cron job: pull current odds for the configured sport and store snapshots.
 * Env-gated — returns a demo-mode no-op when ODDS_API_KEY is absent, so local
 * dev and the free-tier budget are both safe by default.
 */
export async function ingestOdds(env: Env): Promise<IngestResult> {
  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) {
    return {
      mode: "demo",
      eventsPulled: 0,
      fixturesStored: 0,
      snapshotsStored: 0,
      note: "No ODDS_API_KEY configured — demo mode, nothing pulled.",
    };
  }

  // Leagues come from Settings (UI toggle), falling back to env / default.
  const settings = await getSettings(env.DB);
  const selected = (settings.leagues ?? [])
    .map((name) => LEAGUE_SPORTS[name])
    .filter((k): k is string => Boolean(k));
  const sports =
    selected.length > 0 ? selected : [env.ODDS_SPORT ?? "soccer_epl"];

  const events = await fetchOdds(apiKey, {
    sports,
    regions: env.ODDS_REGIONS ?? "eu",
    markets: env.ODDS_MARKETS ?? "h2h,totals",
    fetchLimit: Number(env.ODDS_FETCH_LIMIT ?? 50),
    bookmakers: env.ODDS_BOOKMAKERS,
  });

  const capturedAt = Math.floor(Date.now() / 1000);
  // Keep ALL bookmakers: filtering to bet365/sportybet/betway drops the totals
  // market entirely in the eu region (none of those books carry it there).
  // Storing every book also gives the best-price entry the strategy relies on.
  const bookmakerKeys: string[] = [];

  const fixtures = events.map((e) => mapEvent(e, bookmakerKeys, capturedAt));
  const fixturesToStore = fixtures.map((f) => f.fixture);
  const snapshotsToStore = fixtures.flatMap((f) => f.snapshots);

  await upsertFixtures(env.DB, fixturesToStore);
  await upsertOdds(env.DB, snapshotsToStore);

  // Drop predictions + odds for live fixtures in leagues that are no longer
  // selected, so turning a league off removes its stale slips/CLV inputs.
  const keepSports = new Set(events.map((e) => e.sport_key));
  const liveRows = await env.DB.prepare(
    "SELECT id, sport FROM fixtures WHERE sport != 'soccer'",
  ).all<{ id: string; sport: string }>();
  for (const f of liveRows.results ?? []) {
    if (keepSports.has(f.sport)) continue;
    await env.DB.prepare("DELETE FROM predictions WHERE fixture_id = ?1").bind(f.id).run();
    await env.DB.prepare("DELETE FROM odds_snapshots WHERE fixture_id = ?1").bind(f.id).run();
  }

  return {
    mode: "live",
    eventsPulled: events.length,
    fixturesStored: fixturesToStore.length,
    snapshotsStored: snapshotsToStore.length,
    cleanedLeagues: [...new Set(liveRows.results ?? [])].filter((f) => !keepSports.has(f.sport)).length,
  };
}
