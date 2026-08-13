import type { Metadata } from "next";
import "./globals.css";
import { DataProvider } from "../lib/data-provider";
import { Nav } from "../components/nav";

export const metadata: Metadata = {
  title: "OddKet — Decision Support for SportyBet",
  description:
    "Probability + confidence per pick, Kelly staking, and closing line value as the scoreboard. Truth over excitement.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <DataProvider>
          <Nav />
          <main className="mx-auto w-full max-w-7xl px-4 pb-20 pt-6 sm:px-6">{children}</main>
        </DataProvider>
      </body>
    </html>
  );
}
