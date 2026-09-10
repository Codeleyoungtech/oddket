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

/* ---------------- skeleton loaders (pulsing placeholders) ---------------- */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-ink-800/70 ${className}`} />;
}

/** Page shell: title block + whatever page-specific skeleton you pass. */
export function PageSkeleton({ children }: { children?: React.ReactNode }) {
  return (
    <div className="animate-fade-in space-y-6">
      <div className="space-y-2.5">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {children}
    </div>
  );
}

export function SkeletonStatGrid({ cols = 6 }: { cols?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className="card card-pad">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-3 h-7 w-24" />
          <Skeleton className="mt-2 h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 4, title = true }: { lines?: number; title?: boolean }) {
  return (
    <div className="card card-pad space-y-3">
      {title && <Skeleton className="h-4 w-1/3" />}
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? "w-2/3" : "w-full"}`} />
      ))}
    </div>
  );
}

export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-800/80 bg-ink-800/40 px-4 py-3">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-28" />
          </div>
          <div className="space-y-3 p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}
