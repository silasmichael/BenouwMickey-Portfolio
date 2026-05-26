# Portfolio Tracker — Handoff Document

## What This Is

Personal investment tracker for Tanzania capital markets. Three-file app. Dark theme. Built for iPad Safari but works on desktop and mobile.

-----

## File Structure (Netlify Deployment)

```
your-project/
├── index.html       ← HTML structure + all modals
├── style.css        ← all styles
├── app.js           ← all logic (~4200 lines)
└── netlify.toml     ← Netlify config
```

The price scraper runs as a **Supabase Edge Function** — not Netlify. There is no `netlify/edge-functions/` folder.

-----

## Backend — Supabase

- **URL:** `https://brwkhnqnsoormvpjqcmd.supabase.co`
- **Auth email:** `silasmichael27@gmail.com`
- **Table:** `portfolio` — columns: `id, stocks, funds, snapshots, updated_at`
- **Row:** always row `id = 1` — everything in one row
- **Auth:** magic link (email login, no password)
- **Sync:** raw `fetch` PATCH with Bearer JWT — never use SDK `.from().upsert()`
- **Guard:** `_dataReady` flag in `persist()` — prevents data wipe on fresh load
- **Migration:** `_snapV: 3` — already ran, never re-run

### localStorage Cache

- Key: `portfolio_cache_v1`
- Saved after every successful Supabase read and after Update Prices
- Loaded instantly on open so app renders before Supabase responds
- Does **not** store `priceDate` — price dates now live in `snapshots._priceDates` (see below)

-----

## Price Dates — `snapshots._priceDates`

Per-asset price timestamps. Stored inside `snapshots` so they persist to Supabase automatically.

```json
{
  "CRDB": "2026-05-23T10:14:00.000Z",
  "NMB":  "2026-05-23T10:14:00.000Z",
  "igrowth": "2026-05-21T08:00:00.000Z"
}
```

- Written by `syncLivePrices()` for every key returned by the edge function
- Written by `_markPriceKeyUpdated(key)` on every manual price edit
- Read by `setPriceButtonState()` to determine button color
- `applyMigrations()` seeds `{}` if missing (safe for existing data)

### Update Prices Button States

|State                 |Color      |Condition                                                            |
|----------------------|-----------|---------------------------------------------------------------------|
|Green “Updated”       |`var(--g)` |All stock + fund IDs have a date matching the most recent trading day|
|Amber “Partial Update”|`var(--a)` |Some but not all keys updated today. Button stays clickable          |
|Faint “Update Prices” |transparent|No prices updated on most recent trading day                         |

**Weekend behaviour:** `getMostRecentTradingDay()` returns Friday’s date on Saturday and Sunday. A Friday full update stays green all weekend.

-----

## Price Fetcher — Supabase Edge Function

- **Function name:** `get-prices`
- **Deployed via:** Supabase dashboard → Edge Functions
- **URL:** `https://brwkhnqnsoormvpjqcmd.supabase.co/functions/v1/get-prices`
- **Auth:** `Authorization: Bearer SB_KEY` (publishable key already in app.js)
- **Runtime:** Deno (Supabase default)
- **Library:** `npm:cheerio` for HTML parsing
- **Scraper:** ScrapingAnt — key `2ed2c94e38c547218b36afe7e3f695f0` — 10,000 credits/month free, renews monthly
- **Mansa Markets API:** key `mansa_wtltg9x2ffc2wakm` — fallback for stocks only (prices may lag)

### ⚠️ Sequential Fetches — Do Not Parallelize

ScrapingAnt free tier allows only **1 concurrent request**. The three scraper calls run **sequentially**, not via `Promise.allSettled`. Switching back to parallel will silently drop 2 of 3 requests.

### Sources

|Source                                     |Method                                        |Notes                                                                  |
|-------------------------------------------|----------------------------------------------|-----------------------------------------------------------------------|
|DSE stocks (CRDB, NMB, SWIS, NICOL, IEACLC)|ScrapingAnt → `itrust.co.tz/today-market`     |Next.js page, requires JS render                                       |
|iGrowth NAV                                |ScrapingAnt → `itrust.co.tz/services/i-invest`|JS-rendered, NAV between 50–600                                        |
|UTT AMIS (Umoja, Liquid)                   |ScrapingAnt → `uttamis.co.tz/fund-performance`|JS-rendered, NAV at column index 4 — fragile if table structure changes|

