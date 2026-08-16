import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DataProvider } from "../lib/data-provider";
import { Nav } from "../components/nav";

export const metadata: Metadata = {
  title: "OddKet — Decision Support for SportyBet",
  description:
    "Probability + confidence per pick, Kelly staking, and closing line value as the scoreboard. Truth over excitement.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Let the mobile bottom tab bar paint under the browser chrome / home
  // indicator; padding-bottom uses env(safe-area-inset-bottom).
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <DataProvider>
          <Nav />
          {/* pb accounts for the fixed mobile tab bar (56px) + safe area. */}
          <main className="mx-auto w-full max-w-7xl px-4 pb-[calc(4.5rem+env(safe-area-inset-bottom))] pt-6 sm:px-6 md:pb-20">
            {children}
          </main>
        </DataProvider>
      </body>
    </html>
  );
}
