# Troop (static, public)

Paper-trading desk for Kalshi `KXBTC15M` 15-minute BTC up/down binary
("BTC price up in next 15 mins?"). Zero-build site — `index.html` +
`styles.css` + `app.js`, plus one Cloudflare Pages Function
(`functions/api/kalshi/[[path]].js`) that proxies Kalshi's public API with
CORS headers. No secrets, no database. Paper only — never places real trades.

This is the **public, shareable** version of the Troop desk. Each visitor gets
their own copy: paper ledger, rules, and graded calls live in the browser's
`localStorage`. Nothing is shared between visitors.

- Live data: Kalshi public trade API (via the same-origin proxy) + Coinbase
  spot & candles — no auth.
- Model: P(up) = Φ(d / (σ√m)) — Brownian, zero drift; tiers STRONG / SCALP /
  EARLY / DIRECTION. Full spec: [SPEC.md](SPEC.md).
- Tabs: Desk, Calls (graded vs official Kalshi settlement), Results, Guide
  ("How trading works"), Rules.

## Run locally

```bash
cd ~/workspace/rung-desk
npx wrangler pages dev .   # full local dev, Functions (Kalshi proxy) included
# open the URL wrangler prints
```

`python3 -m http.server` also serves the UI, but without the Pages Function the
Kalshi feed stays stale — use wrangler for a faithful local test.

## Deploy to Cloudflare Pages (public link)

Deploys as a zero-build static site **plus one Pages Function**
(`functions/api/kalshi/[[path]].js`) — a same-origin proxy for Kalshi's API,
which sends no CORS headers and therefore cannot be called from the browser
directly. **The proxy is required for live Kalshi data**; without it the app
loads but the feed stays stale (it tells you so on screen).

**Option A — connect a git repo (recommended, required for Functions):**
1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → select the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: `.` (or `/` — the repo root)
4. Deploy. Your site is live at `https://<project>.pages.dev`, Functions included.

**Option B — `wrangler` CLI:**
```bash
npx wrangler pages deploy .
```

**Option C — direct upload (dashboard drag-and-drop): NOT recommended.**
Uploads may not build the `functions/` directory, in which case the Kalshi
proxy is missing and the desk will show the feed-stale warning. Use A or B.

No environment variables or secrets needed. To use a custom domain, add it under the project's Custom domains tab.

## Notes

- The page must stay open for the 15-second tick loop, alerts, and auto-arm to run (mobile browsers can't background it).
- Settlement grades against Kalshi's official `result` after each window closes; before it's available the desk uses a labeled live-print estimate (spot-based, not official RTI).
- Unit tests: `node /tmp/test-desk.js` — model math verified against `rung-desk-strong-monitor/backtest_new_model.py`.
