import {
  flagSlips,
  marketLabel,
  suggestParlays,
  type Database,
  type Fixture,
  type SlipLeg,
} from "@oddket/core";
import type { Env } from "./db";
import {
  listCornerPredictions,
  listRecentSettlements,
  listTelegramChats,
  loadDatabase,
  setTelegramDigestEnabled,
  upsertTelegramChat,
} from "./db";

/**
 * Telegram bot (@oddketbot) — commands, menus, and outbound alerts.
 *
 * Inbound:  POST /api/telegram/webhook  (secret-token verified) → handleTelegramUpdate
 * Outbound: /api/telegram/share (slips), notifyTelegramSettlements (settles),
 *           sendTelegramDigest (daily pick summary).
 *
 * Everything is read-only against D1 — the bot surfaces what the model already
 * flagged. It never places or logs a bet.
 */

type InlineKeyboard = Array<Array<{ text: string; callback_data?: string; url?: string }>>;

const WAT_OFFSET = 3600; // Nigeria (WAT, UTC+1) — the owner's timezone.
const DAY = 86400;

/* ---------------- low-level Bot API ---------------- */

function apiBase(token: string): string {
  return `https://api.telegram.org/bot${token}`;
}

async function callTelegram(
  env: Env,
  method: string,
  payload: unknown,
): Promise<{ ok: boolean; error?: string; body?: any }> {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured on the worker." };
  try {
    const res = await fetch(`${apiBase(token)}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body: any = await res.json().catch(() => null);
    if (!res.ok || body?.ok === false) {
      const detail = body?.description ?? (await res.text().catch(() => res.statusText));
      return { ok: false, error: `${method} failed (${res.status}): ${String(detail).slice(0, 200)}`, body };
    }
    return { ok: true, body };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** Send one HTML message (optionally with an inline keyboard). */
export async function sendTelegramMessage(
  env: Env,
  chatId: string | number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: text.slice(0, 4096),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (keyboard) payload.reply_markup = { inline_keyboard: keyboard };
  const r = await callTelegram(env, "sendMessage", payload);
  if (!r.ok) console.error(`[telegram] ${r.error}`);
  return r.ok;
}

/** Broadcast to every chat that has alerts enabled. Returns delivered count. */
async function broadcast(env: Env, text: string, keyboard?: InlineKeyboard): Promise<number> {
  const chats = await listTelegramChats(env.DB, true);
  // Always include the configured owner chat even before it talks to the bot.
  const ids = new Set(chats.map((c) => c.chatId));
  if (env.TELEGRAM_CHAT_ID) ids.add(env.TELEGRAM_CHAT_ID);
  let sent = 0;
  for (const id of ids) {
    if (await sendTelegramMessage(env, id, text, keyboard)) sent++;
  }
  return sent;
}

/* ---------------- formatting helpers ---------------- */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** "Sat 12/09 16:30 WAT" — the owner's clock, not UTC. */
function fmtKickoff(ts: number): string {
  const d = new Date((ts + WAT_OFFSET) * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCMonth() + 1} ${hh}:${mm} WAT`;
}

function fmtOdds(o: number): string {
  return o > 0 ? o.toFixed(2) : "—";
}

function fmtPct(p: number, digits = 1): string {
  return `${(p * 100).toFixed(digits)}%`;
}

function fmtSignedPct(p: number, digits = 1): string {
  return `${p >= 0 ? "+" : ""}${(p * 100).toFixed(digits)}%`;
}

function fmtMoney(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}₦${Math.abs(n).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;
}

/** Same real-fixture rule as the slip builder: never surface demo seeds. */
function slipFixtures(db: Database): Fixture[] {
  const scheduled = db.fixtures.filter((f) => f.status === "scheduled");
  const live = scheduled.filter((f) => f.sport !== "soccer");
  return live.length > 0 ? live : scheduled;
}

/** Flagged singles kicking off within `hours` (falls back to all upcoming). */
function flaggedLegs(db: Database, hours = 24): { legs: SlipLeg[]; windowLabel: string } {
  const now = Math.floor(Date.now() / 1000);
  const upcoming = slipFixtures(db);
  const soon = upcoming.filter((f) => f.commenceTime >= now - 1800 && f.commenceTime <= now + hours * 3600);
  if (soon.length > 0) {
    return { legs: flagSlips(soon, db.predictions, db.odds, db.settings), windowLabel: `next ${hours}h` };
  }
  return { legs: flagSlips(upcoming, db.predictions, db.odds, db.settings), windowLabel: "all upcoming" };
}

function menuKeyboard(): InlineKeyboard {
  return [
    [
      { text: "🎯 Today's picks", callback_data: "picks" },
      { text: "🎰 Multiples", callback_data: "multiples" },
    ],
    [
      { text: "⚽ Corners", callback_data: "corners" },
      { text: "🏆 Leagues", callback_data: "leagues" },
    ],
    [
      { text: "📊 Status", callback_data: "status" },
      { text: "🔔 Alerts", callback_data: "alerts" },
    ],
  ];
}

const HELP_TEXT = `🤖 <b>OddKet bot</b>

I surface what the model already flagged — I never place or auto-log a bet.

<b>Commands</b>
/picks — today's flagged singles (edge-ranked)
/multiples — safe · balanced · risky accumulators
/corners — team corner line probabilities
/leagues — league coverage + what's flagged
/settled — recent settled bets & parlays
/status — model + data health
/alerts — turn daily notifications on/off
/menu — buttons instead of typing
/help — this list

<b>The two numbers that matter</b>
• <b>Edge</b> = model probability − bookmaker implied probability. Positive = value.
• <b>Fair odds</b> = 1 ÷ model probability. Only stake when the bookie pays <i>above</i> fair odds.`;

/* ---------------- message builders ---------------- */

async function picksMessage(env: Env): Promise<string> {
  const db = await loadDatabase(env.DB);
  const { legs, windowLabel } = flaggedLegs(db, 24);
  if (legs.length === 0) {
    return `🎯 <b>Today's picks</b>\n\nNothing cleared the filters (${windowLabel}). That's the model saying <i>no value today</i> — not a bug.\n\nUse /status to check what's loaded, or /leagues to see coverage.`;
  }
  const shown = legs.slice(0, 8);
  const lines = shown.map((l, i) => {
    const f = l.fixture;
    return (
      `${i + 1}. <b>${esc(f.homeTeam)} vs ${esc(f.awayTeam)}</b>\n` +
      `   ${esc(marketLabel(l.market, l.selection))} @ <b>${fmtOdds(l.odds)}</b>\n` +
      `   model ${fmtPct(l.probability)} · edge ${fmtSignedPct(l.edge)} · fair ${fmtOdds(1 / l.probability)}\n` +
      `   ${fmtKickoff(f.commenceTime)}`
    );
  });
  const more = legs.length > shown.length ? `\n\n<i>+${legs.length - shown.length} more in the app</i>` : "";
  return `🎯 <b>Today's picks</b> — ${legs.length} flagged · ${windowLabel}\n\n${lines.join("\n\n")}${more}`;
}

async function multiplesMessage(env: Env): Promise<string> {
  const db = await loadDatabase(env.DB);
  if (!db.settings.multiplesEnabled) {
    return "🎰 <b>Multiples</b>\n\nMultiples are switched <b>off</b> in Settings — the gate stays closed until a sport clears the validation checklist (100+ bets, positive CLV, CI not straddling zero).";
  }
  const { legs } = flaggedLegs(db, 24 * 7);
  const suggestions = suggestParlays(legs, db.settings, "football", 6);
  if (suggestions.length === 0) {
    return "🎰 <b>Multiples</b>\n\nNo tier has enough independent flagged legs to build an accumulator right now. Fewer, better legs beats a forced ticket — see /picks for singles.";
  }
  const icons: Record<string, string> = { safe: "🟢", balanced: "🟡", risky: "🔴" };
  const blocks = suggestions.map((s) => {
    const label = s.tierLabel.replace(/ \(option \d+\)$/, "");
    const legsTxt = s.legs
      .map((l) => `   • ${esc(l.fixture.homeTeam)} vs ${esc(l.fixture.awayTeam)} — ${esc(marketLabel(l.market, l.selection))} @${fmtOdds(l.odds)}`)
      .join("\n");
    return (
      `${icons[s.tier] ?? "•"} <b>${esc(label)}</b> · ${s.legs.length} legs\n` +
      `${legsTxt}\n` +
      `   <b>${s.combinedOdds.toFixed(2)}x</b> · true chance ${fmtPct(s.combinedProbability)} · fair ${s.fairOdds.toFixed(2)}x\n` +
      `   suggested stake ${fmtMoney(s.stake)}`
    );
  });
  return `🎰 <b>Multiples</b> — ${suggestions.length} built\n\n${blocks.join("\n\n")}\n\n<i>All-or-nothing. The true chance of every leg landing is the number to respect, not the multiplier.</i>`;
}

async function leaguesMessage(env: Env): Promise<string> {
  const db = await loadDatabase(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const upcoming = slipFixtures(db).filter((f) => f.commenceTime >= now - 1800);
  if (upcoming.length === 0) {
    return "🏆 <b>Leagues</b>\n\nNo upcoming fixtures loaded. The odds pull runs 4×/day — check /status.";
  }
  const flagged = flagSlips(upcoming, db.predictions, db.odds, db.settings);
  const byLeague = new Map<string, { fixtures: number; flagged: number; next: number }>();
  for (const f of upcoming) {
    const cur = byLeague.get(f.league) ?? { fixtures: 0, flagged: 0, next: Infinity };
    cur.fixtures++;
    cur.next = Math.min(cur.next, f.commenceTime);
    byLeague.set(f.league, cur);
  }
  for (const l of flagged) {
    const cur = byLeague.get(l.fixture.league);
    if (cur) cur.flagged++;
  }
  const rows = [...byLeague.entries()].sort((a, b) => b[1].fixtures - a[1].fixtures);
  const body = rows
    .map(([league, v]) => {
      const flag = v.flagged > 0 ? ` · <b>${v.flagged} flagged</b>` : " · no edge";
      return `• <b>${esc(league)}</b> — ${v.fixtures} upcoming${flag}\n   next: ${fmtKickoff(v.next)}`;
    })
    .join("\n");
  return `🏆 <b>Leagues</b> — ${rows.length} tracked · ${upcoming.length} fixtures · ${flagged.length} flagged\n\n${body}\n\n<i>No edge in a league means the model sees the bookies priced it fairly — not that the league is broken.</i>`;
}

async function cornersMessage(env: Env): Promise<string> {
  const db = await loadDatabase(env.DB);
  const rows = await listCornerPredictions(env.DB);
  if (rows.length === 0) {
    return "⚽ <b>Corners</b>\n\nNo corner predictions loaded yet. The model runs with the daily predict job — check /status.";
  }
  const now = Math.floor(Date.now() / 1000);
  const fixtureById = new Map(db.fixtures.map((f) => [f.id, f]));
  // Only upcoming fixtures: the latest prediction row per (fixture, side).
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const key = `${r.fixtureId}:${r.side}`;
    if (!latest.has(key)) latest.set(key, r); // rows come newest-first
  }
  const items = [...latest.values()]
    .filter((r) => {
      const f = fixtureById.get(r.fixtureId);
      return f && f.commenceTime >= now - 1800;
    })
    .map((r) => {
      const f = fixtureById.get(r.fixtureId)!;
      let lineProbs: Record<string, number> = {};
      try {
        lineProbs = JSON.parse(r.lineProbs);
      } catch {
        lineProbs = {};
      }
      const over45 = lineProbs.over45 ?? 0;
      return { fixture: f, side: r.side, team: r.team, expected: r.predictedCorners, low: r.confidenceLow, high: r.confidenceHigh, over45 };
    });

  if (items.length === 0) {
    return "⚽ <b>Corners</b>\n\nNo upcoming fixtures have corner predictions yet. The model output is <b>not EV-checked</b> — compare the line against your bookmaker yourself.";
  }

  // Group by fixture, strongest Over-4.5 side first so the useful lines lead.
  const byFixture = new Map<string, typeof items>();
  for (const it of items) {
    const list = byFixture.get(it.fixture.id) ?? [];
    list.push(it);
    byFixture.set(it.fixture.id, list);
  }
  const blocks = [...byFixture.values()]
    .sort((a, b) => Math.max(...b.map((x) => x.over45)) - Math.max(...a.map((x) => x.over45)))
    .slice(0, 5)
    .map((group) => {
      const f = group[0]!.fixture;
      const teams = group
        .sort((a, b) => (a.side === "home" ? -1 : 1) - (b.side === "home" ? -1 : 1))
        .map((t) => `   ${t.side === "home" ? "🏠" : "✈️"} ${esc(t.team)}: <b>${t.expected.toFixed(1)}</b> corners (80% CI ${t.low.toFixed(1)}–${t.high.toFixed(1)}) · O4.5 ${fmtPct(t.over45, 0)}`)
        .join("\n");
      return `<b>${esc(f.homeTeam)} vs ${esc(f.awayTeam)}</b>\n${teams}\n   ${fmtKickoff(f.commenceTime)}`;
    });

  return `⚽ <b>Corners</b> — top ${blocks.length} of ${byFixture.size} upcoming\n\n${blocks.join("\n\n")}\n\n<i>Model prediction — NOT EV-checked, no odds comparison. Check your own bookmaker line.</i>`;
}

async function settledMessage(env: Env): Promise<string> {
  const events = await listRecentSettlements(env.DB, 168);
  if (events.length === 0) {
    return "🧾 <b>Settled</b>\n\nNothing settled in the last 7 days. Auto-settlement runs twice daily (08:15 & 21:15 UTC).";
  }
  const won = events.filter((e) => e.result === "won");
  const lost = events.filter((e) => e.result === "lost");
  const net = events.reduce((a, e) => a + e.amount, 0);
  const rows = events
    .slice(0, 10)
    .map((e) => `${e.result === "won" ? "✅" : "❌"} <b>${esc(e.label)}</b> · ${fmtMoney(e.amount)} · ${fmtKickoff(e.settledAt).replace(" WAT", "")}`)
    .join("\n");
  return `🧾 <b>Settled</b> — last 7 days\n\n${won.length} won · ${lost.length} lost\nnet <b>${fmtMoney(net)}</b>\n\n${rows}`;
}

async function statusMessage(env: Env): Promise<string> {
  const db = await loadDatabase(env.DB);
  const now = Math.floor(Date.now() / 1000);
  const upcoming = db.fixtures.filter((f) => f.status === "scheduled" && f.commenceTime > now);
  const byMarket = new Map<string, number>();
  for (const p of db.predictions) byMarket.set(p.market, (byMarket.get(p.market) ?? 0) + 1);
  const marketLines = [...byMarket.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, n]) => `   ${esc(m)}: ${n}`)
    .join("\n");
  const lastOdds = db.odds.length > 0 ? Math.max(...db.odds.map((o) => o.capturedAt)) : 0;
  const flagged = flagSlips(
    slipFixtures(db).filter((f) => f.commenceTime > now),
    db.predictions,
    db.odds,
    db.settings,
  );
  const lines = [
    `📊 <b>Status</b>`,
    ``,
    `mode: <b>${env.ODDS_API_KEY ? "live" : "demo"}</b>${env.TELEGRAM_BOT_TOKEN ? "" : " · telegram token missing"}`,
    `upcoming fixtures: <b>${upcoming.length}</b>`,
    `predictions: <b>${db.predictions.length}</b>`,
    `odds snapshots: <b>${db.odds.length}</b>${lastOdds ? ` (last pull ${fmtKickoff(lastOdds).replace(" WAT", "")})` : ""}`,
    `flagged now: <b>${flagged.length}</b>`,
    `multiples gate: <b>${db.settings.multiplesEnabled ? "ON" : "OFF"}</b>`,
    ``,
    `<b>Predictions by market</b>`,
    marketLines || "   none",
  ];
  return lines.join("\n");
}

