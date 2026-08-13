import React from "react";

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>;
}

export function CardHeader({ title, subtitle, right }: { title: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "default" | "positive" | "negative" | "accent";
}) {
  const toneClass =
    tone === "positive" ? "text-emerald-400" : tone === "negative" ? "text-red-400" : tone === "accent" ? "text-sky-300" : "text-slate-100";
  return (
    <div className="card card-pad group relative overflow-hidden transition-transform duration-150 hover:-translate-y-0.5">
      <p className="label">{label}</p>
      <p className={`num mt-2 text-2xl font-bold leading-none tracking-tight ${toneClass}`}>{value}</p>
      {sub ? <p className="mt-2 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

export function Badge({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "green" | "red" | "sky" | "amber" }) {
  const tones: Record<string, string> = {
    slate: "border-ink-600/60 bg-ink-800/60 text-slate-400",
    green: "border-emerald-400/30 bg-emerald-400/10 text-emerald-300",
    red: "border-red-400/30 bg-red-400/10 text-red-300",
    sky: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    amber: "border-amber-400/30 bg-amber-400/10 text-amber-300",
  };
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function EmptyState({ title, body }: { title: string; body?: string }) {
  return (
    <div className="card card-pad flex flex-col items-center justify-center gap-1 py-12 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      {body ? <p className="max-w-sm text-xs text-slate-500">{body}</p> : null}
    </div>
  );
}

export function SectionTitle({ children, sub }: { children: React.ReactNode; sub?: string }) {
  return (
    <div className="mb-4">
      <h2 className="text-lg font-bold tracking-tight text-slate-100">{children}</h2>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

export function Loading() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-600 border-t-emerald-400" />
      <p className="text-xs text-slate-500">Loading OddKet…</p>
    </div>
  );
}
