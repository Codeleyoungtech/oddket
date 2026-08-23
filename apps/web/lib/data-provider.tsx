"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  allPredictionsAsLegs,
  buildCalibration,
  buildClvSeries,
  buildDashboard,
  buildSeedDatabase,
  buildTennisSeedDatabase,
  enrichBets,
  flagSlips,
  runBacktest,
  type BacktestResult,
  type Bet,
  type BetWithClv,
  type CalibrationResult,
  type ClvPoint,
  type Dashboard,
  type Database,
  type Fixture,
  type Prediction,
  type Settings,
  type SlipLeg,
} from "@oddket/core";
import { api, type SportApi } from "./api";

export type Mode = "live" | "demo" | "loading";
export type Sport = "football" | "tennis";

export interface DataContextValue {
  mode: Mode;
  sport: Sport;
  /** LIVE mode: whether the worker is reachable. Demo mode: always false. */
  workerError: string | null;
  db: Database | null;
  dashboard: Dashboard | null;
  calibration: CalibrationResult | null;
  clvSeries: ClvPoint[];
  slips: SlipLeg[];
  allPredictions: SlipLeg[];
  bets: BetWithClv[];
  backtest: BacktestResult | null;
  refresh: () => void;
  setSport: (s: Sport) => void;
  saveSettings: (s: Settings) => Promise<void>;
  logBet: (bet: Omit<Bet, "id" | "status" | "bankrollAtBet">) => Promise<void>;
  /** Log a true parlay as ONE unit (all-or-nothing settlement). Cross-sport. */
  logParlay: (p: { legIds: string[]; stake: number }) => Promise<void>;
  deleteBet: (id: string) => Promise<void>;
  recordOutcome: (fixtureId: string, homeScore: number, awayScore: number) => Promise<void>;
  /** Tennis result: winner is 'home' | 'away' (no draws in tennis). */
  recordTennisOutcome: (fixtureId: string, winner: "home" | "away") => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

function computeViews(db: Database) {
  const dashboard = buildDashboard(db);
  const calibration = buildCalibration(db.predictions, db.outcomes, db.fixtures);
  const clvSeries = buildClvSeries(db.bets, db.clv);
  // In live mode the seeded demo fixtures (sport = 'soccer') also sit in the
  // DB. Only surface slips for REAL fixtures (anything pulled from The Odds
  // API; the demo seed uses sport = 'soccer') so the demo seed's fabricated
  // "edges" never reach the slip builder. Falls back to all scheduled
  // fixtures in demo mode.
  const scheduled = db.fixtures.filter((f) => f.status === "scheduled");
  const liveScheduled = scheduled.filter((f) => f.sport !== "soccer");
  const slipFixtures = liveScheduled.length > 0 ? liveScheduled : scheduled;
  const slips = flagSlips(
    slipFixtures,
    db.predictions,
    db.odds,
    db.settings,
  );
  // Tag bets: only auto-classify bets placed TODAY onwards.
  // Legacy bets (before source tagging existed) keep no source tag —
  // they won't show 🤖 or 🟡, and won't affect either dashboard summary.
  const slipKeys = new Set(slips.map((s) => `${s.fixture.id}:${s.market}:${s.selection}`));
  const startOfToday = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  })();
  const bets = enrichBets(
    db.bets.map((b) => {
      // Already tagged (logged after this feature shipped) — keep it.
      if (b.source) return b;
      // Legacy bet placed before today — leave source undefined (untracked).
      if (b.placedAt < startOfToday) return b;
      // Bet placed today without a source — auto-classify.
      return { ...b, source: slipKeys.has(`${b.fixtureId}:${b.market}:${b.selection}`) ? "model" : "manual" };
    }),
    db.fixtures,
    db.clv.map((r) => ({ betId: r.betId, clv: r.clv, closingOdds: r.closingOdds })),
  ).sort((a, b) => b.placedAt - a.placedAt);
  const backtest = runBacktest(db);
  const allPredictions = allPredictionsAsLegs(
    slipFixtures,
    db.predictions,
    db.odds,
    db.settings,
  );
  return { dashboard, calibration, clvSeries, slips, allPredictions, bets, backtest };
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>("loading");
  const [sport, setSport] = useState<Sport>("football");
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const sportApi: SportApi = sport === "tennis" ? api.tennis : api.football;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Try the worker first; fall back to deterministic seed (demo mode).
      try {
        const health = await api.health();
        if (!health.ok) throw new Error("worker unhealthy");
        const liveDb = await sportApi.db();
        if (cancelled) return;
        setDb(liveDb);
        setMode("live");
        setWorkerError(null);
      } catch {
        if (cancelled) return;
        setDb(sport === "tennis" ? buildTennisSeedDatabase() : buildSeedDatabase());
        setMode("demo");
        setWorkerError(null);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [tick, sport, sportApi]);

  const views = useMemo(() => (db ? computeViews(db) : null), [db]);

  const saveSettings = useCallback(async (s: Settings) => {
    try {
      await api.football.saveSettings(s);
    } catch {
      // demo mode: nothing to persist — provider re-derives from seed.
    }
    setDb((prev) => (prev ? { ...prev, settings: s } : prev));
  }, []);

  const logBet = useCallback(async (bet: Omit<Bet, "id" | "status" | "bankrollAtBet" | "source">) => {
    // Auto-detect source: if this (fixtureId, market, selection) is in the
    // flagged slips list, it passed all gates → 'model'. Otherwise → 'manual'.
    const isInSlips = (views?.slips ?? []).some(
      (s) => s.fixture.id === bet.fixtureId && s.market === bet.market && s.selection === bet.selection,
    );
    const source = isInSlips ? "model" : "manual";
    const withMeta = {
      ...bet,
      id: `bet-${Date.now()}`,
      status: "pending" as const,
      bankrollAtBet: 0,
      source,
    };
    try {
      await sportApi.logBet(withMeta);
    } catch (err) {
      // LIVE mode: surface the real error (e.g. stake cap) — never pretend a
      // rejected bet was logged. Demo mode only: apply locally.
      if (mode === "live") throw err;
      const prev = db ?? (sport === "tennis" ? buildTennisSeedDatabase() : buildSeedDatabase());
      setDb({ ...prev, bets: [...prev.bets, withMeta as Bet] });
    }
    setTick((t) => t + 1);
  }, [db, mode, sport, sportApi, views]);

  const logParlay = useCallback(async (p: { legIds: string[]; stake: number }) => {
    try {
      await api.logParlay(p);
    } catch (err) {
      // LIVE mode: surface the real error (gate/cap/correlation) — never
      // pretend a rejected parlay was logged. Demo mode only: apply locally.
      if (mode === "live") throw err;
      const prev = db ?? (sport === "tennis" ? buildTennisSeedDatabase() : buildSeedDatabase());
      setDb({
        ...prev,
        parlayBets: [
          {
            id: `parlay-${Date.now()}`,
            sport: "mixed" as const,
            legs: [],
            combinedOdds: 0,
            combinedProbability: 0,
            stake: p.stake,
            bankrollAtBet: prev.settings.bankroll,
            status: "pending" as const,
            placedAt: Math.floor(Date.now() / 1000),
          },
          ...prev.parlayBets,
        ],
      });
    }
    setTick((t) => t + 1);
  }, [db, mode, sport]);

  const deleteBet = useCallback(async (id: string) => {
    try {
      await sportApi.deleteBet(id);
    } catch {
      // demo mode: apply locally.
      const prev = db ?? (sport === "tennis" ? buildTennisSeedDatabase() : buildSeedDatabase());
      setDb({ ...prev, bets: prev.bets.filter((b) => b.id !== id) });
    }
    setTick((t) => t + 1);
  }, [db, sport, sportApi]);

  const recordOutcome = useCallback(async (fixtureId: string, homeScore: number, awayScore: number) => {
    try {
      await sportApi.recordOutcome({ fixtureId, homeScore, awayScore });
    } catch {
      // demo mode: apply locally.
      const prev = db ?? (sport === "tennis" ? buildTennisSeedDatabase() : buildSeedDatabase());
      const outcome = {
        id: `out-${fixtureId}`,
        fixtureId,
        homeScore,
        awayScore,
        settledAt: Math.floor(Date.now() / 1000),
      };
      setDb({
        ...prev,
        outcomes: [...prev.outcomes.filter((o) => o.fixtureId !== fixtureId), outcome],
        fixtures: prev.fixtures.map((f) =>
          f.id === fixtureId ? { ...f, status: "finished" as const, homeScore, awayScore } : f,
        ),
      });
    }
    setTick((t) => t + 1);
  }, [db, sport, sportApi]);

  const recordTennisOutcome = useCallback(async (fixtureId: string, winner: "home" | "away") => {
    try {
      await api.tennis.recordOutcome({ fixtureId, winner });
    } catch {
      // demo mode: apply locally (encode winner as score for shared math).
      const prev = db ?? buildTennisSeedDatabase();
      const outcome = {
        id: `out-${fixtureId}`,
        fixtureId,
        homeScore: winner === "home" ? 1 : 0,
        awayScore: winner === "home" ? 0 : 1,
        settledAt: Math.floor(Date.now() / 1000),
      };
      setDb({
        ...prev,
        outcomes: [...prev.outcomes.filter((o) => o.fixtureId !== fixtureId), outcome],
        fixtures: prev.fixtures.map((f) =>
          f.id === fixtureId ? { ...f, status: "finished" as const } : f,
        ),
      });
    }
    setTick((t) => t + 1);
  }, [db]);

  const value = useMemo<DataContextValue>(
    () => ({
      mode,
      sport,
      workerError,
      db,
      dashboard: views?.dashboard ?? null,
      calibration: views?.calibration ?? null,
      clvSeries: views?.clvSeries ?? [],
      slips: views?.slips ?? [],
      allPredictions: views?.allPredictions ?? [],
      bets: views?.bets ?? [],
      backtest: views?.backtest ?? null,
      refresh,
      setSport,
      saveSettings,
      logBet,
      logParlay,
      deleteBet,
      recordOutcome,
      recordTennisOutcome,
    }),
    [mode, sport, workerError, db, views, refresh, saveSettings, logBet, logParlay, deleteBet, recordOutcome, recordTennisOutcome],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used within <DataProvider>");
  return ctx;
}

