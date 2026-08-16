export function fmtMoney(x: number | undefined | null, digits = 2): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return x.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtPct(x: number | undefined | null, digits = 1): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function fmtSignedPct(x: number | undefined | null, digits = 1): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  const v = x * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

export function fmtOdds(x: number | undefined | null): string {
  if (x === undefined || x === null || Number.isNaN(x)) return "—";
  return x.toFixed(2);
}

export function fmtDate(epochSec: number | undefined | null): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleString("en-GB", {
    weekday: "short", // Sun, Mon, … — instant day-of-week at a glance
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtDateShort(epochSec: number | undefined | null): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

export function pnlClass(x: number | undefined | null): string {
  if (x === undefined || x === null) return "text-slate-400";
  if (x > 0) return "text-emerald-400";
  if (x < 0) return "text-red-400";
  return "text-slate-400";
}

export function clvClass(x: number | undefined | null): string {
  if (x === undefined || x === null) return "text-slate-400";
  if (x > 0) return "text-emerald-400";
  if (x < 0) return "text-red-400";
  return "text-slate-400";
}

export function edgeClass(x: number | undefined | null): string {
  if (x === undefined || x === null) return "text-slate-400";
  if (x > 0) return "text-emerald-400";
  return "text-slate-400";
}
