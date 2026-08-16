import { LEAGUE_SPORTS, TENNIS_SPORTS, type Outcome } from "@oddket/core";
import type { Env } from "../db";
import {
  getSettings,
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
  note?: string;
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

  const settings = await getSettings(env.DB);
  const footballSports = (settings.leagues ?? [])
    .map((name) => LEAGUE_SPORTS[name])
    .filter((k): k is string => Boolean(k));
  const selectedTennis = (settings.leagues ?? [])
    .map((name) => TENNIS_SPORTS[name])
    .filter((k): k is string => Boolean(k));
  const envKeys = (env.TENNIS_SPORTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const tennisSports = selectedTennis.length > 0 ? selectedTennis : envKeys.length > 0 ? envKeys : Object.values(TENNIS_SPORTS);

  const now = Math.floor(Date.now() / 1000);

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

  return { mode: "live", footballCompleted, footballSettled, tennisCompleted, tennisSettled };
}
