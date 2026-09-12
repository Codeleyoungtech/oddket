import type { Outcome } from "@oddket/core";
import type { Env } from "../db";
import {
  markFixturesFinished,
  markTennisFinished,
  settlePendingBets,
  settleTennisBets,
  upsertOutcomes,
} from "../db";
import { ODDS_API_BASE, parseApiKeys } from "./client";

export interface SettleResult {
  mode: "live" | "demo";
  footballCompleted: number;
  footballSettled: number;
  tennisCompleted: number;
  tennisSettled: number;
  /** How many /scores calls this run made — the credit cost of the run. */
  scoresPulls?: number;
  /** Sport keys actually queried (diagnostic for "why is nothing settling?"). */
  sportsQueried?: string[];
  note?: string;
}

/**
 * Sport keys that could ACTUALLY need settling right now:
 *   - a pending bet on a fixture that has already kicked off (any age — a
 *     late-logged bet must still settle), or
 *   - a not-yet-finished fixture whose kickoff was inside the window
 *     (so the result gets recorded and the fixture flips to finished).
 *
 * Why this exists: the old code pulled /scores for EVERY selected league +
 * every tennis tournament on every run — with 12 football leagues + ~20 ATP
 * tournaments twice a day that is ~1,900 requests/month against a
 * 500-per-key free tier, so every key 429'd and the run silently reported
 * "0 completed" while bets stayed pending for days. Scoping the pull to the
 * handful of leagues that actually have unfinished business fixes the root
 * cause instead of the symptom.
 */
async function relevantSports(
  env: Env,
  now: number,
  windowDays: number,
): Promise<{ football: string[]; tennis: string[] }> {
  const since = now - windowDays * 86400;
  const [footballRes, tennisRes] = await Promise.all([
    env.DB.prepare(
      `SELECT DISTINCT f.sport AS sport
         FROM fixtures f
         LEFT JOIN bets b ON b.fixture_id = f.id AND b.status = 'pending'
        WHERE f.sport LIKE 'soccer%'
          AND (
            (b.id IS NOT NULL AND f.commence_time <= ?1)
            OR (f.status != 'finished' AND f.commence_time <= ?1 AND f.commence_time >= ?2)
          )`,
    )
      .bind(now, since)
      .all<{ sport: string }>(),
    env.DB.prepare(
      `SELECT DISTINCT m.sport AS sport
         FROM tennis_matches m
         LEFT JOIN tennis_bets tb ON tb.fixture_id = m.id AND tb.status = 'pending'
        WHERE (tb.id IS NOT NULL AND m.commence_time <= ?1)
           OR (m.status != 'finished' AND m.commence_time <= ?1 AND m.commence_time >= ?2)`,
    )
      .bind(now, since)
      .all<{ sport: string }>(),
  ]);
  const uniq = (rows: Array<{ sport: string }> | undefined) =>
    [...new Set((rows ?? []).map((r) => r.sport).filter(Boolean))];
  return { football: uniq(footballRes.results), tennis: uniq(tennisRes.results) };
}

interface ScoreEvent {
  id: string;
  sport_key: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: Array<{ name: string; score: string }> | null;
}

/**
 * Pull completed scores for a list of sport keys (The Odds API /scores
 * endpoint — 1 credit per key per call, same free tier as /odds). Round-robins
 * across the configured API keys with fallback, mirroring fetchOdds.
 */
