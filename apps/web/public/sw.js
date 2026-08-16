/* OddKet service worker — network-first runtime caching.
 *
 * The dashboard is data-driven (API calls go to the Cloudflare Worker, which
 * this SW never intercepts), so we keep it simple and safe:
 *   - Everything same-origin GET is tried against the network first (dev HMR
 *     and fresh builds always win), and successful responses are cached.
 *   - When offline, navigations fall back to the cached copy of the last
 *     visited page, or the app shell ("/") if that's all we have.
 *   - Old cache versions are cleaned up on activate.
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
