# OddKet Deployment Runbook

Deploying OddKet so the **paper-trade loop runs without your laptop**:

- **Cloudflare Workers + D1** hosts the API, the database, and the cron jobs
  (odds pulls + closing-odds/CLV).
- **Vercel** hosts the dashboard (Next.js). It auto-deploys from GitHub.
- **GitHub Actions** runs the Python model daily in the cloud and pushes
  predictions to the worker.

---

## 0. Push the code (once)

```bash
git push origin main
```

Your remote is `git@github.com:Codeleyoungtech/oddket`. The push is ~5 MB
compressed (one-time; later pushes only send changes).

---

## 1. Cloudflare Worker + D1

Prereqs: a free Cloudflare account and wrangler installed:

```bash
npm i -g wrangler
wrangler login
```

### 1.1 Create the D1 database

```bash
cd worker
npx wrangler d1 create oddket
```

It prints a `database_id` — paste it into `worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "oddket"
database_id = "PASTE_HERE"
```

### 1.2 Set secrets

```bash
npx wrangler secret put ODDS_API_KEY        # your The Odds API key
npx wrangler secret put PREDICT_SECRET      # any long random string — share with GitHub Actions
npx wrangler secret put DASHBOARD_ORIGIN    # https://your-app.vercel.app (after step 2)
```

`PREDICT_SECRET` protects `/api/predictions/ingest` so strangers can't push
fake predictions. `DASHBOARD_ORIGIN` lets the deployed dashboard call the API.

### 1.3 Apply migrations + deploy

```bash
npx wrangler d1 migrations apply oddket --remote
npx wrangler deploy
```

The crons go live automatically:
- `09:00` & `18:00` UTC — odds ingestion
- `18:30` UTC — closing-odds pull → **CLV measurement for logged bets**

Verify: open `https://<your-worker>.workers.dev/api/health` → `{"ok":true,...}`.

> **Cost note:** free tier — D1, Worker requests, and 3 crons/day are all
> within Cloudflare's free limits. The Odds API stays under ~200 req/month.

---

## 2. Vercel dashboard

1. Push the repo to GitHub (done above).
2. In Vercel, **Add New Project** → import `Codeleyoungtech/oddket`.
3. Settings (Vercel auto-detects Next.js; set these to be safe):
   - Root Directory: `apps/web`
   - Build Command: `pnpm build`
   - Install Command: `pnpm install`
4. Environment variable:
   - `NEXT_PUBLIC_API_URL` = `https://<your-worker>.workers.dev`
5. **Deploy.**

After deploy, add the Vercel URL as the worker's `DASHBOARD_ORIGIN` secret:

```bash
cd worker && npx wrangler secret put DASHBOARD_ORIGIN
# paste: https://your-app.vercel.app
```

---

## 3. GitHub Actions predictions

The workflow `.github/workflows/predict.yml` runs daily at 08:05 UTC:
fetch fixtures from the worker → run the model (h2h + totals) → push
predictions back.

Add two **repo secrets** (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `ODDKET_WORKER_URL` | `https://<your-worker>.workers.dev` |
| `PREDICT_SECRET` | same value you set on the worker |

Test it once with the **"Run workflow"** button (Actions → Predict → Run
workflow). Then verify the dashboard shows slips for upcoming fixtures.

---

## 4. The paper-trade loop (what this all enables)

1. Dashboard (deployed) → **Slip Builder** → **Log bet** on picks you like.
2. The `18:30` cron pulls **closing odds** for your logged bets → CLV accrues.
3. When matches finish, the worker **settles** bets automatically (won/lost + P&L).
4. After ~100–200 logged bets, the **Calibration** and **CLV** pages tell you
   whether the edge is real.

---

## 5. Troubleshooting

- **`/api/health` unreachable** → did you `wrangler deploy` after changing
  wrangler.toml? The `database_id` must be set.
- **Dashboard shows demo data** → `NEXT_PUBLIC_API_URL` is wrong/empty, or the
  worker's CORS doesn't include your Vercel origin (check `DASHBOARD_ORIGIN`).
- **Predictions missing on the slip builder** → run the Actions workflow
  manually; check the workflow log for `unknown team` skips.
- **CLV empty** → CLV needs a bet logged *before* the 18:30 closing pull and
  a fixture that still has odds. New bets show CLV the next evening.
- **Cron failures** → `wrangler tail` to watch live logs.
