"use client";

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  buildCalibration,
  buildClvSeries,
  buildDashboard,
  buildSeedDatabase,
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
import { api, apiBase } from "./api";

export type Mode = "live" | "demo" | "loading";

export interface DataContextValue {
  mode: Mode;
  /** LIVE mode: whether the worker is reachable. Demo mode: always false. */
  workerError: string | null;
  db: Database | null;
  dashboard: Dashboard | null;
  calibration: CalibrationResult | null;
  clvSeries: ClvPoint[];
  slips: SlipLeg[];
  bets: BetWithClv[];
  backtest: BacktestResult | null;
  refresh: () => void;
  saveSettings: (s: Settings) => Promise<void>;
  logBet: (bet: Omit<Bet, "id" | "status" | "bankrollAtBet">) => Promise<void>;
  recordOutcome: (fixtureId: string, homeScore: number, awayScore: number) => Promise<void>;
}

const DataContext = createContext<DataContextValue | null>(null);

function computeViews(db: Database) {
  const dashboard = buildDashboard(db);
  const calibration = buildCalibration(db.predictions, db.outcomes, db.fixtures);
  const clvSeries = buildClvSeries(db.bets, db.clv);
  const slips = flagSlips(
    db.fixtures.filter((f) => f.status === "scheduled"),
    db.predictions,
    db.odds,
    db.settings,
  );
  const bets = enrichBets(
    db.bets,
    db.fixtures,
    db.clv.map((r) => ({ betId: r.betId, clv: r.clv, closingOdds: r.closingOdds })),
  ).sort((a, b) => b.placedAt - a.placedAt);
  const backtest = runBacktest(db);
  return { dashboard, calibration, clvSeries, slips, bets, backtest };
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>("loading");
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [db, setDb] = useState<Database | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Try the worker first; fall back to deterministic seed (demo mode).
      try {
        const health = await api.health();
        if (!health.ok) throw new Error("worker unhealthy");
        const liveDb = await api.db();
        if (cancelled) return;
        setDb(liveDb);
        setMode("live");
        setWorkerError(null);
      } catch {
        if (cancelled) return;
        setDb(buildSeedDatabase());
        setMode("demo");
        setWorkerError(null);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const views = useMemo(() => (db ? computeViews(db) : null), [db]);

  const saveSettings = useCallback(async (s: Settings) => {
    try {
      await api.saveSettings(s);
    } catch {
      // demo mode: nothing to persist — provider re-derives from seed.
    }
    setDb((prev) => (prev ? { ...prev, settings: s } : prev));
  }, []);

  const logBet = useCallback(async (bet: Omit<Bet, "id" | "status" | "bankrollAtBet">) => {
    const withMeta = {
      ...bet,
      id: `bet-${Date.now()}`,
      status: "pending" as const,
      bankrollAtBet: 0,
    };
    try {
      await api.logBet(withMeta);
    } catch {
      // demo mode: apply locally.
      const prev = db ?? buildSeedDatabase();
      setDb({ ...prev, bets: [...prev.bets, withMeta as Bet] });
    }
    setTick((t) => t + 1);
  }, [db]);

  const recordOutcome = useCallback(async (fixtureId: string, homeScore: number, awayScore: number) => {
    try {
      await api.recordOutcome({ fixtureId, homeScore, awayScore });
    } catch {
      // demo mode: apply locally.
      const prev = db ?? buildSeedDatabase();
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
  }, [db]);

  const value = useMemo<DataContextValue>(
    () => ({
      mode,
      workerError,
      db,
      dashboard: views?.dashboard ?? null,
      calibration: views?.calibration ?? null,
      clvSeries: views?.clvSeries ?? [],
      slips: views?.slips ?? [],
      bets: views?.bets ?? [],
      backtest: views?.backtest ?? null,
      refresh,
      saveSettings,
      logBet,
      recordOutcome,
    }),
    [mode, workerError, db, views, refresh, saveSettings, logBet, recordOutcome],
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error("useData must be used within <DataProvider>");
  return ctx;
}

export { apiBase };
