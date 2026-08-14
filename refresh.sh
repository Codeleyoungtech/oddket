#!/usr/bin/env bash
# OddKet one-command refresh:
#   1. pull the latest fixtures + odds from The Odds API  (POST /api/ingest)
#   2. export fixtures to the model                              (export-fixtures.mjs)
#   3. run the real model on them                               (predict.py)
#   4. push predictions to the worker                           (POST /api/predictions/ingest)
#
# Usage:
#   ./refresh.sh                # full refresh (needs ODDS_API_KEY set)
#   ODDS_API_KEY=xxx ./refresh.sh
#
# Requires: worker running on :8787 (npm run serve:local / the dev servers), python venv built.

set -euo pipefail
cd "$(dirname "$0")"

WORKER="${WORKER:-http://localhost:8787}"
KEY="${ODDS_API_KEY:-}"

if [ -z "$KEY" ]; then
  echo "ODDS_API_KEY not set — pulling live fixtures will fail." >&2
  echo "Set it inline:  ODDS_API_KEY=yourkey ./refresh.sh" >&2
  exit 1
fi

echo "── 1/4 Pulling fixtures + odds from The Odds API ──"
curl -s -m 60 -X POST "$WORKER/api/ingest" | head -c 300; echo

echo "── 2/4 Exporting fixtures for the model ──"
(cd worker && node scripts/export-fixtures.mjs)

echo "── 3/4 Running the models (h2h-xgb-v3 + ou) ──"
(cd model && .venv/bin/python scripts/predict.py --data data/fixtures.json --market h2h)
(cd model && .venv/bin/python scripts/predict.py --data data/fixtures.json --market ou)

echo "── 4/4 Pushing predictions to the worker ──"
curl -s -m 30 -X POST "$WORKER/api/predictions/ingest" \
  -H 'Content-Type: application/json' -d @"model/output/predictions.json"; echo
curl -s -m 30 -X POST "$WORKER/api/predictions/ingest" \
  -H 'Content-Type: application/json' -d @"model/output/predictions_ou.json"; echo

echo "✅ Done. Hard-refresh the dashboard (http://localhost:3000)."
