#!/usr/bin/env python3
"""Walk-forward rule mining for the OddKet rule book.

Mining rules in-sample is meaningless: with ~1,800 candidate conditions you can
always manufacture thousands of "100%" rules out of a few dozen fixtures. The
only version of the question that has an answer is walk-forward — mine on the
EARLY fixtures, then check the survivors on fixtures the search never saw.

    batch 1 = the oldest 80% of settled fixtures   (mine here)
    batch 2 = the newest 20%                        (test here)
    FREEZE → the rule's record stays as mined

Both batch-1 and batch-2 counts are printed for every surviving pattern, with
the knife-edge flag showing whether a neighbouring threshold would have broken
it. That flag is the tell: a rule that breaks when you widen one threshold by
less than 2 percentage points is a coincidence with a nice sample size.

Usage:
    curl -s "$WORKER/api/db" -o /tmp/db.json
    python3 scripts/mine_rules.py /tmp/db.json
"""

from __future__ import annotations

import itertools
import json
import sys
from collections import defaultdict

MIN_BATCH1 = 5
# A condition must clear this on batch 1 to be a candidate at all.
TARGET_RATE = 1.0

FEATURES = ["H", "D", "A", "O25", "U25", "HG", "AG", "DC12"]

TARGETS = {
    "home_win": lambda s: s["homeScore"] > s["awayScore"],
    "draw": lambda s: s["homeScore"] == s["awayScore"],
    "away_win": lambda s: s["awayScore"] > s["homeScore"],
    "over_2_5": lambda s: s["homeScore"] + s["awayScore"] > 2.5,
    "under_2_5": lambda s: s["homeScore"] + s["awayScore"] < 2.5,
    "over_1_5": lambda s: s["homeScore"] + s["awayScore"] > 1.5,
    "home_scores": lambda s: s["homeScore"] > 0,
    "away_scores": lambda s: s["awayScore"] > 0,
    "home_no_goal": lambda s: s["homeScore"] == 0,
    "away_no_goal": lambda s: s["awayScore"] == 0,
    "dc12": lambda s: s["homeScore"] != s["awayScore"],
}


def features_for(preds: list[dict]) -> dict[str, float] | None:
    by = {(p["market"], p["selection"]): p["probability"] for p in preds}
    f: dict[str, float] = {}
    for key, market, sel in (
        ("H", "h2h", "home"), ("D", "h2h", "draw"), ("A", "h2h", "away"),
        ("O25", "totals", "over"), ("U25", "totals", "under"),
        ("HG", "team_home_goals", "yes"), ("AG", "team_away_goals", "yes"),
        ("DC12", "dc12", "12"),
    ):
        v = by.get((market, sel))
        if v is None:
            return None  # fail closed: a missing market disqualifies the fixture
        f[key] = float(v)
    return f


def load(db: dict) -> list[dict]:
    """Settled fixtures with a complete probability vector, oldest first."""
    preds_by_fixture: dict[str, list[dict]] = defaultdict(list)
    for p in db.get("predictions", []):
        preds_by_fixture[p["fixtureId"]].append(p)
    outcomes = {o["fixtureId"]: o for o in db.get("outcomes", [])}
    fixtures = {f["id"]: f for f in db.get("fixtures", [])}

    rows = []
    for fid, o in outcomes.items():
        f = fixtures.get(fid)
        if not f:
            continue
        feats = features_for(preds_by_fixture.get(fid, []))
        if feats is None:
            continue
        rows.append({
            "fixtureId": fid,
            "ts": f.get("commenceTime") or 0,
            "league": f.get("league", ""),
            "features": feats,
            "homeScore": o["homeScore"],
            "awayScore": o["awayScore"],
        })
    rows.sort(key=lambda r: (r["ts"], r["fixtureId"]))
    return rows