async function alertsMessage(env: Env, chatId: string, label: string): Promise<string> {
  await upsertTelegramChat(env.DB, chatId, label);
  const chats = await listTelegramChats(env.DB);
  const me = chats.find((c) => c.chatId === chatId);
  const on = me?.digestEnabled ?? true;
  return `🔔 <b>Alerts</b> — currently <b>${on ? "ON" : "OFF"}</b>\n\nWhen ON you get:\n• a daily digest of the top flagged picks + accumulators\n• a message whenever a bet or parlay settles\n\nTap to change:`;
}

/* ---------------- command routing ---------------- */

function alertsKeyboard(on: boolean): InlineKeyboard {
  return [
    [
      { text: on ? "🔕 Turn alerts OFF" : "🔔 Turn alerts ON", callback_data: on ? "digest_off" : "digest_on" },
      { text: "📊 Status", callback_data: "status" },
    ],
  ];
}

function chatLabel(from: any): string {
  if (!from) return "unknown";
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ");
  return from.username ? `${name} (@${from.username})`.trim() : name || String(from.id);
}

/** Route one command/keyboard action to its reply text. */
async function replyFor(env: Env, action: string, chatId: string, label: string): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  switch (action) {
    case "start":
      return {
        text: `👋 <b>Welcome to OddKet</b>\n\nI'm your model's front desk: flagged picks, accumulators, corner lines, and settlement alerts — straight from the same engine as the web app.\n\n${HELP_TEXT}`,
        keyboard: menuKeyboard(),
      };
    case "help":
      return { text: HELP_TEXT, keyboard: menuKeyboard() };
    case "menu":
      return { text: "Pick a view 👇", keyboard: menuKeyboard() };
    case "picks":
      return { text: await picksMessage(env), keyboard: menuKeyboard() };
    case "multiples":
      return { text: await multiplesMessage(env), keyboard: menuKeyboard() };
    case "leagues":
      return { text: await leaguesMessage(env), keyboard: menuKeyboard() };
    case "corners":
      return { text: await cornersMessage(env), keyboard: menuKeyboard() };
    case "settled":
      return { text: await settledMessage(env), keyboard: menuKeyboard() };
    case "status":
      return { text: await statusMessage(env), keyboard: menuKeyboard() };
    case "alerts": {
      const text = await alertsMessage(env, chatId, label);
      const on = (await listTelegramChats(env.DB)).find((c) => c.chatId === chatId)?.digestEnabled ?? true;
      return { text, keyboard: alertsKeyboard(on) };
    }
    case "digest_on":
      await upsertTelegramChat(env.DB, chatId, label);
      await setTelegramDigestEnabled(env.DB, chatId, true);
      return { text: "🔔 Alerts <b>ON</b>. You'll get the daily digest and settlement messages.", keyboard: alertsKeyboard(true) };
    case "digest_off":
      await upsertTelegramChat(env.DB, chatId, label);
      await setTelegramDigestEnabled(env.DB, chatId, false);
      return { text: "🔕 Alerts <b>OFF</b>. Commands still work anytime — just no pushes.", keyboard: alertsKeyboard(false) };
    default:
      return { text: `I don't know <code>${esc(action)}</code> yet. Try /help.`, keyboard: menuKeyboard() };
  }
}

