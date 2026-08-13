"use client";

import React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BankrollPoint, ByMarketRow, CalibrationBin, ClvPoint } from "@oddket/core";

const GRID = "#1c2636";
const AXIS = "#64748b";

function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-ink-600/70 bg-ink-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      <p className="mb-1 font-medium text-slate-300">{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} className="tabular flex items-center gap-2 text-slate-400">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color ?? p.fill }} />
          {p.name}: <span className="font-semibold text-slate-200">{formatter ? formatter(p.value) : p.value}</span>
        </p>
      ))}
    </div>
  );
}

/** Cumulative CLV — the headline scoreboard. */
export function ClvChart({ data }: { data: ClvPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="clvFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
            <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="n"
          tick={{ fill: AXIS, fontSize: 11 }}
          tickLine={false}
          axisLine={{ stroke: GRID }}
          label={{ value: "bet #", position: "insideBottomRight", fill: AXIS, fontSize: 11, dy: 8 }}
        />
        <YAxis tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v}`} />
        <Tooltip content={<ChartTooltip formatter={(v: number) => (v > 0 ? "+" : "") + v.toFixed(3)} />} />
        <ReferenceLine y={0} stroke="#334155" />
        <Area type="monotone" dataKey="cumulativeClv" name="cumulative CLV" stroke="#34d399" strokeWidth={2} fill="url(#clvFill)" dot={false} activeDot={{ r: 4 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** Calibration curve: predicted probability vs actual hit rate + ideal line. */
export function CalibrationChart({ bins }: { bins: CalibrationBin[] }) {
  const data = bins.filter((b) => b.count > 0);
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="bin" tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={(v: number) => v.toFixed(1)} label={{ value: "predicted probability", position: "insideBottomRight", fill: AXIS, fontSize: 11, dy: 8 }} />
        <YAxis domain={[0, 1]} tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(1)} />
        <Tooltip
          content={({ active, payload, label }: any) => {
            if (!active || !payload?.length) return null;
            const b = payload[0]?.payload as CalibrationBin;
            return (
              <div className="rounded-lg border border-ink-600/70 bg-ink-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
                <p className="mb-1 font-medium text-slate-300">predicted ~{Number(label).toFixed(1)}</p>
                <p className="tabular text-slate-400">
                  actual: <span className="font-semibold text-slate-200">{(b.actual * 100).toFixed(1)}%</span>
                </p>
                <p className="tabular text-slate-400">
                  n: <span className="font-semibold text-slate-200">{b.count}</span>
                </p>
                <p className="tabular text-slate-400">
                  Wilson CI: <span className="font-semibold text-slate-200">{b.low.toFixed(2)}–{b.high.toFixed(2)}</span>
                </p>
              </div>
            );
          }}
        />
        <Line type="monotone" dataKey="actual" name="actual" stroke="#38bdf8" strokeWidth={2} dot={{ r: 4, fill: "#38bdf8", strokeWidth: 0 }} activeDot={{ r: 6 }} />
        <Line type="monotone" dataKey="predicted" name="predicted" stroke="#34d399" strokeWidth={1.5} strokeDasharray="6 4" dot={false} />
        <ReferenceLine segment={[{ x: 0.05, y: 0.05 }, { x: 0.95, y: 0.95 }]} stroke="#334155" strokeDasharray="2 4" />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Bankroll curve with drawdown area. */
export function BankrollChart({ data }: { data: BankrollPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="bkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.28} />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="n" tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} label={{ value: "bet #", position: "insideBottomRight", fill: AXIS, fontSize: 11, dy: 8 }} />
        <YAxis tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} domain={["auto", "auto"]} tickFormatter={(v: number) => v.toLocaleString()} />
        <Tooltip content={<ChartTooltip formatter={(v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 })} />} />
        <Area type="monotone" dataKey="bankroll" name="bankroll" stroke="#38bdf8" strokeWidth={2} fill="url(#bkFill)" dot={false} activeDot={{ r: 4 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** ROI / avg CLV by market. */
export function ByMarketChart({ data }: { data: ByMarketRow[] }) {
  const rows = data.length ? data : [{ market: "h2h" as const, bets: 0, winRate: 0, roiPct: 0, avgClv: 0 }];
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="market" tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`} />
        <Tooltip content={<ChartTooltip formatter={(v: number) => `${(v * 100).toFixed(1)}%`} />} />
        <ReferenceLine y={0} stroke="#334155" />
        <Bar dataKey="roiPct" name="ROI" radius={[4, 4, 0, 0]}>
          {rows.map((r, i) => (
            <Cell key={i} fill={r.roiPct >= 0 ? "#34d399" : "#f87171"} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Backtest CLV per-bet bars (win/lose + CLV direction). */
export function ClvBars({ data }: { data: Array<{ n: number; clv: number }> }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 8 }}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="n" tick={{ fill: AXIS, fontSize: 10 }} tickLine={false} axisLine={{ stroke: GRID }} />
        <YAxis tick={{ fill: AXIS, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(2)} />
        <Tooltip content={<ChartTooltip formatter={(v: number) => (v > 0 ? "+" : "") + v.toFixed(3)} />} />
        <ReferenceLine y={0} stroke="#334155" />
        <Bar dataKey="clv" name="CLV" radius={[2, 2, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.clv >= 0 ? "#34d399" : "#f87171"} fillOpacity={0.8} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