async function fetchScores(apiKey: string, sportKeys: string[], daysFrom = 2): Promise<ScoreEvent[]> {
  const keys = parseApiKeys(apiKey);
  if (keys.length === 0) return [];

  const all: ScoreEvent[] = [];
  let cursor = Math.floor(Math.random() * keys.length);
  for (const sport of sportKeys) {
    let got = false;
    for (let attempt = 0; attempt < keys.length && !got; attempt++) {
      const key = keys[cursor % keys.length]!;
      cursor++;
      const url =
        `${ODDS_API_BASE}/sports/${sport}/scores/` +
        `?apiKey=${encodeURIComponent(key)}` +
        `&daysFrom=${daysFrom}`;
      try {
        const res = await fetch(url);
        if (res.status === 401 || res.status === 429) {
          console.error(`[settle] ${sport}: key ${attempt + 1} failed (${res.status}) — trying next key`);
          continue;
        }
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`The Odds API ${res.status} for ${sport} scores: ${body.slice(0, 200)}`);
        }
        const events = (await res.json()) as ScoreEvent[];
        all.push(...events);
        got = true;
      } catch (err) {
        console.error(`[settle] ${sport} scores: fetch error — trying next key`);
      }
    }
    if (!got) {
      // Every configured key refused this sport. The usual cause is the
      // free-tier monthly credit being spent (429) — which used to look like
      // "the cron ran fine but nothing ever settles".
      console.error(`[settle] ${sport}: no key returned scores (all keys 401/429/network) — credit budget likely exhausted`);
    }
  }
  return all;
}

/**
 * Auto-settle pipeline (the missing "results" leg of the loop): pull completed
 * scores for the selected football leagues + tennis tournaments, record
 * outcomes / winners, and settle pending bets. Runs on a cron — no manual
 * result entry needed anymore. Env-gated demo no-op without ODDS_API_KEY.
 */
export async function settleFinishedMatches(env: Env): Promise<SettleResult> {
  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) {
    return {
      mode: "demo",
      footballCompleted: 0,
      footballSettled: 0,
      tennisCompleted: 0,
      tennisSettled: 0,
      note: "No ODDS_API_KEY — demo no-op.",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  const { football: footballSports, tennis: tennisSports } = await relevantSports(env, now, 3);
  const scoresPulls = footballSports.length + tennisSports.length;
  const sportsQueried = [...footballSports, ...tennisSports];

  if (scoresPulls === 0) {
    return {
      mode: "live",
      footballCompleted: 0,
      footballSettled: 0,
      tennisCompleted: 0,
      tennisSettled: 0,
      scoresPulls: 0,
      sportsQueried: [],
      note: "Nothing to settle — no pending bets on kicked-off fixtures and no recently-played unfinished fixtures.",
    };
  }

  /* ---------------- football ---------------- */
  let footballCompleted = 0;
  let footballSettled = 0;
  if (footballSports.length > 0) {
    const events = await fetchScores(apiKey, footballSports);
    const outcomes: Outcome[] = [];
    const finishedIds: string[] = [];
    for (const e of events) {
      if (!e.completed || !e.scores) continue;
      const byName = new Map(e.scores.map((s) => [s.name, parseInt(s.score, 10)]));
      const home = byName.get(e.home_team);
      const away = byName.get(e.away_team);
      if (home === undefined || away === undefined) continue;
      footballCompleted++;
      outcomes.push({
        id: `out-${e.id}`,
        fixtureId: e.id,
        homeScore: home,
        awayScore: away,
        settledAt: now,
      });
      finishedIds.push(e.id);
    }
    await upsertOutcomes(env.DB, outcomes);
    await markFixturesFinished(env.DB, finishedIds);
    footballSettled = await settlePendingBets(env.DB);
  }

  /* ---------------- tennis ---------------- */
  let tennisCompleted = 0;
  let tennisSettled = 0;
  if (tennisSports.length > 0) {
    const events = await fetchScores(apiKey, tennisSports);
    const winners: Array<{ id: string; winner: "home" | "away" }> = [];
    for (const e of events) {
      if (!e.completed || !e.scores) continue;
      const byName = new Map(e.scores.map((s) => [s.name, parseInt(s.score, 10)]));
      const home = byName.get(e.home_team);
      const away = byName.get(e.away_team);
      if (home === undefined || away === undefined) continue;
      if (home === away) continue; // no winner yet
      tennisCompleted++;
      winners.push({ id: e.id, winner: home > away ? "home" : "away" });
    }
    await markTennisFinished(env.DB, winners);
    tennisSettled = await settleTennisBets(env.DB);
  }

  return {
    mode: "live",
    footballCompleted,
    footballSettled,
    tennisCompleted,
    tennisSettled,
    scoresPulls,
    sportsQueried,
  };
}
