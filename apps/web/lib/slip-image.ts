"use client";

import { marketLabel, type SlipLeg } from "@oddket/core";

/**
 * Render an OddKet slip as a PNG image (client-side, zero deps).
 * Draws a dark card matching the app theme: header, one row per leg,
 * then the combined-odds / true-probability footer. Returns a data URL
 * ready for <img src> / download / Telegram upload.
 */

export interface SlipImageInput {
  legs: SlipLeg[];
  /** display stakes keyed by legKey ("fixtureId:market:selection") */
  stakes: Record<string, number>;
  combinedOdds: number | null;
  combinedProbability: number | null;
  combinedFairOdds: number | null;
}

const W = 1080;
const PAD = 56;
const ROW_GAP = 34;
const LABEL_H = 30;

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderSlipImage(input: SlipImageInput): Promise<string> {
  const { legs, stakes, combinedOdds, combinedProbability, combinedFairOdds } = input;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D not available in this browser.");

  // --- layout pass: measure every row's height first ---
  const fontTitle = `800 44px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const fontSub = `500 26px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const fontMatch = `700 30px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const fontPick = `500 27px ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const fontNum = `700 28px ui-sans-serif, system-ui, -apple-system, sans-serif`;

  ctx.font = fontMatch;
  const rowHeights = legs.map((l) => {
    const fixture = `${l.fixture.homeTeam} vs ${l.fixture.awayTeam}`;
    const pick = `${marketLabel(l.market, l.selection)}  @  ${l.odds.toFixed(2)}  ·  stake ₦${stakes[`${l.fixture.id}:${l.market}:${l.selection}`] ?? 0}`;
    const lines = wrapText(ctx, fixture, W - PAD * 2);
    ctx.font = fontPick;
    const pickLines = wrapText(ctx, pick, W - PAD * 2);
    ctx.font = fontMatch;
    return LABEL_H + lines.length * 38 + 14 + pickLines.length * 34;
  });

  const headerH = 150;
  const footerH = combinedOdds ? 230 : 80;
  const contentH = rowHeights.reduce((a, b) => a + b + ROW_GAP, 0);
  const H = headerH + contentH + footerH + PAD * 2;

  canvas.width = W;
  canvas.height = H;

  // --- background ---
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#0b0f16");
  bg.addColorStop(1, "#070a0f");
  ctx.fillStyle = bg;
  roundRect(ctx, 0, 0, W, H, 28);
  ctx.fill();

  // --- header ---
  ctx.fillStyle = "#10b981";
  ctx.font = fontTitle;
  ctx.fillText("ODDKET SLIP", PAD, PAD + 58);
  ctx.fillStyle = "#64748b";
  ctx.font = fontSub;
  const when = new Date().toLocaleString("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  ctx.fillText(
    `${legs.length} leg${legs.length > 1 ? "s" : ""} · ${when} · decision support, not auto-betting`,
    PAD,
    PAD + 100,
  );

  // --- legs ---
  let y = PAD + headerH;
  ctx.font = fontMatch;
  legs.forEach((l, i) => {
    // divider
    ctx.strokeStyle = "rgba(148,163,184,0.14)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(PAD, y - ROW_GAP / 2);
    ctx.lineTo(W - PAD, y - ROW_GAP / 2);
    ctx.stroke();

    // index chip
    ctx.fillStyle = "#1e293b";
    roundRect(ctx, PAD, y - 2, 56, 50, 12);
    ctx.fill();
    ctx.fillStyle = "#10b981";
    ctx.font = `800 26px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(String(i + 1), PAD + 17, y + 33);

    // fixture + pick
    const fxLines = wrapText(ctx, `${l.fixture.homeTeam} vs ${l.fixture.awayTeam}`, W - PAD * 2 - 90);
    ctx.font = fontMatch;
    ctx.fillStyle = "#e2e8f0";
    fxLines.forEach((ln, j) => ctx.fillText(ln, PAD + 80, y + 34 + j * 38));

    const stake = stakes[`${l.fixture.id}:${l.market}:${l.selection}`] ?? 0;
    const pick = `${marketLabel(l.market, l.selection)}`;
    const meta = `@ ${l.odds.toFixed(2)}   ·   ₦${stake.toLocaleString("en-US")}   ·   ${fmtPct(l.probability)} win`;
    ctx.font = fontPick;
    ctx.fillStyle = "#94a3b8";
    const pickLines = wrapText(ctx, pick, W - PAD * 2 - 90);
    pickLines.forEach((ln, j) => ctx.fillText(ln, PAD + 80, y + 34 + fxLines.length * 38 + 26 + j * 34));
    ctx.fillStyle = "#38bdf8";
    ctx.font = fontNum;
    ctx.fillText(meta, PAD + 80, y + 34 + fxLines.length * 38 + 26 + pickLines.length * 34);

    y += rowHeights[i] + ROW_GAP;
  });

  // --- footer ---
  ctx.strokeStyle = "rgba(16,185,129,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PAD, H - PAD - footerH + 20);
  ctx.lineTo(W - PAD, H - PAD - footerH + 20);
  ctx.stroke();

  if (combinedOdds && combinedOdds > 0) {
    ctx.font = `800 34px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = "#e2e8f0";
    ctx.fillText("Combined", PAD, H - PAD - footerH + 70);
    ctx.fillStyle = "#10b981";
    ctx.font = `800 44px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(`${combinedOdds.toFixed(2)}x`, PAD, H - PAD - footerH + 128);

    ctx.fillStyle = "#64748b";
    ctx.font = fontSub;
    const probLine = `True chance to land: ${combinedProbability ? fmtPct(combinedProbability) : "—"}`;
    const fairLine = combinedFairOdds ? `Fair odds at that probability: ${combinedFairOdds.toFixed(2)}x` : "";
    ctx.fillText(probLine, W - PAD - 420, H - PAD - footerH + 70);
    if (fairLine) ctx.fillText(fairLine, W - PAD - 420, H - PAD - footerH + 110);
  }

  ctx.fillStyle = "#475569";
  ctx.font = fontSub;
  ctx.fillText("Place manually on your bookmaker. No auto-betting.", PAD, H - PAD + 4);

  return canvas.toDataURL("image/png");
}