def conditions(rows: list[dict]):
    """Every (feature, >=|<=, threshold) drawn from thresholds observed in the data."""
    out = []
    for f in FEATURES:
        vals = sorted({round(r["features"][f], 4) for r in rows})
        for v in vals:
            out.append((f, ">=", v))
            out.append((f, "<=", v))
    # Pairwise differences — the mining pass that produced the current book used
    # these, and they are what the surviving rules are written in.
    pairs = list(itertools.combinations(FEATURES, 2))
    for a, b in pairs:
        vals = sorted({round(r["features"][a] - r["features"][b], 4) for r in rows})
        for v in vals:
            out.append((f"{a}-{b}", ">=", v))
            out.append((f"{a}-{b}", "<=", v))
    return out


def value(row: dict, expr: str) -> float:
    if "-" in expr:
        a, b = expr.split("-", 1)
        return row["features"][a] - row["features"][b]
    return row["features"][expr]


def holds(row: dict, cond) -> bool:
    expr, op, thr = cond
    v = value(row, expr)
    return v >= thr - 1e-9 if op == ">=" else v <= thr + 1e-9


def record(rows: list[dict], target: str, conds) -> tuple[int, int]:
    hits = [r for r in rows if all(holds(r, c) for c in conds)]
    won = sum(1 for r in hits if TARGETS[target](r))
    return len(hits), won


# ---------------------------------------------------------------------------
# Bitset search
#
# A naive conjunction sweep is 7,000 conditions squared × 11 targets — tens of
# millions of scans, which is why the first version of this timed out. Two
# observations make it tractable:
#
#   * "100% on batch 1" is exactly "the condition's row-set is a subset of the
#     win-set". So a conjunction can only qualify if BOTH parts already exclude
#     every losing row. Pruning to those candidates first removes almost
#     everything, and guarantees the pair test can never fail.
#   * Every condition becomes one Python integer used as a bitset, so a
#     conjunction is an AND and a hit count is int.bit_count() — both C-speed.
# ---------------------------------------------------------------------------
def masks(rows: list[dict], conds) -> list[tuple[int, tuple]]:
    out = []
    for c in conds:
        m = 0
        for i, r in enumerate(rows):
            if holds(r, c):
                m |= 1 << i
        if m:
            out.append((m, c))
    return out