/** Handle one Telegram update (message or button tap). */
export async function handleTelegramUpdate(env: Env, update: any): Promise<void> {
  const message = update?.message ?? update?.edited_message;
  const callback = update?.callback_query;

  const chatId: string | undefined =
    callback?.message?.chat?.id != null ? String(callback.message.chat.id) : message?.chat?.id != null ? String(message.chat.id) : undefined;
  if (!chatId) return;

  const from = callback?.from ?? message?.from;
  const label = chatLabel(from);
  // Register every chat that talks to us so alerts can reach it later.
  await upsertTelegramChat(env.DB, chatId, label);

  let action: string;
  const isCommand = Boolean(message?.text && String(message.text).trim().startsWith("/"));
  if (callback) {
    action = String(callback.data ?? "").trim();
    // Always answer the tap, otherwise the client shows a spinner forever.
    await callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id });
  } else if (isCommand) {
    const raw = String(message?.text ?? "").trim();
    // "/picks@oddketbot arg" → "picks"
    action = raw.replace(/^\//, "").split("@")[0]!.split(/\s+/)[0]!.toLowerCase();
  } else {
    // Plain text ("hi", "what are the picks?") isn't a command — don't scold
    // the user with an "unknown command" error, just show the menu.
    action = "menu";
  }

  let reply: { text: string; keyboard?: InlineKeyboard };
  try {
    reply = await replyFor(env, action, chatId, label);
  } catch (err) {
    console.error(`[telegram] command "${action}" failed: ${err}`);
    reply = { text: `⚠️ Something went wrong building that view: <code>${esc(String(err).slice(0, 160))}</code>`, keyboard: menuKeyboard() };
  }
  await sendTelegramMessage(env, chatId, reply.text, reply.keyboard);
}

