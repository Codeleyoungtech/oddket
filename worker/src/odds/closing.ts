import { LEAGUE_SPORTS, type Bet, type ClvResult, type OddsSnapshot } from "@oddket/core";
import type { Env } from "../db";
import { getSettings, insertClv, toBet, upsertFixtures, upsertOdds } from "../db";
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
    .all<Record<string, unknown> & { ct: number }>();

  // Map snake_case rows → camelCase Bet objects (fixture_id → fixtureId).
  // Reading bet.fixtureId straight off the raw row is undefined, so the
  // closing-odds lookup always missed and CLV stayed 0.
  const pending = (pendingRows.results ?? []).map((r) => ({
    ...toBet(r as unknown as Parameters<typeof toBet>[0]),
    ct: (r as { ct: number }).ct,
  }));
  if (pending.length === 0) {
    return { mode: "live", pendingBets: 0, clvComputed: 0, note: "No pending bets with upcoming fixtures." };
  }

  // Pull closing odds for the SAME leagues the ingest uses (settings.leagues),
  // not just the env default — otherwise La Liga/Serie A/Bundesliga bets
  // would never get a closing line and CLV would stay 0 forever.
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
    fetchLimit: Number(env.ODDS_FETCH_LIMIT ?? 200),
  });

  const capturedAt = Math.floor(Date.now() / 1000);
  // Keep ALL bookmakers (same as ingest): filtering to bet365/sportybet/betway
  // drops these fixtures entirely in the eu region — none of those books carry
  // them — leaving zero closing rows and CLV stuck at 0.
  const bookmakerKeys: string[] = [];
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

    // Use MEDIAN closing odds across all bookmakers for the same selection.
    // Best-available (previously used) creates systematic negative bias when
    // the user bets at a recreational book (e.g. SportyBet, wider margins)
    // while the "best" comes from a sharper book (bet365/Pinnacle, tighter
    // margins).  Median is a robust estimate of the true market price and
    // removes the bookmaker mismatch.  See docs/clv-audit.md for details.
    const sortedOdds = [...closing]
      .map((s) => s.odds)
      .filter((o) => o > 1.01)
      .sort((a, b) => a - b);
    if (sortedOdds.length === 0) continue;
    const mid = Math.floor(sortedOdds.length / 2);
    const medianOdds =
      sortedOdds.length % 2 === 0
        ? (sortedOdds[mid - 1]! + sortedOdds[mid]!) / 2
        : sortedOdds[mid]!;
    if (medianOdds <= 1.01) continue;

    const clv = (bet.odds - medianOdds) / medianOdds;
    const record: ClvResult = {
      id: `clv-${bet.id}`,
      betId: bet.id,
      openingOdds: bet.odds,
      closingOdds: Math.round(medianOdds * 100) / 100,
      clv: Math.round(clv * 10000) / 10000,
      capturedAt,
    };
    await insertClv(env.DB, record);
    clvComputed++;
  }

  return { mode: "live", pendingBets: pending.length, clvComputed };
}
