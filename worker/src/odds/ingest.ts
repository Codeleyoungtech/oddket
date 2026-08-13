import type { Env } from "../db";
import { upsertFixtures, upsertOdds } from "../db";
import { fetchOdds, mapEvent } from "./client";

export interface IngestResult {
  mode: "live" | "demo";
  eventsPulled: number;
  fixturesStored: number;
  snapshotsStored: number;
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

  const events = await fetchOdds(apiKey, {
    sport: env.ODDS_SPORT ?? "soccer_epl",
    regions: env.ODDS_REGIONS ?? "eu",
    markets: env.ODDS_MARKETS ?? "h2h,totals",
    fetchLimit: Number(env.ODDS_FETCH_LIMIT ?? 10),
  });

  const capturedAt = Math.floor(Date.now() / 1000);
  const bookmakerKeys = ["bet365", "sportybet", "betway"];

  const fixtures = events.map((e) => mapEvent(e, bookmakerKeys, capturedAt));
  const fixturesToStore = fixtures.map((f) => f.fixture);
  const snapshotsToStore = fixtures.flatMap((f) => f.snapshots);

  await upsertFixtures(env.DB, fixturesToStore);
  await upsertOdds(env.DB, snapshotsToStore);

  return {
    mode: "live",
    eventsPulled: events.length,
    fixturesStored: fixturesToStore.length,
    snapshotsStored: snapshotsToStore.length,
  };
}
