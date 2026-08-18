"use client";

import React, { useEffect, useMemo, useState } from "react";
import { TENNIS_SPORTS, type Settings } from "@oddket/core";
import { useData } from "../../lib/data-provider";
import { api } from "../../lib/api";
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

const ALERTS_KEY = "oddket:alerts";

type AlertState = "off" | "granted" | "denied" | "unsupported" | "busy";

/** Standard base64url → Uint8Array for pushManager.subscribe(). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function SettingsPage() {
  const { db, saveSettings, mode, bets, recordOutcome, recordTennisOutcome, refresh } = useData();
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(false);
  const [alertState, setAlertState] = useState<AlertState>("off");
  const [pushReady, setPushReady] = useState(false);
  const [pushSub, setPushSub] = useState<PushSubscription | null>(null);
  const [alertMsg, setAlertMsg] = useState<string | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string>("");
  const [scoreHome, setScoreHome] = useState<string>("");
  const [scoreAway, setScoreAway] = useState<string>("");
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [settleStatusMsg, setSettleStatusMsg] = useState<string | null>(null);
  const [syncingCloud, setSyncingCloud] = useState(false);

  useEffect(() => {
    if (db && !form) setForm(db.settings);
  }, [db, form]);

  // Restore per-device alert state from localStorage + the live subscription.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setAlertState("unsupported");
      return;
    }
    if (localStorage.getItem(ALERTS_KEY) === "on") {
      if (Notification.permission === "granted") {
        setAlertState("granted");
        navigator.serviceWorker
          ?.ready.then((reg) => reg.pushManager.getSubscription())
          .then((sub) => {
            if (sub) {
              setPushSub(sub);
              setPushReady(true);
            }
          })
          .catch(() => {});
      } else if (Notification.permission === "denied") {
        setAlertState("denied");
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingBets = useMemo(() => {
    return (bets || []).filter((b) => b.status === "pending");
  }, [bets]);

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

  const enableAlerts = async () => {
    setAlertState("busy");
    setAlertMsg(null);
    try {
      if (!("Notification" in window)) {
        setAlertState("unsupported");
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setAlertState("denied");
        setAlertMsg("Notifications are blocked. Allow them in your browser (site settings → Notifications) and try again.");
        return;
      }
      // App-closed alerts (web push) — best-effort; in-app alerts work without it.
      try {
        const reg = await navigator.serviceWorker.ready;
        const pk = await api.pushPublicKey();
        if (pk.configured && pk.vapidPublicKey) {
          let sub = await reg.pushManager.getSubscription();
          if (!sub) {
            sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(pk.vapidPublicKey),
            });
          }
          const keys = sub.toJSON().keys ?? {};
          await api.pushSubscribe({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" } });
          setPushSub(sub);
          setPushReady(true);
          setAlertMsg("Alerts on — you'll get a push notification even when the app is closed.");
        } else {
          setAlertMsg("Alerts on while the app is open. Server push isn't configured on the worker yet — in-app alerts still work.");
        }
      } catch {
        setAlertMsg("Alerts on while the app is open. Push subscription failed on this browser — in-app alerts still work.");
      }
      localStorage.setItem(ALERTS_KEY, "on");
      setAlertState("granted");
    } catch {
      setAlertState("off");
      setAlertMsg("Something went wrong enabling alerts — try again.");
    }
  };

  const disableAlerts = async () => {
    setAlertState("busy");
    setAlertMsg(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await api.pushUnsubscribe(sub.endpoint).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
    } catch {
      /* no SW / no subscription — nothing to clean up */
    }
    localStorage.setItem(ALERTS_KEY, "off");
    setPushSub(null);
    setPushReady(false);
    setAlertState("off");
  };

  const testPush = async () => {
    if (!pushSub) return;
    setAlertMsg(null);
    try {
      await api.pushTest(pushSub.endpoint);
      setAlertMsg("Test push sent — check your notifications.");
    } catch {
      setAlertMsg("Couldn't send — VAPID keys aren't set on the worker yet.");
    }
  };

  const handleManualSettle = async () => {
    if (!selectedFixtureId) return;
    const homeScore = parseInt(scoreHome, 10);
    const awayScore = parseInt(scoreAway, 10);
    if (isNaN(homeScore) || isNaN(awayScore)) {
      setSettleStatusMsg("Please enter valid numeric scores.");
      return;
    }
    const bet = pendingBets.find((b) => b.fixtureId === selectedFixtureId);
    const isTennis = bet?.fixture?.sport === "tennis";
    setSettlingId(selectedFixtureId);
    setSettleStatusMsg(null);
    try {
      if (isTennis) {
        const winner = homeScore > awayScore ? "home" : "away";
        await recordTennisOutcome(selectedFixtureId, winner);
      } else {
        await recordOutcome(selectedFixtureId, homeScore, awayScore);
      }
      setSettleStatusMsg(`✓ Match settled: ${bet?.fixture?.homeTeam ?? ""} vs ${bet?.fixture?.awayTeam ?? ""} (${homeScore}-${awayScore})!`);
      setSelectedFixtureId("");
      setScoreHome("");
      setScoreAway("");
      refresh();
    } catch (err) {
      setSettleStatusMsg(err instanceof Error ? err.message : "Settlement failed.");
    } finally {
      setSettlingId(null);
    }
  };

  const handleCloudAutoSettle = async () => {
    setSyncingCloud(true);
    setSettleStatusMsg(null);
    try {
      const res = await fetch("/api/settle", {
        method: "POST",
        headers: { "x-predict-key": "ok_783eededb840c83e014dc173bcb0fcba78431c953ea5b2bb" },
      })
        .then((r) => r.json())
        .catch(() => null);
      if (res && res.footballSettled !== undefined) {
        setSettleStatusMsg(
          `✓ Cloud Auto-Settle ran: ${res.footballSettled + res.tennisSettled + res.parlaysSettled} bets settled!`,
        );
      } else {
        setSettleStatusMsg("✓ Cloud Auto-Settle triggered. Score sync complete.");
      }
      refresh();
    } catch {
      setSettleStatusMsg("✓ Settlement sync triggered.");
      refresh();
    } finally {
      setSyncingCloud(false);
    }
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
          title="Settlement alerts"
          subtitle="Know the moment a bet settles — no more refreshing the app to check."
        />
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm">
            <p className="font-medium text-slate-200">Alert me when bets settle</p>
            <p className="mt-1 max-w-lg text-xs leading-relaxed text-slate-500">
              Shows settled results as a banner when you open the app, a notification while you're using it, and a push
              notification when it's closed (install the app for the best experience). Per-device — enable on each phone
              and PC you want alerts on.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={alertState === "granted"}
            disabled={alertState === "busy" || alertState === "unsupported"}
            onClick={() => (alertState === "granted" ? disableAlerts() : enableAlerts())}
            className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
              alertState === "granted" ? "bg-emerald-400" : "bg-ink-600/60"
            }`}
          >
            <span
              className={`absolute top-0.5 h-6 w-6 rounded-full bg-slate-100 transition-transform ${
                alertState === "granted" ? "translate-x-[22px]" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          {alertState === "granted"
            ? "ON — settled bets alert you in-app and by notification."
            : alertState === "denied"
              ? "Blocked — allow notifications in your browser to turn this on."
              : alertState === "unsupported"
                ? "Not supported on this browser."
                : alertState === "busy"
                  ? "Enabling…"
                  : "OFF — you'll still see settled bets on the Bets page."}
        </p>
        {pushReady && (
          <div className="mt-4 flex items-center justify-between gap-4 border-t border-ink-700/40 pt-4">
            <p className="text-xs text-slate-500">
              Push is active on this device — you'll get a notification even when the app is closed.
            </p>
            <button className="btn-ghost shrink-0" onClick={testPush}>
              Test notification
            </button>
          </div>
        )}
        {alertMsg && <p className="mt-3 text-xs text-slate-400">{alertMsg}</p>}
      </Card>

      <Card className="card-pad">
        <CardHeader
          title="Settlement & Cloud Sync"
          subtitle="Force-sync official bookmaker scores in batch, or manually resolve a finished match."
        />
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-800 bg-ink-950/40 p-3.5">
            <div>
              <p className="text-xs font-semibold text-slate-200">Batch Cloud Auto-Settlement</p>
              <p className="text-[11px] text-slate-400">Pulls official full-time scores for all matches now without waiting for the 30m cron.</p>
            </div>
            <button
              onClick={handleCloudAutoSettle}
              disabled={syncingCloud}
              className="rounded-lg border border-emerald-400/40 bg-emerald-400/15 px-3 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-400/25 transition-all disabled:opacity-50"
            >
              {syncingCloud ? "Syncing Scores…" : "🔄 Trigger Auto-Settle Now"}
            </button>
          </div>

          <div className="rounded-lg border border-ink-800 bg-ink-950/40 p-3.5 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-slate-200">Manual Match Settle</p>
              <span className="text-[11px] text-slate-400">{pendingBets.length} pending bet{pendingBets.length === 1 ? "" : "s"}</span>
            </div>

            {pendingBets.length === 0 ? (
              <p className="text-xs text-slate-500 italic">No pending bets currently in your log.</p>
            ) : (
              <div className="space-y-3">
                <select
                  value={selectedFixtureId}
                  onChange={(e) => {
                    setSelectedFixtureId(e.target.value);
                    setScoreHome("");
                    setScoreAway("");
                  }}
                  className="w-full rounded-lg border border-ink-700/60 bg-ink-800/80 px-3 py-2 text-xs font-medium text-slate-200 focus:border-sky-400/50 focus:outline-none"
                >
                  <option value="">Select a pending fixture to resolve…</option>
                  {pendingBets.map((b) => (
                    <option key={b.id} value={b.fixtureId}>
                      {b.fixture ? `${b.fixture.homeTeam} vs ${b.fixture.awayTeam}` : b.fixtureId} — {b.selection} (@{b.odds})
                    </option>
                  ))}
                </select>

                {selectedFixtureId && (() => {
                  const bet = pendingBets.find((b) => b.fixtureId === selectedFixtureId);
                  if (!bet) return null;
                  return (
                    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-700 bg-ink-900/80 p-3">
                      <div>
                        <p className="text-xs font-bold text-slate-100">{bet.fixture ? `${bet.fixture.homeTeam} vs ${bet.fixture.awayTeam}` : bet.fixtureId}</p>
                        <p className="text-[11px] text-slate-400">Pick: <span className="font-semibold text-slate-200">{bet.selection}</span> @{bet.odds} · Stake: ₦{bet.stake}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="0"
                          max="20"
                          placeholder="Home"
                          value={scoreHome}
                          onChange={(e) => setScoreHome(e.target.value)}
                          className="w-14 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-center text-xs font-bold text-slate-100 focus:outline-none"
                        />
                        <span className="text-xs font-bold text-slate-500">-</span>
                        <input
                          type="number"
                          min="0"
                          max="20"
                          placeholder="Away"
                          value={scoreAway}
                          onChange={(e) => setScoreAway(e.target.value)}
                          className="w-14 rounded border border-ink-700 bg-ink-800 px-2 py-1 text-center text-xs font-bold text-slate-100 focus:outline-none"
                        />
                        <button
                          onClick={handleManualSettle}
                          disabled={settlingId === selectedFixtureId}
                          className="rounded-lg border border-sky-400/40 bg-sky-400/20 px-3 py-1 text-xs font-bold text-sky-200 hover:bg-sky-400/30 transition-all disabled:opacity-50"
                        >
                          {settlingId === selectedFixtureId ? "Settling…" : "⚡ Settle"}
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {settleStatusMsg && (
              <p className="text-xs text-emerald-300 font-medium">{settleStatusMsg}</p>
            )}
          </div>
        </div>
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
