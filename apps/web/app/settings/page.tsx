"use client";

import React, { useEffect, useState } from "react";
import { TENNIS_SPORTS, type Settings } from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { Badge, Card, CardHeader, Loading, SectionTitle } from "../../components/ui";
import { InstallApp } from "../../components/install-app";
import { fmtMoney, fmtPct } from "../../lib/format";

const MARKET_OPTIONS = [
  { value: "h2h", label: "Match result (1X2)" },
  { value: "totals", label: "Over/Under 2.5" },
  { value: "btts", label: "Both teams to score" },
] as const;

// Must match the seed LEAGUES names in packages/core/src/seed.ts and the
// LEAGUE_SPORTS map in packages/core/src/types.ts.
const LEAGUE_OPTIONS = [
  { value: "English Premier League", label: "English Premier League" },
  { value: "La Liga", label: "La Liga" },
  { value: "Bundesliga", label: "Bundesliga" },
  { value: "Serie A", label: "Serie A" },
] as const;

// Tennis tournaments come from the same TENNIS_SPORTS map the worker ingest
// uses. Toggling these writes tournament names into the same `leagues` array
// as the football leagues — the two maps (LEAGUE_SPORTS / TENNIS_SPORTS) are
// disjoint, so they coexist without collision.
const TENNIS_OPTIONS = Object.entries(TENNIS_SPORTS).map(([name]) => ({
  value: name,
  label: name,
}));

