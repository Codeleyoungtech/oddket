"use client";

import { useEffect } from "react";
import { apiBase } from "../lib/api";

/**
 * Registers the service worker (public/sw.js) once the page is interactive.
 * The SW is network-first, so it's safe in dev (HMR always wins) while still
 * making the app installable + shell-offline in production.
 *
 * After registration it announces the API base URL to the SW (postMessage)
 * so push notifications can fetch settlement detail cross-origin (Vercel →
 * worker). Re-announces whenever a new SW takes control.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const announce = (reg: ServiceWorkerRegistration) => {
      const sw = reg.active;
      if (sw) sw.postMessage({ type: "ODDKET_API_BASE", url: apiBase() });
    };

    const register = () => {
      navigator.serviceWorker
        .register("/sw.js")
        .then((reg) => {
          announce(reg);
          reg.addEventListener("updatefound", () => {
            const sw = reg.installing ?? reg.waiting;
            sw?.addEventListener("statechange", () => {
              if (sw.state === "activated") announce(reg);
            });
          });
        })
        .catch(() => {
          /* SW registration is best-effort — never break the app over it. */
        });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    // A newly-activated SW (update or clients.claim) takes control → announce again.
    const onControllerChange = () => {
      navigator.serviceWorker.controller?.postMessage({ type: "ODDKET_API_BASE", url: apiBase() });
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      window.removeEventListener("load", register);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  return null;
}
