"use client";

import { useEffect, useState } from "react";
import { Badge } from "./ui";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * "Install OddKet as an app" card — a real install (standalone window, own
 * icon on the home screen / dock), not a bookmark:
 *  - Android + desktop Chrome/Edge: capture `beforeinstallprompt`, show an
 *    Install button.
 *  - iOS Safari: no prompt event exists, so show the Share → Add to Home
 *    Screen instructions.
 *  - Already installed: show the installed state.
 */
export function InstallApp() {
  const [promptEvt, setPromptEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari's legacy signal for standalone web apps
      (navigator as unknown as { standalone?: boolean }).standalone === true;
    setInstalled(isStandalone);
    setIsIOS(/iphone|ipad|ipod/i.test(navigator.userAgent));

    const onPrompt = (e: Event) => {
      e.preventDefault(); // don't auto-fire the browser's own prompt
      setPromptEvt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = async () => {
    if (!promptEvt) return;
    await promptEvt.prompt();
    const choice = await promptEvt.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setPromptEvt(null);
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-b from-ink-850 to-ink-950 ring-1 ring-emerald-400/30">
          <span className="font-mono text-2xl font-bold text-emerald-400">K</span>
        </span>
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            Install OddKet as an app
            {installed && <Badge tone="green">installed</Badge>}
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {installed
              ? "Running in its own window with a home-screen icon."
              : "Standalone window, own icon, opens instantly — not a bookmark."}
          </p>
        </div>
      </div>

      <div className="sm:ml-auto">
        {installed ? (
          <span className="text-xs text-slate-500">✓ On your home screen / dock</span>
        ) : promptEvt ? (
          <button className="btn-primary" onClick={install}>
            Install app
          </button>
        ) : isIOS ? (
          <p className="max-w-[220px] text-right text-xs leading-relaxed text-slate-500">
            Tap <span className="text-slate-300">Share</span>{" "}
            <span aria-hidden>↗</span> then{" "}
            <span className="text-slate-300">Add to Home Screen</span>.
          </p>
        ) : (
          <p className="max-w-[220px] text-right text-xs leading-relaxed text-slate-500">
            Use the install icon in your browser&apos;s address bar.
          </p>
        )}
      </div>
    </div>
  );
}