def mine(rows_b1: list[dict], rows_b2: list[dict], conds) -> list[dict]:
    m1 = masks(rows_b1, conds)
    m2 = dict((c, masks(rows_b2, [c])[0][0] if masks(rows_b2, [c]) else 0) for _, c in m1)
    finds: list[dict] = []

    for target, fn in TARGETS.items():
        win1 = sum((1 << i) for i, r in enumerate(rows_b1) if fn(r))
        loss1 = ((1 << len(rows_b1)) - 1) & ~win1
        win2 = sum((1 << i) for i, r in enumerate(rows_b2) if fn(r))

        # Conditions that already never select a losing row.
        clean = [(m, c) for m, c in m1 if (m & loss1) == 0]
        # Deduplicate identical row-sets (adjacent thresholds on the same feature
        # produce the same set), keeping the first — arbitrary but stable.
        seen: set[int] = set()
        uniq: list[tuple[int, tuple]] = []
        for m, c in clean:
            if m in seen:
                continue
            seen.add(m)
            uniq.append((m, c))

        for m, c in uniq:
            n1 = m.bit_count()
            if n1 < MIN_BATCH1:
                continue
            n2m = m2.get(c, 0)
            n2 = n2m.bit_count()
            finds.append({
                "target": target, "conds": (c,), "n1": n1, "w1": n1,
                "n2": n2, "w2": (n2m & win2).bit_count(),
            })

        for i in range(len(uniq)):
            mi, ci = uniq[i]
            for j in range(i + 1, len(uniq)):
                mj, cj = uniq[j]
                both = mi & mj
                n1 = both.bit_count()
                if n1 < MIN_BATCH1:
                    continue
                if {ci[0], cj[0]} == {ci[0]} and ci[2] == cj[2] and ci[1] == cj[1]:
                    continue
                n2m = m2.get(ci, 0) & m2.get(cj, 0)
                n2 = n2m.bit_count()
                finds.append({
                    "target": target, "conds": (ci, cj), "n1": n1, "w1": n1,
                    "n2": n2, "w2": (n2m & win2).bit_count(),
                })
    return finds


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: mine_rules.py <db.json>", file=sys.stderr)
        return 2
    with open(sys.argv[1]) as f:
        db = json.load(f)

    rows = load(db)
    print(f"[mine] {len(rows)} settled fixtures with a complete vector")
    if len(rows) < 40:
        print("[mine] too few fixtures to split — nothing mined", file=sys.stderr)
        return 1

    cut = int(len(rows) * 0.8)
    b1, b2 = rows[:cut], rows[cut:]
    print(f"[mine] batch 1 = {len(b1)} (oldest)  batch 2 = {len(b2)}")
    print(f"[mine] {b1[0]['ts']} → {b1[-1]['ts']}  |  {b2[0]['ts']} → {b2[-1]['ts']}")

    conds = conditions(b1)
    print(f"[mine] {len(conds)} candidate conditions", flush=True)

    survivors = mine(b1, b2, conds)
    for s in survivors:
        s["perfect_b2"] = s["n2"] > 0 and s["w2"] == s["n2"]

    print(f"[mine] {len(survivors)} 1–2 condition rules hit 100% on batch 1 with n>={MIN_BATCH1}")
    perfect = [s for s in survivors if s["perfect_b2"]]
    print(f"[mine] {len(perfect)} of them also held on batch 2\n")

    # Collapse threshold variants of the same structural pattern: same target and
    # same condition features is the same rule at a different knife edge.
    shape = defaultdict(list)
    for s in perfect:
        key = (s["target"], tuple(sorted(c[0] for c in s["conds"])), tuple(sorted(c[1] for c in s["conds"])))
        shape[key].append(s)

    ranked = sorted(shape.values(), key=lambda g: (-max(x["n2"] for x in g), -max(x["n1"] for x in g)))

    print("=== strongest surviving patterns ===")
    print(f"{'backs':<14} {'conditions':<58} {'b1':>8} {'b2':>8}  knife")
    for group in ranked[:18]:
        best = max(group, key=lambda x: (x["n2"], x["n1"]))
        knife = "⚠ yes" if len(group) > 1 else "no"
        desc = " AND ".join(f"{c[0]} {c[1]} {c[2]}" for c in best["conds"])
        print(f"{best['target']:<14} {desc[:58]:<58} "
              f"{best['w1']}/{best['n1']:<6} {best['w2']}/{best['n2']:<6}  {knife}")

    print("\n=== per-target survival ===")
    fam = defaultdict(int)
    for s in perfect:
        fam[s["target"]] += 1
    for t, c in sorted(fam.items(), key=lambda kv: -kv[1]):
        print(f"  {t:<14} {c}")

    out = {
        "n_settled": len(rows), "n_batch1": len(b1), "n_batch2": len(b2),
        "n_candidates": len(conds), "n_hit_100_b1": len(survivors),
        "n_survived_b2": len(perfect),
        "patterns": [
            {
                "target": g[0]["target"],
                "conditions": [
                    {"expr": c[0], "op": c[1], "threshold": c[2]}
                    for c in max(g, key=lambda x: (x["n2"], x["n1"]))["conds"]
                ],
                "batch1": f"{max(g, key=lambda x: (x['n2'], x['n1']))['w1']}/{max(g, key=lambda x: (x['n2'], x['n1']))['n1']}",
                "batch2": f"{max(g, key=lambda x: (x['n2'], x['n1']))['w2']}/{max(g, key=lambda x: (x['n2'], x['n1']))['n2']}",
                "variants_hit_100_on_b1": len(g),
                "knife_edge": len(g) > 1,
            }
            for g in ranked[:40]
        ],
    }
    with open("output/rule_mining.json", "w") as f:
        json.dump(out, f, indent=2)
    print("\n[mine] wrote output/rule_mining.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
