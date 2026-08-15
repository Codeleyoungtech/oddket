"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useData, type Sport } from "../lib/data-provider";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/slips", label: "Slip Builder" },
  { href: "/calibration", label: "Calibration" },
  { href: "/bets", label: "Bet Log" },
  { href: "/backtest", label: "Backtest" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();
  const { mode, sport, setSport } = useData();

  return (
    <header className="sticky top-0 z-50 border-b border-ink-700/60 bg-ink-950/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="group flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15 font-mono text-sm font-bold text-emerald-400 ring-1 ring-emerald-400/30 transition-transform group-hover:scale-105">
            K
          </span>
          <span className="text-[15px] font-bold tracking-tight text-slate-100">
            Odd<span className="text-emerald-400">Ket</span>
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-ink-800 text-emerald-300"
                    : "text-slate-400 hover:bg-ink-800/60 hover:text-slate-200"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <SportSelector sport={sport} setSport={setSport} />
          <ModeBadge mode={mode} />
        </div>
      </div>

      {/* mobile nav */}
      <nav className="flex items-center gap-1 overflow-x-auto border-t border-ink-700/40 px-3 py-1.5 md:hidden">
        {LINKS.map((l) => {
          const active = pathname === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`whitespace-nowrap rounded-lg px-3 py-1 text-[13px] transition-colors ${
                active ? "bg-ink-800 text-emerald-300" : "text-slate-400"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}

function SportSelector({ sport, setSport }: { sport: Sport; setSport: (s: Sport) => void }) {
  return (
    <div className="flex rounded-lg border border-ink-600/60 bg-ink-800/40 p-0.5">
      {(
        [
          ["football", "⚽ Football"],
          ["tennis", "🎾 Tennis"],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          onClick={() => setSport(key)}
          className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            sport === key ? "bg-emerald-400 text-ink-950" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function ModeBadge({ mode }: { mode: "live" | "demo" | "loading" }) {
  if (mode === "loading") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-ink-600/60 px-2.5 py-1 text-[11px] font-medium text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-500 animate-pulse-dot" />
        connecting…
      </span>
    );
  }
  const live = mode === "live";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
        live
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
          : "border-sky-400/30 bg-sky-400/10 text-sky-300"
      }`}
      title={
        live
          ? "Reading live data from the Cloudflare Worker API"
          : "Demo mode — deterministic seed data, no backend required"
      }
    >
      <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-400 animate-pulse-dot" : "bg-sky-400"}`} />
      {live ? "LIVE" : "DEMO"}
    </span>
  );
}
