"use client";

import { useEffect, useRef, useState } from "react";
import { apiBase, type SettlementEvent } from "../lib/api";
import { fmtMoney } from "../lib/format";

/**
 * Settlement alerts — in-app layer.
 *
 * Polls the worker for recent settlement events (last 48h) every 60s. Events
 * not yet seen on THIS device are shown as a dismissible banner; events that
 * settle while the app is open additionally fire a browser Notification when
 * alerts are enabled (see Settings → Settlement alerts). The web-push layer
 * (public/sw.js) covers the app-closed case.
 *
 * Silent in demo mode (worker unreachable) — never breaks the page.
 */

const SEEN_KEY = "oddket:seen-settlements";
const ALERTS_KEY = "oddket:alerts";
const POLL_MS = 60_000;
const SHOW_MAX = 4;

function loadSeen(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]");
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function saveSeen(list: string[]) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list.slice(-200)));
  } catch {
    /* private mode — banner just reappears next load */
  }
}

function alertsEnabled(): boolean {
  try {
    return localStorage.getItem(ALERTS_KEY) === "on";
  } catch {
    return false;
  }
}

function fmtAmount(amount: number): string {
  const sign = amount >= 0 ? "+" : "−";
  return `${sign}₦${fmtMoney(Math.abs(amount), 0)}`;
}

export function SettlementBanner() {
  const [events, setEvents] = useState<SettlementEvent[]>([]);
  const lastPollAt = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch(`${apiBase()}/api/settlements/recent?hours=48`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { events?: SettlementEvent[] };
        if (cancelled || !Array.isArray(data.events)) return;

        const nowMs = Date.now();

        // Fresh settlements since the last poll → notify while the app is open.
        if (lastPollAt.current > 0 && alertsEnabled() && "Notification" in window && Notification.permission === "granted") {
          for (const e of data.events) {
            if (e.settledAt * 1000 > lastPollAt.current) {
              try {
                new Notification("OddKet — bet settled", {
                  body: `${e.result === "won" ? "Won" : "Lost"} — ${e.label} (${fmtAmount(e.amount)})`,
                  icon: "/icons/icon-192.png",
                });
              } catch {
                /* iOS Safari can throw on constructor edge cases — ignore */
              }
            }
          }
        }
        lastPollAt.current = nowMs;

        const seen = new Set(loadSeen());
        const unseen = data.events.filter((e) => !seen.has(e.id)).slice(0, SHOW_MAX);
        setEvents(unseen);
      } catch {
        /* worker unreachable (demo mode) — silent */
      }
    }

    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (events.length === 0) return null;

  const dismiss = () => {
    saveSeen([...loadSeen(), ...events.map((e) => e.id)]);
    setEvents([]);
  };

  const net = events.reduce((s, e) => s + e.amount, 0);
  const won = events.filter((e) => e.result === "won").length;

  return (
    <div className="animate-fade-in mb-4 overflow-hidden rounded-xl border border-ink-700/60 bg-ink-800/60">
      <div className="flex items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-200">
            {events.length === 1 ? (
              <>
                <span className={events[0]!.result === "won" ? "text-emerald-300" : "text-red-400"}>
                  {events[0]!.result === "won" ? "Won" : "Lost"}
                </span>
                {" — "}
                {events[0]!.label}
                <span className={`ml-2 num ${events[0]!.result === "won" ? "text-emerald-300" : "text-red-400"}`}>
                  {fmtAmount(events[0]!.amount)}
                </span>
              </>
            ) : (
              <>
                {events.length} bets settled · <span className="text-emerald-300">{won} won</span> ·{" "}
                <span className={net >= 0 ? "text-emerald-300" : "text-red-400"}>{fmtAmount(net)} net</span>
              </>
            )}
          </p>
          {events.length > 1 && (
            <ul className="mt-1.5 space-y-0.5">
              {events.slice(0, 3).map((e) => (
                <li key={e.id} className="truncate text-xs text-slate-400">
                  <span className={e.result === "won" ? "text-emerald-300" : "text-red-400"}>
                    {e.result === "won" ? "Won" : "Lost"}
                  </span>
                  {" · "}
                  {e.label}
                  <span className={`ml-1 num ${e.result === "won" ? "text-emerald-300" : "text-red-400"}`}>{fmtAmount(e.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-slate-500">See the full log under Bets →</p>
        </div>
        <button
          onClick={dismiss}
          aria-label="Dismiss settlement alerts"
          className="shrink-0 rounded-md p-1 text-slate-500 transition-colors hover:bg-ink-700/50 hover:text-slate-200"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
