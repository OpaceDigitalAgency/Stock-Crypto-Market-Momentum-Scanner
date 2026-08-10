# Pulseboard — Stock & Crypto Market Momentum Scanner

A free, open-source momentum scanner, trade planner and practice journal for US stocks and crypto. Open it and live data is already flowing: the fastest-moving US shares and the busiest Binance pairs, ranked, scored against a five-pillar momentum checklist, and ready to turn into a fully sized practice trade plan.

**Practice only.** Pulseboard never places orders, never connects to a brokerage account, and nothing in it is financial advice. It exists to help you learn a repeatable process in a simulator before any real money is involved.

## Features

### Instant discovery, no API keys
- **Stocks:** live US gainers merged from public Yahoo Finance screens, refreshed continuously, with price, day gain, relative volume (versus the 3-month average), total volume and shares in issue.
- **Crypto:** whole-market Binance discovery over public WebSockets, with 5-minute / 1-hour / 24-hour momentum, activity versus recent norm, order-book depth, spread, and a live Coinbase price cross-check.
- Catalyst checking against official SEC filings and Nasdaq trading-halt notices for the top stock candidates.

### A five-pillar quality checklist
Every candidate is scored against the classic momentum day-trading pillars: percentage gain, relative volume, price range, share supply, and a confirmed catalyst. Each card shows exactly which pillars pass, fail or are unknown — the app never pretends missing data is a pass.

### Pullback pattern detection
One-minute candles drive an automatic reading of the setup: retracement depth, green-versus-red volume, VWAP and 9-EMA position, topping tails, and whether the latest candle is breaking higher. The verdict is a plain sentence: *entry*, *wait*, or *avoid* — with a suggested stop at the pullback low.

### Risk-first trade planning
Enter a price, a stop and the most you are willing to lose; Pulseboard calculates position size and a 2R/2.5R/3R target, and refuses to size a trade without a valid stop.

### A journal that coaches
Every practice trade is stored locally in your browser. The journal computes accuracy, average winner versus average loser, green weeks, and a 14-day calendar — and it enforces discipline: a configurable daily loss limit, a warning when you hand back half of the day's gain, a nudge when the best trading hours are over, and one-tap logging of disciplined no-trade days.

### Simple and Advanced modes
One toggle switches the entire interface:
- **Simple** — plain-English cards and sentences ("Only a small number of shares exist", "Your get-out price") for anyone with basic trading experience.
- **Advanced** — dense ranked tables, full filters and technical labels (RVol, VWAP, 9 EMA, topping tails) for experienced scanners.

### Built for the session
A New York session strip shows the market phase, the current time, and the 7–10 a.m. ET prime momentum window at a glance. Optional audio chime when a new qualifying candidate appears.

## Quick start

Requirements: Node.js 20+.

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:4173`. Stock and crypto data load immediately — the dev server includes the same `/api` routes used in production.

Run the test suite, strict TypeScript compile and production build:

```bash
npm run check
```

## Deploy to Netlify

The app is a static Vite build plus three serverless functions (stock screens, candles, catalysts). `netlify.toml` carries the build settings and security headers.

1. Fork or clone this repository and connect it to a new Netlify site.
2. Build command `npm run build`, publish directory `dist` (already configured).
3. Optional: set `SEC_USER_AGENT` (a product name plus contact email) to enable SEC catalyst checks — without it, catalyst status shows as unchecked rather than failing.

No other configuration is needed. Data flows the moment the site loads.

## How it works

| Layer | Detail |
|---|---|
| Frontend | Vite + strict TypeScript, no framework, one small CSS file. Dark, responsive, keyboard-accessible, reduced-motion aware. |
| Stock data | Netlify Function proxies public Yahoo Finance gainer screens and 1-minute charts, with host fallback, short-lived caching and stale-serving under rate limits. |
| Crypto data | Browser connects directly to Binance's public WebSocket ticker and REST klines/depth, with a Coinbase Advanced Trade WebSocket price check. Feeds fail closed on silence. |
| Catalysts | Netlify Function queries SEC EDGAR full-text search and the Nasdaq trading-halt feed, returning linked official evidence only. |
| Storage | Journal, preferences and no-trade days live in `localStorage`; one-click JSON export. Nothing leaves your browser. |

## Honest-data principles

- Coverage is always labelled: Binance activity is Binance activity, not global volume; shares in issue stand in for float and are labelled as such.
- Unknown values score zero rather than passing silently.
- Delayed or off-hours quotes are labelled, and empty states say why they are empty.
- The app has no order, transfer or withdrawal code path of any kind.

## Keywords

Stock scanner · crypto scanner · momentum trading · day trading practice · relative volume screener · low float stocks · pullback pattern · VWAP · trading journal · risk management calculator · paper trading · Binance movers · US stock gainers.

## Licence

MIT — see [LICENSE](LICENSE).
