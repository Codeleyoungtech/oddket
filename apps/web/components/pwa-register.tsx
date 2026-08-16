"use client";

import { useEffect } from "react";

/**
 * Registers the service worker (public/sw.js) once the page is interactive.
 * The SW is network-first, so it's safe in dev (HMR always wins) while still
 * making the app installable + shell-offline in production.
 */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* SW registration is best-effort — never break the app over it. */
      });
    };
    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
