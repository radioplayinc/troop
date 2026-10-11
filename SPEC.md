# Troop — Static Rebuild Spec

Paper-trading desk for Kalshi `KXBTC15M` 15-minute BTC **up/down binary**
("BTC price up in next 15 mins?"). Single static site (HTML/CSS/JS, no
backend, no secrets) + one Cloudflare Pages Function proxy for Kalshi.
All state in `localStorage` — each visitor gets their own copy.
Deploy target: Cloudflare Pages (public link).

## Contract

One binary per 15-minute ET window (windows open/close on ET quarter-hours).
YES wins iff the final 60-second CF Benchmarks RTI average is **>=** the
opening 60-second RTI average. Event ticker encodes the ET end time:
`KXBTC15M-YYMMMDDHHMM` (e.g. `KXBTC15M-26OCT110430`).

The tradable line = the **window-open price** = close of the Coinbase 1-min
candle immediately before the window opens. Fetched once per window from the
Coinbase Exchange candles API and LOCKED for the window. Only the window's
*change* matters, so any stable Coinbase-vs-RTI level gap cancels out.

## Data sources (all public, no auth)

- Kalshi: `https://api.elections.kalshi.com/trade-api/v2` **via the
  same-origin proxy** `/api/kalshi` (`functions/api/kalshi/[[path]].js` —
  Kalshi sends no CORS headers, so the browser cannot call it directly).
  - `GET /markets?event_ticker=<TICKER>` → `markets[0]`: `ticker`,
    `title` (must contain "up in next 15 mins"), `yes_ask_dollars` /
    `no_ask_dollars` (dollars), `result` ("yes"/"no"), `expiration_value`,
    `close_time`.
  - `GET /markets/<TICKER>/orderbook` → resting bids; taker ask on a side =
    1 − best opposing bid.
- Coinbase spot: `https://api.coinbase.com/v2/prices/BTC-USD/spot` (tick loop).
- Coinbase candles: `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60`
  (sends `access-control-allow-origin: *`; used for the window-open price and
  the trailing-5h volatility). If unreachable, the desk falls back to labeled
  estimates (first window print for the line, 5 bps/min for sigma).
- Tick loop: every 15 seconds. Without the proxy deployed the desk shows a
  feed-stale warning naming the fix (`npx wrangler pages deploy` or a
  Git-connected Pages project).

## Core model (exact — verified against backtest_new_model.py)

```
d      = (spot - c_open) / c_open      # relative distance from window-open price
sigma  = max(std(trailing 5h 1-min log returns, strictly before open), 0.0002)
z      = d / (sigma * sqrt(m))         # m = minutes left, z clamped to [-6, 6]
P(up)  = Phi(z)                        # standard normal CDF (Brownian, zero drift)
side   = HIGHER if P >= 0.5 else LOWER
conf   = max(P, 1 - P)
```

## Tiers (match the monitor's check.py + EARLY)

- **STRONG**: conf ≥ 90%, ≥ 2 min left → 97.1% hit (n=1,332, 7d backtest)
- **SCALP**: 2–5 min left, 65% ≤ conf < 90% → 90.8% (n=993)
- **EARLY**: 8–14 min left, conf ≥ 75%, calm filter (trailing-15-min spot range ≤ 18 bps)
- **DIRECTION**: 2–5 min left, 55% ≤ conf < 65% → 70.1% (n=355), informational only
- Below 55%: coin flip — no alert. Priority STRONG > SCALP > EARLY > DIRECTION.
- One alert per tier per window per side (dedup); sound toggle.

## Fees and the 1.1× rule

Kalshi taker fee per contract: `ceil(7·p·(1−p))/100` dollars, p = entry in
dollars. Fee-aware net payout multiple = `$1 / (entry + fee)`, adjustable
"Min net payout" (default **1.1×**) — true 1.1× after fees needs entry ≤ ~90¢.
Signals, tickets, and the calculator show quoted AND fee-aware multiples.
Manual arms below the bar ask for confirmation; auto-arm skips sub-bar entries.

## ENTRY CLOSED (exact label, with reason)

- Price-based side lock: signaled side's ask ≥ 98¢ (adjustable "side locked at").
- Time backstop: under 3 min left (adjustable).
- No resting ask on the signaled side → "no ask available".
No buy alerts and no auto-arm (manual arm blocked with the reason) while
closed; the model and banner keep running.

## Language and banner

Arrow-first everywhere: **▲ Buy OVER** (= buy YES) / **▼ Buy UNDER** (= buy NO)
— never lead with YES/NO. The banner always shows the highest-probability
direction, even when gates say PASS; a separate signal row shows the tier fire
(`STRONG ▼`) or `PASS · <blocking reason>`. A fired tier shows the live ask
and a walk-away ceiling (model fair value − 3¢ edge bar). Once armed, the
banner locks to the position side and arm-time read; a confirmed live-read
flip fires an EXIT alert.

## Paper trading (localStorage)

- Bankroll $1,000 default, adjustable. Stake pills 10%/25%/50%/custom (uncapped).
- Auto-arm (OFF default): 1 position per window max, never in the final 2 min,
  skips sub-1.1× entries and ENTRY CLOSED.
- Settlement: official Kalshi `result` via the proxy after close; labeled
  live-print estimate fallback (spot-based — NOT official RTI). Reload/rollover
  protection: open positions restore on reload and settle on window rollover.
- Results tab: bankroll, P&L, equity curve, tier splits, DESK/MANUAL splits,
  streaks, recent trades.
- Calls tab: every fired tier signal logged (ticker, tier, conf, side, entry
  ask) and graded vs the official settlement; DESK = tier signal, MANUAL =
  discretionary arm. Fee-aware P&L throughout.

## Campaign mode ($1 → $1,000, opt-in, default OFF)

STRONG-only, last 5 min, ≤90¢ fee-aware entry gate, base-risk % of a separate
campaign bankroll, 25% profit banking at each doubling milestone, kill-switch:
2 consecutive losses or −20% day = stand down until next ET day.

## Style

Troop branding: warm paper + charcoal, no gradients, gorilla mark. Green =
HIGHER, red = LOWER. Phone-first, works on desktop.
