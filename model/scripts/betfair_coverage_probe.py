#!/usr/bin/env python3
"""
Betfair Exchange coverage probe — ATP Challenger spike (data-availability check only).

Scope (per the user's spike instruction):
  - Pull Betfair Exchange data for ATP Challenger-tour matches in a window.
  - Count matches that have a MATCH_ODDS market with REAL matched volume
    (totalMatched > 0), not just a market that exists with zero liquidity.
  - Report: matches with usable odds coverage vs. total Challenger matches
    played in the window, plus typical liquidity per match.
  - Does NOT touch the CLV ingestion pipeline, worker, or model code.

Auth (ranked by the user: cert-based > session token > raw password):
  1. CERTIFICATE-BASED (best, non-interactive): generate a keypair with
     openssl, upload the PUBLIC cert to your Betfair account, then run with
     BF_CERT + BF_KEY. Login uses mutual TLS; no password ever stored.
  2. SESSION TOKEN (practical default): run `--login-only` once with
     BF_USERNAME+BF_PASSWORD to mint a short-lived token (password is used
     for that single call and never written to disk), then run the probe
     with BF_APP_KEY + BF_SESSION_TOKEN.
  3. Never store the raw password in the script or .env — the one-time
     login call is the only place a password is accepted.

Usage:
  # one-time token mint (optional; only if you don't have a token yet)
  BF_APP_KEY=... BF_USERNAME=... BF_PASSWORD=... python3 betfair_coverage_probe.py --login-only

  # main probe (session token)
  BF_APP_KEY=... BF_SESSION_TOKEN=... python3 betfair_coverage_probe.py

  # main probe (certificate auth)
  BF_APP_KEY=... BF_CERT=client.crt BF_KEY=client.key python3 betfair_coverage_probe.py

Env vars:
  BF_APP_KEY        Betfair application key (delayed key is free)
  BF_SESSION_TOKEN  Session token (preferred; from --login-only or your own login)
  BF_USERNAME       Betfair username (only for the one-time --login-only call)
  BF_PASSWORD       Betfair password (only for the one-time --login-only call)
  BF_CERT / BF_KEY  Client cert + key paths (certificate-based auth)
  BF_FROM / BF_TO   ISO timestamps for the window (default: last 28 days)
"""
import json
import os
import ssl
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timedelta, timezone

API_BASE = "https://api.betfair.com/exchange/betting/rest/v1.0"
LOGIN_URL = "https://identitysso.betfair.com/api/login"
EVENT_TYPE_TENNIS = "2"  # Betfair event type id for Tennis

APP_KEY = os.environ.get("BF_APP_KEY", "")
USERNAME = os.environ.get("BF_USERNAME", "")
PASSWORD = os.environ.get("BF_PASSWORD", "")
SESSION = os.environ.get("BF_SESSION_TOKEN", "")
CERT = os.environ.get("BF_CERT", "")
KEY = os.environ.get("BF_KEY", "")

FROM = os.environ.get("BF_FROM")
TO = os.environ.get("BF_TO")
if not FROM:
    FROM = (datetime.now(timezone.utc) - timedelta(days=28)).strftime("%Y-%m-%dT00:00:00Z")
if not TO:
    TO = datetime.now(timezone.utc).strftime("%Y-%m-%dT23:59:59Z")


def _ssl_ctx():
    ctx = ssl.create_default_context()
    if CERT and KEY:
        ctx.load_cert_chain(CERT, KEY)
    return ctx


def _open(req, timeout=30):
    ctx = _ssl_ctx()
    if CERT and KEY:
        return urllib.request.urlopen(req, timeout=timeout, context=ctx)
    return urllib.request.urlopen(req, timeout=timeout)