export default function SettingsPage() {
  const { db, saveSettings, mode } = useData();
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (db && !form) setForm(db.settings);
  }, [db, form]);

  if (!db || !form) return <Loading />;

  const update = (patch: Partial<Settings>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setSaved(false);
  };

  const toggleMarket = (m: (typeof MARKET_OPTIONS)[number]["value"]) => {
    setForm((f) => {
      if (!f) return f;
      const has = f.markets.includes(m);
      const markets = has ? f.markets.filter((x) => x !== m) : [...f.markets, m];
      return { ...f, markets };
    });
    setSaved(false);
  };

  const toggleLeague = (name: (typeof LEAGUE_OPTIONS)[number]["value"]) => {
    setForm((f) => {
      if (!f) return f;
      const has = f.leagues.includes(name);
      const leagues = has ? f.leagues.filter((x) => x !== name) : [...f.leagues, name];
      return { ...f, leagues };
    });
    setSaved(false);
  };

  const toggleTennis = (name: string) => {
    setForm((f) => {
      if (!f) return f;
      const has = f.leagues.includes(name);
      const leagues = has ? f.leagues.filter((x) => x !== name) : [...f.leagues, name];
      return { ...f, leagues };
    });
    setSaved(false);
  };

  const onSave = async () => {
    await saveSettings(form);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const kellyExposure = form.bankroll * form.kellyFraction * 0.25; // rough max single stake before cap

  return (
    <div className="animate-fade-in mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">Settings</h1>
          <p className="mt-1 text-sm text-slate-500">Bankroll discipline is built in, not optional.</p>
        </div>
        {saved && <Badge tone="green">saved</Badge>}
      </div>

      <Card className="card-pad">
        <CardHeader title="Bankroll & staking" subtitle="These feed every Kelly stake suggestion in the slip builder." />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label mb-1.5 block">Starting bankroll (₦)</span>
            <input
              className="input num"
              type="number"
              min={0}
              step={100}
              value={form.bankroll}
              onChange={(e) => update({ bankroll: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="block">
            <span className="label mb-1.5 block">Kelly fraction ({fmtPct(form.kellyFraction, 0)} × full Kelly)</span>
            <input
              className="input"
              type="range"
              min={0.05}
              max={1}
              step={0.05}
              value={form.kellyFraction}
              onChange={(e) => update({ kellyFraction: Number(e.target.value) })}
            />
            <span className="mt-1 block text-xs text-slate-500">
              Quarter Kelly (0.25) is the PRD default — full Kelly over-bets on noisy probabilities.
            </span>
          </label>
          <label className="block">
            <span className="label mb-1.5 block">Minimum edge to flag a slip ({fmtPct(form.edgeThreshold, 0)})</span>
            <input
              className="input"
              type="range"
              min={0.01}
              max={0.1}
              step={0.005}
              value={form.edgeThreshold}
              onChange={(e) => update({ edgeThreshold: Number(e.target.value) })}
            />
            <span className="mt-1 block text-xs text-slate-500">Below this, the edge is noise. Higher = fewer, cleaner picks.</span>
          </label>
          <label className="block">
            <span className="label mb-1.5 block">Single-bet cap ({fmtPct(form.defaultStakeCapPct, 0)} of bankroll)</span>
            <input
              className="input"
              type="range"
              min={0.01}
              max={0.1}
              step={0.005}
              value={form.defaultStakeCapPct}
              onChange={(e) => update({ defaultStakeCapPct: Number(e.target.value) })}
            />
            <span className="mt-1 block text-xs text-slate-500">Hard ceiling on any one stake ≈ ₦{fmtMoney(form.bankroll * form.defaultStakeCapPct, 0)}.</span>
          </label>
        </div>
        <div className="mt-4 rounded-lg border border-ink-700/60 bg-ink-800/40 px-4 py-3 text-xs text-slate-400">
          At current settings a typical flagged single stakes up to{" "}
          <span className="num font-semibold text-emerald-300">₦{fmtMoney(Math.min(kellyExposure, form.bankroll * form.defaultStakeCapPct), 0)}</span>.
        </div>
      </Card>

      <Card className="card-pad">
        <CardHeader title="Stop-losses" subtitle="Enforced at the UI level. OddKet never chases losses." />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="label mb-1.5 block">Daily stop-loss (₦)</span>
            <input
              className="input num"
              type="number"
              min={0}
              step={50}
              value={form.dailyStopLoss}
              onChange={(e) => update({ dailyStopLoss: Number(e.target.value) || 0 })}
            />
          </label>
          <label className="block">
            <span className="label mb-1.5 block">Weekly stop-loss (₦)</span>
            <input
              className="input num"
              type="number"
              min={0}
              step={100}
              value={form.weeklyStopLoss}
              onChange={(e) => update({ weeklyStopLoss: Number(e.target.value) || 0 })}
            />
          </label>
        </div>
        <p className="mt-3 text-xs text-slate-500">0 disables the cap — not recommended.</p>
      </Card>

      <Card className="card-pad">
        <CardHeader
          title="Leagues in play"
          subtitle="Which leagues the live pulls cover (one API credit per league). The model is trained on these four — teams outside them are skipped honestly."
        />
        <div className="flex flex-wrap gap-2">
          {LEAGUE_OPTIONS.map((l) => {
            const on = form.leagues.includes(l.value);
            return (
              <button
                key={l.value}
                onClick={() => toggleLeague(l.value)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  on
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                    : "border-ink-600/60 text-slate-400 hover:text-slate-200"
                }`}
              >
                {l.label}
                <span className={`ml-2 text-[11px] ${on ? "text-emerald-400/70" : "text-slate-600"}`}>{on ? "on" : "off"}</span>
              </button>
            );
          })}
        </div>
      </Card>      <Card className="card-pad">
        <CardHeader
          title="Tennis tournaments"
          subtitle="Which ATP main-tour events the live pulls cover. Off-season tournaments cost 0 API credits; only in-season ones burn budget. The model is trained on Grand Slams + Masters + 500s."
        />
        <div className="flex flex-wrap gap-2">
          {TENNIS_OPTIONS.map((t) => {
            const on = form.leagues.includes(t.value);
            return (
              <button
                key={t.value}
                onClick={() => toggleTennis(t.value)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  on
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                    : "border-ink-600/60 text-slate-400 hover:text-slate-200"
                }`}
              >
                {t.label.replace("ATP ", "")}
                <span className={`ml-2 text-[11px] ${on ? "text-emerald-400/70" : "text-slate-600"}`}>{on ? "on" : "off"}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Toggling a tournament on/off here takes effect on the next odds pull — no redeploy needed.
        </p>
      </Card>

      <Card className="card-pad">
        <CardHeader title="App" subtitle="Install OddKet for a standalone app experience on your phone or desktop." />
        <InstallApp />
      </Card>

      <Card className="card-pad">
        <CardHeader
          title="Multiples (parlays)"
          subtitle="The multiple builder exists in code but stays OFF until the singles have proven their edge. This is the gate."
        />
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <p className="font-medium text-slate-200">Enable multiple builder</p>
            <p className="mt-1 max-w-lg text-xs leading-relaxed text-slate-500">
              Multiples are <span className="font-semibold text-amber-300">not</span> lower-risk than singles — they raise
              variance by construction. Flip this on only after a sport has cleared the validation checklist: 100+ logged
              bets, positive real CLV vs. closing line, and the 95% CI not straddling zero. Max 3 legs, and every leg must
              clear the single-bet EV threshold on its own.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={form.multiplesEnabled}
            onClick={() => update({ multiplesEnabled: !form.multiplesEnabled })}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors ${
              form.multiplesEnabled ? "bg-emerald-400" : "bg-ink-600/60"
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-slate-100 transition-transform ${
                form.multiplesEnabled ? "translate-x-[22px]" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          {form.multiplesEnabled
            ? "ON — the slip builder will offer multiples. Remember: variance is higher, not lower."
            : "OFF (default) — the slip builder shows singles only until you prove the edge."}
        </p>
        <div className="mt-4 flex items-center justify-between gap-4 border-t border-ink-700/40 pt-4">
          <div>
            <p className="label mb-1 block">Max legs per multiple ({form.maxMultipleLegs})</p>
            <p className="max-w-md text-xs leading-relaxed text-slate-500">
              Default 3. More legs multiply the payout when it hits — but they also multiply variance and shrink the hit
              rate, and model calibration error compounds with each leg. Raising this rarely helps ROI; it mostly adds
              longshot risk.
            </p>
          </div>
          <input
            className="input w-24"
            type="range"
            min={2}
            max={6}
            step={1}
            value={form.maxMultipleLegs}
            onChange={(e) => update({ maxMultipleLegs: Number(e.target.value) })}
          />
        </div>
      </Card>

      <Card className="card-pad">
        <CardHeader
          title="Markets in play"
          subtitle="Which markets the EV engine scans. More markets = more API budget on live pulls."
        />
        <div className="flex flex-wrap gap-2">
          {MARKET_OPTIONS.map((m) => {
            const on = form.markets.includes(m.value);
            return (
              <button
                key={m.value}
                onClick={() => toggleMarket(m.value)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  on
                    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                    : "border-ink-600/60 text-slate-400 hover:text-slate-200"
                }`}
              >
                {m.label}
                <span className={`ml-2 text-[11px] ${on ? "text-emerald-400/70" : "text-slate-600"}`}>{on ? "on" : "off"}</span>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <button className="btn-primary" onClick={onSave}>
          {mode === "live" ? "Save to worker" : "Save (demo — local only)"}
        </button>
        <p className="text-xs text-slate-600">
          Demo mode persists only for this session; LIVE mode writes to D1 via <span className="num">PUT /api/settings</span>.
        </p>
      </div>
    </div>
  );
}
