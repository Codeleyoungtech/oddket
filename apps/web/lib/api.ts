import type { Database, Settings } from "@oddket/core";

/**
 * Worker base URL. Override with NEXT_PUBLIC_API_URL (e.g. your deployed
 * worker). Default: same-host /api (deployed behind a proxy) or the local
 * wrangler dev server.
 */
export function apiBase(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")) {
    return "http://localhost:8787";
  }
  return "/api";
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return res.json() as Promise<T>;
}

export interface Health {
  ok: boolean;
  mode: "live" | "demo";
  time: number;
}

export const api = {
  health: () => req<Health>("/api/health"),
  db: () => req<Database>("/api/db"),
  settings: () => req<Settings>("/api/settings"),
  saveSettings: (s: Settings) => req<{ ok: boolean; settings: Settings }>("/api/settings", { method: "PUT", body: JSON.stringify(s) }),
  logBet: (b: unknown) => req<{ ok: boolean; bet: unknown }>("/api/bets", { method: "POST", body: JSON.stringify(b) }),
  recordOutcome: (o: unknown) => req<{ ok: boolean }>("/api/outcomes", { method: "POST", body: JSON.stringify(o) }),
};
