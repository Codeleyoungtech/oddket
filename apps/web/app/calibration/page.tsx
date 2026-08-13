"use client";

import { useData } from "../../lib/data-provider";
import { CalibrationChart } from "../../components/charts";
import { Badge, Card, CardHeader, EmptyState, Loading, SectionTitle, StatCard } from "../../components/ui";
import { fmtPct } from "../../lib/format";

export default function CalibrationPage() {
  const { calibration } = useData();

  if (!calibration) return <Loading />;

  const brier = calibration.brier;
  const good = brier <= 0.25;
  const ok = brier <= 0.35;
  const verdict = good ? "calibrated" : ok ? "roughly calibrated" : "miscalibrated";
  const tone = good ? "green" : ok ? "amber" : "red";

  return (
    <div className="animate-fade-in space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-100">Calibration</h1>
        <p className="mt-1 text-sm text-slate-500">
          The honest check: when the model says 70%, does it actually win ~70% of the time?
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Brier score" value={brier.toFixed(4)} sub="lower is better (0 = perfect)" tone={good ? "positive" : ok ? "default" : "negative"} />
        <StatCard label="Sample size" value={calibration.sampleSize} sub="settled predictions" />
        <StatCard label="Verdict" value={verdict} sub="vs Brier 0.25 / 0.35 bands" tone={tone === "green" ? "positive" : tone === "red" ? "negative" : "default"} />
        <StatCard label="Bins populated" value={`${calibration.bins.filter((b) => b.count > 0).length}/10`} sub="coverage across probability range" />
      </div>

      <Card>
        <CardHeader
          title="Calibration curve"
          subtitle="Blue dots = actual hit rate per bin (with Wilson confidence intervals in the tooltip). Green dashed = the model's own claim. Gray = perfect calibration."
          right={<Badge tone={tone}>{verdict}</Badge>}
        />
        {calibration.sampleSize > 0 ? (
          <CalibrationChart bins={calibration.bins} />
        ) : (
          <EmptyState title="No settled predictions yet" body="Once fixtures settle, the model's honesty is laid bare here." />
        )}
      </Card>

      <div>
        <SectionTitle sub="Every bin, raw">Per-bin detail</SectionTitle>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-ink-700/60 text-[11px] uppercase tracking-widest text-slate-500">
                  <th className="px-4 py-3 font-semibold">Probability bin</th>
                  <th className="px-4 py-3 text-right font-semibold">Count</th>
                  <th className="px-4 py-3 text-right font-semibold">Predicted</th>
                  <th className="px-4 py-3 text-right font-semibold">Actual</th>
                  <th className="px-4 py-3 text-right font-semibold">Wilson CI</th>
                  <th className="px-4 py-3 text-right font-semibold">Gap</th>
                </tr>
              </thead>
              <tbody>
                {calibration.bins.map((b) => {
                  const gap = b.count > 0 ? b.actual - b.predicted : 0;
                  return (
                    <tr key={b.bin} className="border-b border-ink-700/40 transition-colors last:border-0 hover:bg-ink-800/40">
                      <td className="num px-4 py-3 text-slate-300">{b.bin.toFixed(1)}</td>
                      <td className="num px-4 py-3 text-right text-slate-300">{b.count}</td>
                      <td className="num px-4 py-3 text-right text-slate-400">{b.count > 0 ? fmtPct(b.predicted, 0) : "—"}</td>
                      <td className={`num px-4 py-3 text-right font-medium ${b.count > 0 ? (gap >= -0.1 && gap <= 0.1 ? "text-emerald-400" : "text-amber-300") : "text-slate-600"}`}>
                        {b.count > 0 ? fmtPct(b.actual, 0) : "—"}
                      </td>
                      <td className="num px-4 py-3 text-right text-slate-500">
                        {b.count > 0 ? `${b.low.toFixed(2)}–${b.high.toFixed(2)}` : "—"}
                      </td>
                      <td className={`num px-4 py-3 text-right ${b.count > 0 ? (gap >= -0.1 && gap <= 0.1 ? "text-slate-400" : "text-amber-300") : "text-slate-600"}`}>
                        {b.count > 0 ? `${gap > 0 ? "+" : ""}${fmtPct(gap, 0)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
