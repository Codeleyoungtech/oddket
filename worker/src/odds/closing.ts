import type { Bet, ClvResult, OddsSnapshot } from "@oddket/core";
import type { Env } from "../db";
import { insertClv, upsertFixtures, upsertOdds } from "../db";
import { fetchOdds, mapEvent } from "./client";

export interface ClosingResult {
  mode: "live" | "demo";
  pendingBets: number;
  clvComputed: number;
  note?: string;
}

/**
 * Cron job (once daily, just before kickoffs): pull the latest odds for every
 * fixture with a pending bet, then compute CLV = (bet odds − closing odds) / closing odds
 * for each. This is the scoreboard — not win/loss.
 */
export async function pullClosingOdds(env: Env): Promise<ClosingResult> {
  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) {
    return {
      mode: "demo",
      pendingBets: 0,
      clvComputed: 0,
      note: "No ODDS_API_KEY configured — CLV cron is a no-op.",
    };
  }

  const pendingRows = await env.DB.prepare(
    `SELECT b.*, f.commence_time AS ct
       FROM bets b JOIN fixtures f ON f.id = b.fixture_id
      WHERE b.status = 'pending' AND f.commence_time > ?1`,
  )
    .bind(Math.floor(Date.now() / 1000))
    .all<Record<string, unknown> & { id: string; ct: number }>();

  const pending = (pendingRows.results ?? []) as unknown as Array<Bet & { ct: number }>;
  if (pending.length === 0) {
    return { mode: "live", pendingBets: 0, clvComputed: 0, note: "No pending bets with upcoming fixtures." };
  }

  const events = await fetchOdds(apiKey, {
    sport: env.ODDS_SPORT ?? "soccer_epl",
    regions: env.ODDS_REGIONS ?? "eu",
    markets: env.ODDS_MARKETS ?? "h2h,totals",
    fetchLimit: 25,
  });

  const capturedAt = Math.floor(Date.now() / 1000);
  const bookmakerKeys = ["bet365", "sportybet", "betway"];
  const mapped = events.map((e) => mapEvent(e, bookmakerKeys, capturedAt));

  const fixturesToStore = mapped.map((m) => m.fixture);
  const snapshotsToStore: OddsSnapshot[] = [];
  const closingByFixture = new Map<string, OddsSnapshot[]>();

  for (const m of mapped) {
    const closing = m.snapshots.map((s) => ({ ...s, isClosing: true, capturedAt }));
    closingByFixture.set(m.fixture.id, closing);
    snapshotsToStore.push(...closing);
  }

  await upsertFixtures(env.DB, fixturesToStore);
  await upsertOdds(env.DB, snapshotsToStore);

  let clvComputed = 0;
  for (const bet of pending) {
    const closing = closingByFixture.get(bet.fixtureId)?.filter((s) => s.selection === bet.selection);
    if (!closing || closing.length === 0) continue;

    // Best available closing odds for the same selection.
    const best = [...closing].sort((a, b) => b.odds - a.odds)[0]!;
    if (best.odds <= 1.01) continue;

    const clv = (bet.odds - best.odds) / best.odds;
    const record: ClvResult = {
      id: `clv-${bet.id}`,
      betId: bet.id,
      openingOdds: bet.odds,
      closingOdds: best.odds,
      clv: Math.round(clv * 10000) / 10000,
      capturedAt,
    };
    await insertClv(env.DB, record);
    clvComputed++;
  }

  return { mode: "live", pendingBets: pending.length, clvComputed };
}