def api(path: str, payload: dict) -> dict:
    """POST to the Betfair JSON-RPC-style REST endpoint."""
    req = urllib.request.Request(
        f"{API_BASE}/{path}/",
        data=json.dumps(payload).encode(),
        headers={
            "X-Application": APP_KEY,
            "X-Authentication": SESSION,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with _open(req) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:500]
        raise SystemExit(f"Betfair API error {e.code} on {path}: {body}")


def login(mint_only: bool = False):
    """Mint a session token. Password is used for this one call and never stored."""
    data = urllib.parse.urlencode({"username": USERNAME, "password": PASSWORD}).encode()
    req = urllib.request.Request(
        LOGIN_URL, data=data,
        headers={"X-Application": APP_KEY, "Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with _open(req) as resp:
        out = json.loads(resp.read().decode())
    if out.get("status") != "SUCCESS":
        raise SystemExit(f"Betfair login failed: {out.get('error') or out.get('status')}")
    token = out["token"]
    if mint_only:
        print(token)  # stdout only — never written to disk
        sys.exit(0)
    return token


def main():
    global SESSION
    if "--login-only" in sys.argv:
        if not (APP_KEY and USERNAME and PASSWORD):
            raise SystemExit("--login-only needs BF_APP_KEY + BF_USERNAME + BF_PASSWORD")
        login(mint_only=True)

    if not APP_KEY:
        raise SystemExit("BF_APP_KEY is required (delayed app key is free)")
    if not SESSION:
        if CERT and KEY:
            print("[auth] using certificate-based authentication (no session token needed)")
            # Certificate auth still needs a session token on Betfair: mint one with the cert.
            SESSION = login()
            print("[auth] session token obtained via client certificate")
        elif USERNAME and PASSWORD:
            SESSION = login()
            print("[auth] session token obtained (password used once, not stored)")
        else:
            raise SystemExit("Set BF_SESSION_TOKEN (preferred), or BF_CERT+BF_KEY, or BF_USERNAME+BF_PASSWORD")

    print(f"[window] {FROM}  ->  {TO}")

    # 1) List all tennis competitions
    comps = api("listCompetitions", {"filter": {"eventTypeIds": [EVENT_TYPE_TENNIS]}})
    if not isinstance(comps, list):
        raise SystemExit(f"Unexpected listCompetitions response: {str(comps)[:400]}")
    print(f"[competitions] tennis competitions returned: {len(comps)}")

    # 2) Find Challenger competitions (Betfair names them e.g. "ATP Challenger ...")
    chal_comps = [c for c in comps if "challenger" in c.get("competition", {}).get("name", "").lower()]
    print(f"[competitions] challenger-named: {len(chal_comps)}")
    for c in chal_comps:
        print(f"    - {c['competition']['name']}  (id {c['competition']['id']})")

    # Fallback: if no competition is challenger-named, dump all tennis competition names
    # so we can see how Betfair organises the Challenger circuit.
    if not chal_comps:
        names = sorted({c.get("competition", {}).get("name", "?") for c in comps})
        print("[competitions] no 'challenger' in names; all tennis competition names:")
        for n in names:
            print(f"    - {n}")

    # 3) For each challenger competition: list events (matches) in the window
    all_events = []
    for c in chal_comps:
        comp_id = c["competition"]["id"]
        evs = api("listEvents", {
            "filter": {
                "competitionIds": [comp_id],
                "eventTypeIds": [EVENT_TYPE_TENNIS],
                "marketStartTime": {"from": FROM, "to": TO},
            }
        })
        for e in evs:
            all_events.append({
                "event_id": e["event"]["id"],
                "event_name": e["event"]["name"],
                "open_date": e["event"].get("openDate", ""),
                "competition": c["competition"]["name"],
                "comp_id": comp_id,
                "market_count": e.get("marketCount", 0),
            })
    print(f"[events] challenger events in window: {len(all_events)}")

    # 4) For each event: get MATCH_ODDS market catalogue (totalMatched comes with it)
    markets = []
    for ev in all_events:
        cat = api("listMarketCatalogue", {
            "filter": {"eventIds": [ev["event_id"]], "marketTypeCodes": ["MATCH_ODDS"]},
            "maxResults": 5,
            "marketProjection": ["MARKET_START_TIME", "RUNNER_DESCRIPTION"],
        })
        for m in cat:
            markets.append({
                "market_id": m["marketId"],
                "event_id": ev["event_id"],
                "event_name": ev["event_name"],
                "competition": ev["competition"],
                "market_name": m.get("marketName"),
                "market_start": m.get("marketStartTime", ""),
                "total_matched": m.get("totalMatched", 0),
                "runners": [r["runnerName"] for r in m.get("runners", [])],
            })
        time.sleep(0.2)  # be gentle with the free delayed key

    print(f"[markets] MATCH_ODDS markets found: {len(markets)}")

    # 5) Real liquidity check via listMarketBook (totalMatched per market)
    usable = 0
    zero_liq = 0
    no_market = 0
    matched_vals = []
    market_ids = [m["market_id"] for m in markets]
    for i in range(0, len(market_ids), 25):  # batch of 25 max per call
        batch = market_ids[i:i + 25]
        books = api("listMarketBook", {
            "marketIds": batch,
            "priceProjection": {"priceData": ["EX_BEST_OFFERS"]},
        })
        by_id = {b["marketId"]: b for b in books}
        for m in markets:
            book = by_id.get(m["market_id"])
            if book is None:
                m["status"] = "no_book"
                no_market += 1
                continue
            tm = book.get("totalMatched", 0)
            m["status"] = book.get("status")
            m["total_matched"] = tm
            m["last_price_matched"] = book.get("lastPriceMatched")
            if tm > 0:
                usable += 1
                matched_vals.append(tm)
            else:
                zero_liq += 1
        time.sleep(0.2)

    # 6) Report
    print("\n" + "=" * 64)
    print("BETFAIR CHALLENGER COVERAGE SPIKE — RESULTS")
    print("=" * 64)
    print(f"window:                    {FROM} -> {TO}")
    print(f"challenger events on BF:   {len(all_events)}")
    print(f"  with MATCH_ODDS market:  {len(markets)}")
    print(f"  usable (matched > 0):    {usable}")
    print(f"  zero liquidity:          {zero_liq}")
    print(f"  no market/book:          {no_market}")
    if matched_vals:
        matched_vals.sort()
        n = len(matched_vals)
        med = matched_vals[n // 2] if n % 2 else (matched_vals[n // 2 - 1] + matched_vals[n // 2]) / 2
        print(f"matched volume:  min={matched_vals[0]:.0f}  median={med:.0f}  "
              f"max={matched_vals[-1]:.0f}  mean={sum(matched_vals)/n:.0f}")
        # how many have meaningful liquidity
        for thresh in (100, 500, 1000, 5000):
            cnt = sum(1 for v in matched_vals if v >= thresh)
            print(f"  matched >= {thresh:>5}: {cnt:>4} ({100*cnt/n:.0f}% of matched markets)")
    else:
        print("matched volume: none (no liquidity anywhere)")

    # 7) Dump raw detail for inspection
    out = {"window": {"from": FROM, "to": TO},
           "competitions": [{"id": c["competition"]["id"], "name": c["competition"]["name"]} for c in chal_comps],
           "events": all_events,
           "markets": markets}
    with open("betfair_probe_output.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\nraw detail written to betfair_probe_output.json")


if __name__ == "__main__":
    main()
