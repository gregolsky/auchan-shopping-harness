# /zakupy Performance Benchmarks

Measurements taken against live `zakupy.auchan.pl` on 2026-06-13.
Each entry records: approach description, per-item timing breakdown, and 10-item list estimate.

---

## Methodology

- **Navigation time** (~1500 ms): constant across all approaches; `navigate_page` waits for full page load.
- **Page load breakdown** (measured via `initScript` probe on `/search?q=ser`):
  - DOM buttons visible (SSR HTML parsed progressively): **659 ms** after nav start
  - `DOMContentLoaded`: **1632 ms**
  - `__INITIAL_STATE__` products available: **1683 ms** (script tag at end of HTML)
- **Cart API** (`POST /api/cart/v1/carts/active/apply-quantity`): avg **144 ms** (3-call sample: 148, 134, 149 ms)
- **State read + score** (reading `productEntities`, sorting, picking winner): **0.34 ms** avg (10 runs)
- **DOM parse + score** (innerText regex on 5 tiles): **1.09 ms** avg (10 runs)
- **Stepper click debounce**: 70 ms per click; qty=3 adds 140 ms, qty=5 adds 280 ms
- **`take_snapshot` call**: ~400 ms (not measured here; excluded from new path)

All times are wall-clock ms measured with `performance.now()` inside `evaluate_script`.

---

## [v1] Baseline — DOM polling + click + stepper (pre-optimization)

**Approach:** `navigate_page('/search?q=…')` → poll for `button[aria-label*="Dodaj produkt"]` (150 ms interval, up to 8 s) → parse `innerText` for prices → `click()` add button → `click()` stepper N−1 times @ 70 ms debounce → `take_snapshot` every 5 items for checkpoint.

| Component | Time (ms) |
|---|---|
| navigate_page (page load) | ~1500 |
| DOM poll wait (avg half-interval after load) | ~75 |
| DOM text parse + score (5 tiles) | ~1 |
| click() + cart animation | ~200 |
| take_snapshot amortized (/5 items) | ~100 |
| **Per-item total (qty=1)** | **~1876** |
| **Per-item total (qty=3)** | **~2016** (+140 ms stepper) |
| **Per-item total (qty=5)** | **~2156** (+280 ms stepper) |

**10-item list estimate (qty=1):** ~18.8 s  
**10-item list estimate (mixed qty 1–3):** ~20 s

**Limitations:**
- Price extraction via regex on `innerText` fails silently when layout changes (known pitfall).
- Stepper time grows linearly with quantity.
- `take_snapshot` adds ~400 ms every 5 items (structural DOM serialization).
- No UUID stored → every run is a full search, no fast path possible.

---

## [v2] State read + cart REST API + UUID cache (2026-06-13)

**Approach A — search (first run or stale cache):**  
`navigate_page('/search?q=…')` → `evaluate_script` reads `window.__INITIAL_STATE__.data.products.productEntities` (SSR JSON, zero polling) → score in JS → `fetch('/api/cart/v1/carts/active/apply-quantity', {quantity: N})` (quantity in one call, no stepper).

**Approach B — direct add (UUID cached from prior run):**  
`evaluate_script` calls cart API directly from current page — **no navigation at all**.

| Component | Search path (ms) | Cached UUID path (ms) |
|---|---|---|
| navigate_page | ~1500 | 0 (skip) |
| State read + score | 0.34 | 0 (skip) |
| Cart API fetch (any qty) | 144 | 144 |
| **Per-item total (qty=1)** | **~1645** | **~144** |
| **Per-item total (qty=3)** | **~1645** | **~144** |
| **Per-item total (qty=5)** | **~1645** | **~144** |

**10-item list estimate, all search:** ~16.5 s  
**10-item list estimate, 50% cached (typical repeat shop):** ~8.2 s + ~0.7 s = **~9 s**  
**10-item list estimate, all cached (stable weekly list):** **~1.4 s**

### Speedup vs v1

| Scenario | v1 | v2 | Speedup |
|---|---|---|---|
| 10 items, first run (qty=1) | 18.8 s | 16.5 s | 1.1× |
| 10 items, first run (qty=3) | 20 s | 16.5 s | 1.2× |
| 10 items, 50% UUID cached | 20 s | 9 s | **2.2×** |
| 10 items, all UUID cached | 20 s | 1.4 s | **14×** |
| Single item, qty=5 | 2.16 s | 1.65 s (search) / 0.14 s (cached) | 1.3× / **15×** |

### Additional reliability gains (not in timing)
- Price/size from structured JSON — no regex failure on layout changes.
- Quantity set atomically in API body — no stepper race conditions.
- `take_snapshot` removed from hot path — saves ~400 ms every 5 items.
- Score uses `price.unit.current.amount` (accurate unit price) vs innerText parse (often missing).

---

## Raw measurement data (2026-06-13)

```
query: ser (33 products in state)
stateReadAndScore_avgMs: 0.34  (10 runs)
domParseAndScore_avgMs:  1.09  (10 runs)
cartApiCalls:
  Ser mozzarella Auchan → 148 ms (HTTP 200)
  Ser Gouda Auchan 500g → 134 ms (HTTP 200)
  Ser camembert Auchan  → 149 ms (HTTP 200)
cartApi_avgMs: 144 ms

query: masło (33 products in state)
chosen (state): Masło ekstra 82% Auchan 200g @ 4.98 zł (retailerId=00526577, uuid=6d656759-...)
chosen (DOM):   Masło ekstra 82% Auchan 200g (same result — both paths agree)
cartApi: 141 ms add / 120 ms remove

query: mleko (212 products in state)
chosen (state): Mleko UHT 1,5% Auchan 1l @ 2.84 zł (retailerId=00475155, uuid=ff43bbc0-...)
cartApi: 165 ms add / 116 ms remove

page load probe (q=ser):
  domContentLoaded:     1632 ms
  __INITIAL_STATE__ ready: 1683 ms
  DOM buttons visible:   659 ms
```
