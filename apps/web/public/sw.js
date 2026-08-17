/* OddKet service worker — network-first runtime caching + settlement alerts.
 *
 * Caching:
 *   - Everything same-origin GET is tried against the network first (dev HMR
 *     and fresh builds always win), and successful responses are cached.
 *   - When offline, navigations fall back to the cached copy of the last
 *     visited page, or the app shell ("/") if that's all we have.
 *   - Old cache versions are cleaned up on activate.
 *
 * Settlement alerts (web push):
 *   - The worker sends a DATA-LESS push when a bet settles (no payload
 *     encryption needed). This SW wakes up, fetches the recent settlements
 *     from the API for detail, and shows the notification. If the fetch
 *     fails (offline / unknown API base), it falls back to a generic notice.
 *   - The API base URL is announced by the page after registration
 *     (postMessage), so the SW knows where the worker lives even when
 *     NEXT_PUBLIC_API_URL is set (Vercel → cross-origin worker).
 */
const CACHE = "oddket-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle same-origin http(s) — never intercept API calls (the worker
  // URL is cross-origin anyway) or websocket upgrades.
  if (!/^https?:$/.test(url.protocol)) return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          // Offline navigation to a page we've never cached → show the shell.
          if (req.mode === "navigate") return caches.match("/");
          return Response.error();
        })
      )
  );
});

/* ---------------- settlement alerts (web push) ---------------- */

const PUSH_DB = "oddket-push";
const PUSH_STORE = "meta";

let API_BASE = null;

function openPushDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PUSH_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(PUSH_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function pushGet(key) {
  try {
    const db = await openPushDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(PUSH_STORE, "readonly");
      const r = tx.objectStore(PUSH_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function pushSet(key, value) {
  try {
    const db = await openPushDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PUSH_STORE, "readwrite");
      tx.objectStore(PUSH_STORE).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  } catch {
    /* best-effort — a missed apiBase just means a generic notification */
  }
}

/* The page announces the API base (lib/api.ts apiBase()) once the SW is in
 * control, so cross-origin deployments (Vercel → worker) work here too. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data && data.type === "ODDKET_API_BASE") {
    API_BASE = data.url;
    pushSet("apiBase", data.url);
  }
});

async function apiBase() {
  if (API_BASE) return API_BASE;
  API_BASE = await pushGet("apiBase");
  if (API_BASE) return API_BASE;
  const loc = self.location;
  return loc.hostname === "localhost" || loc.hostname === "127.0.0.1" ? "http://localhost:8787" : "/api";
}

async function fetchRecentEvents(hours = 1) {
  const base = await apiBase();
  const res = await fetch(`${base}/api/settlements/recent?hours=${hours}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data.events) ? data.events : null;
}

function formatAmount(amount) {
  const sign = amount >= 0 ? "+" : "−";
  return `${sign}₦${Math.abs(amount).toLocaleString("en-NG")}`;
}

async function showSettlementNotification() {
  const events = await fetchRecentEvents(1).catch(() => null);
  const common = {
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: "oddket-settlement",
    renotify: true,
    data: { url: "/bets" },
  };
  if (events && events.length > 0) {
    const won = events.filter((e) => e.result === "won");
    const total = events.reduce((s, e) => s + e.amount, 0);
    let body;
    if (events.length === 1) {
      const e = events[0];
      body = `${e.result === "won" ? "Won" : "Lost"} — ${e.label} (${formatAmount(e.amount)})`;
    } else {
      body = `${events.length} bets settled · ${won.length} won, ${events.length - won.length} lost · ${formatAmount(total)}`;
    }
    self.registration.showNotification("OddKet — bet settled", { ...common, body });
  } else {
    self.registration.showNotification("OddKet — bet settled", { ...common, body: "Tap to see the result." });
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(showSettlementNotification());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
