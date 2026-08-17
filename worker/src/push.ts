import type { Env, SettlementEvent } from "./db";
import { deletePushSubscription, listPushSubscriptions, listRecentSettlements } from "./db";

/**
 * Settlement alerts via Web Push (RFC 8030/8292). Data-less pushes only — the
 * notification body is built client-side by the service worker (it fetches
 * /api/settlements/recent for detail), so no payload encryption (RFC 8291)
 * is needed. VAPID keys missing → send is a silent no-op.
 *
 * Uses Web Crypto (available in Workers) to sign the ES256 JWT; no npm deps.
 */

function b64url(input: string | Uint8Array): string {
  if (typeof input === "string") return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let bin = "";
  for (let i = 0; i < input.length; i++) bin += String.fromCharCode(input[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sign the VAPID JWT (ES256) with the worker's private key. */
async function signVapidJwt(privateJwk: string, aud: string, subject: string): Promise<string> {
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  };
  const toSign = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    JSON.parse(privateJwk) as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(toSign),
  );
  return `${toSign}.${b64url(new Uint8Array(sig))}`;
}

interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Send one data-less push to a subscription. True if delivered (2xx). */
async function sendPush(env: Env, sub: PushTarget): Promise<boolean> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  try {
    const aud = new URL(sub.endpoint).origin;
    const subject = env.VAPID_SUBJECT ?? "mailto:oddket@localhost";
    const jwt = await signVapidJwt(env.VAPID_PRIVATE_KEY, aud, subject);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
        TTL: "86400",
        Urgency: "normal",
        "Content-Length": "0",
      },
    });
    if (res.status === 410 || res.status === 404) {
      // Subscription is dead (uninstalled / expired) — prune it.
      await deletePushSubscription(env.DB, sub.endpoint);
      return false;
    }
    return res.ok;
  } catch (err) {
    console.error(`[push] send failed: ${err}`);
    return false;
  }
}

/**
 * Push one summary notification to every subscribed device after a settle
 * run. The service worker fetches the recent list for the actual message;
 * this just wakes it up. Prunes dead endpoints as it goes.
 */
export async function notifySettlements(env: Env): Promise<{ sent: number; subs: number }> {
  const subs = await listPushSubscriptions(env.DB);
  if (subs.length === 0) return { sent: 0, subs: 0 };
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return { sent: 0, subs: subs.length };

  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    if (await sendPush(env, s)) sent++;
  }));
  return { sent, subs: subs.length };
}

/** Send a test push to one specific endpoint (Settings → “Test notification”). */
export async function sendTestPush(env: Env, endpoint: string): Promise<boolean> {
  const subs = await listPushSubscriptions(env.DB);
  const sub = subs.find((s) => s.endpoint === endpoint);
  if (!sub) return false;
  return sendPush(env, sub);
}

/** Shape shared with the web client + service worker. */
export interface SettlementEventApi {
  events: SettlementEvent[];
}

/** Fetch helper for the SW: newest events (used to build notification text). */
export async function recentEvents(env: Env, hours: number): Promise<SettlementEventApi> {
  return { events: await listRecentSettlements(env.DB, hours) };
}