### Return Keys

`CRDB`, `NMB`, `SWIS`, `NICOL`, `IEACLC`, `igrowth`, `umoja`, `liquid`, `_igrowthDate`

### Mansa Fallback (Stocks Only)

If iTrust scrape fails to return any of CRDB / NMB / SWIS / NICOL, the edge function calls:

```
GET https://www.mansaapi.com/api/v1/stocks?exchange=DSE
Header: x-api-key: mansa_wtltg9x2ffc2wakm
```

**Note:** Mansa prices may not be same-day. Treat as emergency fallback only. IEACLC is not on Mansa — no fallback exists for it.

### Manual Update Only

- UTT AMIS Liquid and Umoja — JS-rendered, regex sometimes fails
- iGrowth — PDF factsheets at `itrust.co.tz` for full data
- Update manually by tapping ✏️ Update on each fund card

### Credit Usage

Each Update Prices click = 3 ScrapingAnt requests × 10 credits = **30 credits**. 10,000 monthly credits = ~333 update clicks per month.

-----

## Current Holdings

**Stocks (DSE Tanzania):**

|ID    |Name              |Type    |
|------|------------------|--------|
|CRDB  |CRDB Bank         |bank    |
|NMB   |NMB Bank          |bank    |
|NICOL |NICOL Holdings    |holding |
|SWIS  |Swissport Tanzania|aviation|
|IEACLC|IEACLC ETF        |etf     |

**Funds:**

|ID     |Manager       |Type        |
|-------|--------------|------------|
|igrowth|iTrust Finance|iGrowth Fund|
|umoja  |UTT AMIS      |Umoja Fund  |
|liquid |UTT AMIS      |Liquid Fund |

**Reserves:** M-Wekeza (13% p.a.) and any liquid money market accounts

**Bonds:** Tab exists, no holdings yet. Stored in `snapshots._bonds`

-----

## Tabs

1. **Overview** — P&L strip, pie charts, portfolio value chart, target goal card
1. **Stocks** — expandable cards, metrics bar, fundamentals editing, tranche history
1. **Funds** — fund cards with NAV, gain/loss, tranche history
1. **Bonds** — bond cards
1. **Reserves** — reserve accounts with interest tracking
1. **Projection** — future value projections with monthly planning
1. **Planner** — Buy Calculator (DCA), Sell Calculator, Fundamentals reference

-----

## Commission Tiers (DSE)

|Trade Value     |Rate |
|----------------|-----|
|≤ TSh 10,000,000|2.06%|
|TSh 10M – 50M   |1.86%|
|> TSh 50M       |1.16%|

-----

## Stock Card — Metric System

Each stock has a `type` field. `computeMetrics()` is type-aware:

|Type    |Metrics Shown                               |
|--------|--------------------------------------------|
|bank    |P/E, P/B, ROE, ROA, NIM, NPL, CIR, Div Yield|
|holding |P/NAV, NAV Discount, ROE, D/E, Div Yield    |
|aviation|Altman Z, EV/EBITDA, D/E                    |
|etf     |Current NAV, P/NAV, vs Launch               |

-----

## Signal Color Map

|Signal     |Color|
|-----------|-----|
|STRONG BUY |Green|
|BUY        |Green|
|ACCUMULATE |Green|
|HOLD & ADD |Blue |
|STRONG HOLD|Amber|
|HOLD       |Pink |
|WATCH      |Cyan |
|SELL       |Red  |

-----

## Fund Cards

- **Purpose pill** — auto-colored from `PURPOSE_PALETTE` by fund index
- **Signal pill** — colored by `fn.signal` using the signal color map
- **Tap badge row** → opens fund meta modal to edit purpose and signal

-----

## Planner Tab

### Buy Calculator (DCA)

Select stock → enter amount → optional custom price.
Shows: shares you’d receive, new avg buy price, new total position.

### Sell Calculator