/* ---------------- outbound alerts ---------------- */

/**
 * Daily digest: today's best picks + the three accumulator tiers. Fired by
 * GitHub Actions (or manually via POST /api/telegram/digest).
 */
export async function sendTelegramDigest(env: Env): Promise<{ sent: number; picks: number }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: 0, picks: 0 };
  const db = await loadDatabase(env.DB);
  const { legs, windowLabel } = flaggedLegs(db, 24);
  const suggestions = db.settings.multiplesEnabled ? suggestParlays(legs, db.settings, "football", 3) : [];

  const header = `☀️ <b>OddKet daily digest</b>\n${new Date(Date.now() + WAT_OFFSET * 1000).toISOString().slice(0, 10)} · ${legs.length} flagged (${windowLabel})`;
  if (legs.length === 0) {
    const sent = await broadcast(env, `${header}\n\nNo selections cleared the filters. Sitting out is a position — no forced bets.`, menuKeyboard());
    return { sent, picks: 0 };
  }

  const top = legs
    .slice(0, 5)
    .map((l, i) => `${i + 1}. <b>${esc(l.fixture.homeTeam)} vs ${esc(l.fixture.awayTeam)}</b> — ${esc(marketLabel(l.market, l.selection))} @${fmtOdds(l.odds)} · edge ${fmtSignedPct(l.edge)}`)
    .join("\n");

  const mult = suggestions.length
    ? "\n\n<b>Accumulators</b>\n" +
      suggestions
        .map((s) => {
          const icons: Record<string, string> = { safe: "🟢", balanced: "🟡", risky: "🔴" };
          return `${icons[s.tier] ?? "•"} ${s.legs.length} legs — ${s.combinedOdds.toFixed(2)}x · true chance ${fmtPct(s.combinedProbability)}`;
        })
        .join("\n")
    : "";

  const text = `${header}\n\n<b>Top picks</b>\n${top}${mult}\n\nTap through for the full list.`;
  const sent = await broadcast(env, text, menuKeyboard());
  return { sent, picks: legs.length };
}

