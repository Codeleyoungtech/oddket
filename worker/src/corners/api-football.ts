/**
 * API-Football client for real corner results.
 *
 * Why this exists: every corner prediction had to be checked by looking the
 * match up by hand, because nothing in the pipeline knew the actual corner
 * count. That made the corner model unvalidatable — you cannot tell whether a
 * line probability is honest without scoring it against what happened.
 *
 * KEY POOL. The free tier is limited per key, so several keys are used
 * round-robin. Two rules that matter in practice:
 *
 *  - A key that returns 429 (or 403, which API-Football also uses for quota) is
 *    put on cooldown and the request is retried on the next key. Without this a
 *    single spent key silently fails the whole run.
 *  - The pool needs no guessing about the daily allowance: whatever the limit
 *    is, once every key is cooling down the client reports
 *    `reason: "all keys exhausted"` instead of pretending nothing was found.
 *
 * Configure with a comma-separated `API_FOOTBALL_KEYS` secret. Absent keys are
 * not an error — the endpoint reports `configured: false` and the rest of the
 * app keeps working.
 */

export interface ApiFootballEnv {
  API_FOOTBALL_KEYS?: string;
  API_FOOTBALL_BASE?: string;
}

const DEFAULT_BASE = "https://v3.football.api-sports.io";

/** Cooldown applied to a key that reported a quota error. */
const COOLDOWN_SEC = 60 * 30;

interface KeyState {
  key: string;
  coolingUntil: number;
  uses: number;
  lastError?: string;
}

export interface KeyPoolReport {
  configured: boolean;
  keys: number;
  uses: Record<string, number>;
  cooling: number;
}

export class ApiFootballKeyPool {
  private states: KeyState[];
  private cursor = 0;

  constructor(raw: string | undefined) {
    this.states = (raw ?? "")
      .split(/[,\s]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 0)
      .map((key, i) => ({ key, coolingUntil: 0, uses: 0, lastError: undefined, index: i })) as KeyState[];
  }

  get configured(): boolean {
    return this.states.length > 0;
  }

  get size(): number {
    return this.states.length;
  }

  report(): KeyPoolReport {
    const now = Math.floor(Date.now() / 1000);
    return {
      configured: this.configured,
      keys: this.states.length,
      // Identifiers are the last 4 characters only — never log a full key.
      uses: Object.fromEntries(this.states.map((s) => [`…${s.key.slice(-4)}`, s.uses])),
      cooling: this.states.filter((s) => s.coolingUntil > now).length,
    };
  }

  private available(now: number): KeyState | null {
    for (let i = 0; i < this.states.length; i++) {
      const idx = (this.cursor + i) % this.states.length;
      const st = this.states[idx];
      if (st.coolingUntil <= now) {
        this.cursor = (idx + 1) % this.states.length;
        return st;
      }
    }
    return null;
  }

  private demote(st: KeyState, reason: string): void {
    st.coolingUntil = Math.floor(Date.now() / 1000) + COOLDOWN_SEC;
    st.lastError = reason;
  }

  /** GET a path, rotating keys. Returns parsed JSON or a typed failure. */
  async get<T>(
    path: string,
    params: Record<string, string | number>,
    base: string = DEFAULT_BASE,
  ): Promise<{ ok: true; data: T; key: string } | { ok: false; status: number; reason: string }> {
    if (!this.configured) return { ok: false, status: 0, reason: "no keys configured" };

    const qs = new URLSearchParams(
      Object.entries(params).map(([k, v]) => [k, String(v)] as [string, string]),
    ).toString();
    const url = `${base}${path}${qs ? `?${qs}` : ""}`;

    let lastReason = "unknown";
    for (let attempt = 0; attempt < this.states.length; attempt++) {
      const now = Math.floor(Date.now() / 1000);
      const st = this.available(now);
      if (!st) return { ok: false, status: 429, reason: "all keys cooling down" };

      st.uses += 1;
      let res: Response;
      try {
        res = await fetch(url, { headers: { "x-apisports-key": st.key } });
      } catch (err) {
        // A network failure is not the key's fault; try the next one.
        lastReason = `network: ${String(err)}`;
        this.demote(st, lastReason);
        continue;
      }

      if (res.status === 429 || res.status === 403) {
        lastReason = `quota (${res.status})`;
        this.demote(st, lastReason);
        continue;
      }
      if (!res.ok) {
        return { ok: false, status: res.status, reason: `http ${res.status}` };
      }

      const body = (await res.json()) as {
        errors?: unknown;
        response?: unknown;
      };
      // API-Football returns 200 with an `errors` payload for plan/quota issues.
      const errs = body.errors;
      const errText = Array.isArray(errs)
        ? errs.join("; ")
        : errs && typeof errs === "object"
          ? Object.values(errs).join("; ")
          : "";
      if (errText && /rate|limit|quota|suspend/i.test(errText)) {
        lastReason = errText;
        this.demote(st, lastReason);
        continue;
      }
      if (errText) {
        return { ok: false, status: res.status, reason: errText };
      }

      return { ok: true, data: (body.response ?? []) as T, key: st.key };
    }
    return { ok: false, status: 429, reason: lastReason };
  }
}

/* ------------------------------------------------------------------ */

export interface ApiFootballFixture {
  fixture?: { id?: number; date?: string; status?: { short?: string } };
  teams?: { home?: { id?: number; name?: string }; away?: { id?: number; name?: string } };
}

export interface ApiFootballStatisticBlock {
  team?: { id?: number; name?: string };
  statistics?: { type?: string; value?: string | number | null }[];
}

/**
 * Pull corner counts out of a `/fixtures/statistics` response.
 *
 * The statistic is named "Corner Kicks" and its `value` is sometimes a string,
 * sometimes a number, and sometimes null for an unfinished match — all three
 * cases are handled rather than assumed away.
 */
export function parseCornerStatistics(
  blocks: ApiFootballStatisticBlock[],
): { homeCorners: number; awayCorners: number } | null {
  const read = (b: ApiFootballStatisticBlock): number | null => {
    for (const s of b.statistics ?? []) {
      if ((s.type ?? "").toLowerCase() !== "corner kicks") continue;
      const v = s.value;
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };
  if (!Array.isArray(blocks) || blocks.length < 2) return null;
  const home = read(blocks[0]);
  const away = read(blocks[1]);
  if (home == null || away == null) return null;
  return { homeCorners: home, awayCorners: away };
}

/** yyyy-mm-dd in UTC for an epoch-seconds timestamp. */
export function utcDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}