Select stock → optional custom sell price → shares mode or target amount mode.
Shows: gross proceeds, DSE commission tier, net after commission, cost basis, capital gain/loss, WHT (10% on profit only), net cash received, realised profit.

**Target mode:** binary search finds minimum shares to sell to receive a target amount after all deductions.

-----

## Key Functions

|Function                           |What it does                                                                                         |
|-----------------------------------|-----------------------------------------------------------------------------------------------------|
|`persist()`                        |Saves to Supabase (debounced 800ms)                                                                  |
|`syncToSupabase()`                 |Raw PATCH to Supabase row id=1. Waits 1.5s if token is null                                          |
|`syncFromSupabase()`               |Loads on auth. Retries: 3s→8s→20s→30s                                                                |
|`applyMigrations(s,f)`             |Seeds missing fields only — never overwrites Supabase values. Also seeds `snapshots._priceDates = {}`|
|`renderAll()`                      |Calls all render functions                                                                           |
|`getOpenIds()` / `restoreOpenIds()`|Saves/restores expanded card state around re-renders                                                 |
|`computeMetrics(s)`                |Returns metrics object based on stock type                                                           |
|`syncLivePrices()`                 |Calls edge function sequentially, updates `snapshots._priceDates` per key, saves to Supabase         |
|`buildPortfolioChart()`            |Renders SVG line chart from monthly snapshots                                                        |
|`loadFromCache()`                  |Reads localStorage, renders instantly, sets border grey                                              |
|`saveToCache()`                    |Writes localStorage — no params, `snapshots._priceDates` serializes with snapshots automatically     |
|`setPriceButtonState()`            |No params. Reads `snapshots._priceDates` + `getMostRecentTradingDay()` to determine green/amber/faint|
|`getMostRecentTradingDay()`        |Returns last Mon–Fri date string. Sat/Sun both return Friday                                         |
|`_markPriceKeyUpdated(key)`        |Called on manual price edit. Writes ISO date to `snapshots._priceDates[key]`, re-evaluates button    |
|`showToast(msg, isError)`          |Toast notification                                                                                   |
|`pickStockSignal(sig)`             |Highlights selected signal pill in stock Edit Fundamentals                                           |
|`pickFundSignal(prefix, sig)`      |Highlights selected signal pill in fund modals                                                       |
|`updateMonthlySnapshots()`         |Runs before every save. Calculates portfolio value for past+current months                           |
|`sellUpdate()`                     |Recalculates sell result including commission, WHT, realised profit                                  |
|`dcaUpdate()`                      |Recalculates buy scenario                                                                            |

-----

## Header

- **Left:** “Tanzania Capital Markets” label + “Michael’s Portfolio” + price timestamp
- **Left border color:** grey = syncing, green = Supabase confirmed, red = error, amber = offline
- **Right:** Portfolio Value + P&L + buttons
- **Mobile:** buttons move to full-width strip at top of page

-----

## Critical Rules — Never Break

1. Auth flow (magic link + `onAuthStateChange`) — do not touch
1. Raw fetch PATCH in `syncToSupabase` — never switch to SDK `.from().upsert()`
1. `_dataReady` guard in `persist()` — never remove
1. `_snapV: 3` migration — already ran, never re-run
1. `applyMigrations` — only seeds missing fields, never overwrites existing Supabase values
1. `getOpenIds()` / `restoreOpenIds()` — must wrap every function that calls `renderAll()` after a user action
1. Safari/iPad: no nested template literals — use string concatenation inside template literals
1. `SEED_STOCKS = []` and `SEED_FUNDS = []` — intentionally empty, do not repopulate
1. `syncLivePrices` uses GET with `Authorization: Bearer SB_KEY` — no Content-Type header
1. Edge function fetches must remain **sequential** — ScrapingAnt free tier = 1 concurrent request

-----

## Known Issues / To Do

- UTT AMIS NAV column index (`eq(4)`) is hardcoded — will break silently if UTT AMIS restructures their table
- NICOL fundamentals: not from real audited report — update when report available
- Bonds tab: UI works, no holdings added yet
- Existing funds may need `purpose` field added via fund meta modal (tap badge row on each card)