/**
 * Settlement alert — called right after a settle run that changed something.
 * Only reports events from the last 3 hours so a quiet re-run stays quiet.
 */
export async function notifyTelegramSettlements(env: Env): Promise<{ sent: number; events: number }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: 0, events: 0 };
  const events = await listRecentSettlements(env.DB, 3);
  if (events.length === 0) return { sent: 0, events: 0 };

  const won = events.filter((e) => e.result === "won");
  const net = events.reduce((a, e) => a + e.amount, 0);
  const rows = events
    .slice(0, 10)
    .map((e) => `${e.result === "won" ? "✅" : "❌"} <b>${esc(e.label)}</b> — ${fmtMoney(e.amount)}`)
    .join("\n");
  const header = won.length === events.length ? "🎉 <b>All settled bets won</b>" : "🧾 <b>Bets settled</b>";
  const text = `${header}\n\n${rows}\n\nnet <b>${fmtMoney(net)}</b>`;
  const sent = await broadcast(env, text, menuKeyboard());
  return { sent, events: events.length };
}

/* ---------------- webhook registration ---------------- */

/** Register the webhook with Telegram so commands reach this worker. */
export async function registerTelegramWebhook(env: Env, origin: string): Promise<{ ok: boolean; error?: string; url?: string }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured." };
  const url = `${origin.replace(/\/$/, "")}/api/telegram/webhook`;
  const payload: Record<string, unknown> = {
    url,
    allowed_updates: ["message", "edited_message", "callback_query"],
    drop_pending_updates: false,
  };
  if (env.TELEGRAM_WEBHOOK_SECRET) payload.secret_token = env.TELEGRAM_WEBHOOK_SECRET;
  const r = await callTelegram(env, "setWebhook", payload);
  if (!r.ok) return { ok: false, error: r.error, url };
  // Register the command list so Telegram shows the "/" autocomplete menu.
  await callTelegram(env, "setMyCommands", {
    commands: [
      { command: "picks", description: "Today's flagged singles" },
      { command: "multiples", description: "Safe / balanced / risky accumulators" },
      { command: "corners", description: "Team corner line probabilities" },
      { command: "leagues", description: "League coverage and what's flagged" },
      { command: "settled", description: "Recent settled bets" },
      { command: "status", description: "Model and data health" },
      { command: "alerts", description: "Turn daily notifications on/off" },
      { command: "menu", description: "Show the button menu" },
      { command: "help", description: "How to use the bot" },
    ],
  });
  return { ok: true, url };
}
