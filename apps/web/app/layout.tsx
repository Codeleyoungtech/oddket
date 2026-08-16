import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DataProvider } from "../lib/data-provider";
import { Nav } from "../components/nav";
import { PwaRegister } from "../components/pwa-register";

export const metadata: Metadata = {
  title: "OddKet — Decision Support for SportyBet",
  description:
    "Probability + confidence per pick, Kelly staking, and closing line value as the scoreboard. Truth over excitement.",
  manifest: "/manifest.webmanifest",
  applicationName: "OddKet",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "OddKet",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Let the mobile bottom tab bar paint under the browser chrome / home
  // indicator; padding-bottom uses env(safe-area-inset-bottom).
  viewportFit: "cover",
  themeColor: "#070a0f",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <PwaRegister />
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
