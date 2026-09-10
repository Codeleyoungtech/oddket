"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useData, type Sport } from "../lib/data-provider";

/** Primary tabs — kept to 5 so the mobile bottom bar stays thumb-friendly. */
const LINKS = [
  { href: "/", label: "Overview", icon: "home" },
  { href: "/slips", label: "Slips", icon: "ticket" },
  { href: "/corners", label: "Corners", icon: "corners" },
  { href: "/bets", label: "Bet Log", icon: "receipt" },
  { href: "/settings", label: "Settings", icon: "gear" },
] as const;

/** Secondary links — hidden behind the mobile "More" sheet, always visible
 *  in the desktop top bar. */
const MORE_LINKS = [
  { href: "/calibration", label: "Calibration", icon: "gauge", desc: "Brier score, calibration curve & CLV" },
  { href: "/backtest", label: "Backtest", icon: "flask", desc: "Historical replay of the EV engine" },
] as const;

/** Inline SVG icon set — small, crisp at 16–20px, no icon-font dependency. */
function Icon({ name, className = "h-[18px] w-[18px]" }: { name: string; className?: string }) {
  const common = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "home":
      return (
        <svg {...common}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V21h14V9.5" />
          <path d="M9.5 21v-6h5v6" />
        </svg>
      );
    case "ticket":
      return (
        <svg {...common}>
          <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2.5a2 2 0 0 0 0 3.9V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2.6a2 2 0 0 0 0-3.9V8Z" />
          <path d="M13.5 7v1.5M13.5 11.25v1.5M13.5 15.5V17" />
        </svg>
      );
    case "gauge":
      return (
        <svg {...common}>
          <path d="M12 20a8 8 0 1 1 8-8" />
          <path d="M12 12l4-3" />
          <circle cx="12" cy="12" r="1.4" />
        </svg>
      );
    case "receipt":
      return (
        <svg {...common}>
          <path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21V3Z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
      );
    case "flask":
      return (
        <svg {...common}>
          <path d="M9 3h6M10 3v6l-5.5 9A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3L14 9V3" />
          <path d="M7.5 15h9" />
        </svg>
      );
    case "gear":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2.5v3M12 18.5v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2.5 12h3M18.5 12h3M4.9 19.1 7 17M17 7l2.1-2.1" />
        </svg>
      );
    case "corners":
      return (
        <svg {...common}>
          <path d="M4 4h7v7H4z" />
          <path d="M13 4h7v7h-7z" />
          <path d="M4 13h7v7H4z" />
        </svg>
      );
    case "more":
      return (
        <svg {...common}>
          <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
        </svg>
      );
    default:
      return null;
  }
}

export function Nav() {
  const pathname = usePathname();
  const { mode, sport, setSport } = useData();

  return (
    <>
      {/* Top bar — slim on mobile, full on desktop */}
      <header className="sticky top-0 z-50 border-b border-ink-700/60 bg-ink-950/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link href="/" className="group flex shrink-0 items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/15 font-mono text-sm font-bold text-emerald-400 ring-1 ring-emerald-400/30 transition-transform group-hover:scale-105">
              K
            </span>
            <span className="text-[15px] font-bold tracking-tight text-slate-100">
              Odd<span className="text-emerald-400">Ket</span>
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-1 md:flex">
            {LINKS.map((l) => {
              const active = pathname === l.href;
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    active
                      ? "bg-ink-800 text-emerald-300"
                      : "text-slate-400 hover:bg-ink-800/60 hover:text-slate-200"
                  }`}
                >
                  <Icon name={l.icon} className="h-4 w-4" />
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
      </header>      {/* Mobile bottom tab bar — app-like, thumb-friendly, safe-area aware.
          Only 5 primary tabs; Calibration + Backtest live in the More sheet. */}
      <MobileTabBar pathname={pathname} />
    </>
  );
}

/** Mobile-only bottom bar: 5 primary tabs + a More sheet for the rest. */
function MobileTabBar({ pathname }: { pathname: string }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const activeInMore = MORE_LINKS.some((l) => pathname === l.href);

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-ink-700/60 bg-ink-950/95 backdrop-blur-md md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto grid max-w-md grid-cols-5">
          {LINKS.map((l) => {
            const active = pathname === l.href;
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`flex min-h-[56px] flex-col items-center justify-center gap-1 pb-1.5 pt-2 text-[10px] font-medium transition-colors ${
                  active ? "text-emerald-300" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                <span className={`relative flex h-7 w-9 items-center justify-center rounded-full transition-colors ${active ? "bg-emerald-400/10" : ""}`}>
                  <Icon name={l.icon} className={`h-[19px] w-[19px] ${active ? "text-emerald-300" : ""}`} />
                  {active && <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-emerald-400" />}
                </span>
                {l.label}
              </Link>
            );
          })}
          {/* More button */}
          <button
            onClick={() => setMoreOpen(true)}
            aria-label="More"
            className={`flex min-h-[56px] flex-col items-center justify-center gap-1 pb-1.5 pt-2 text-[10px] font-medium transition-colors ${
              activeInMore ? "text-emerald-300" : "text-slate-500 hover:text-slate-300"
            }`}
          >
            <span className={`relative flex h-7 w-9 items-center justify-center rounded-full transition-colors ${activeInMore ? "bg-emerald-400/10" : ""}`}>
              <Icon name="more" className={`h-[19px] w-[19px] ${activeInMore ? "text-emerald-300" : ""}`} />
              {activeInMore && <span className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-emerald-400" />}
            </span>
            More
          </button>
        </div>
      </nav>

      {/* More sheet */}
      {moreOpen && (
        <div className="fixed inset-0 z-[60] md:hidden" role="dialog" aria-modal="true">
          <button
            aria-label="Close"
            onClick={() => setMoreOpen(false)}
            className="absolute inset-0 h-full w-full bg-ink-950/70 backdrop-blur-sm"
          />
          <div
            className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-ink-700/60 bg-ink-950 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
            style={{ animation: "slide-up 160ms ease-out" }}
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-ink-700" />
            <p className="label mb-2 px-1">More</p>
            <div className="space-y-1">
              {MORE_LINKS.map((l) => {
                const active = pathname === l.href;
                return (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-3 transition-colors ${
                      active
                        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-300"
                        : "border-ink-700/50 bg-ink-900/50 text-slate-200 hover:border-ink-600"
                    }`}
                  >
                    <Icon name={l.icon} className="h-5 w-5 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">{l.label}</div>
                      <div className="truncate text-[11px] text-slate-500">{l.desc}</div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SportSelector({ sport, setSport }: { sport: Sport; setSport: (s: Sport) => void }) {
  return (
    <div className="flex rounded-lg border border-ink-600/60 bg-ink-800/40 p-0.5">
      {(
        [
          ["football", "⚽", "Football"],
          ["tennis", "🎾", "Tennis"],
        ] as const
      ).map(([key, emoji, label]) => (
        <button
          key={key}
          onClick={() => setSport(key)}
          aria-label={label}
          title={label}
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors sm:px-2.5 ${
            sport === key ? "bg-emerald-400 text-ink-950" : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <span className="text-[13px] leading-none">{emoji}</span>
          <span className="hidden sm:inline">{label}</span>
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
        <span className="hidden sm:inline">connecting…</span>
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
