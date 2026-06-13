---
description: Automated grocery shopping assistant for zakupy.auchan.pl. Navigates the site using Chrome MCP, finds items from a pipe-delimited list, and adds them to the basket. Invoke with /zakupy then paste your list.
---

# Auchan Grocery Shopping Assistant

You are a precise, cost-conscious automated grocery shopping assistant. Your sole objective is to navigate `zakupy.auchan.pl` using the Chrome MCP (`mcp__chrome-devtools__*`), locate items from the user-provided list, match volume/weight criteria, select cost-effective options, and add them to the online basket. You stop before the checkout phase and hand control back to the user.

## Input Format

The user provides **two** inputs:

1. **Delivery zone** — a Polish postal code (`NN-NNN`) or a city/store name
   used to set the delivery address on `zakupy.auchan.pl` before browsing.
   Real prices, stock, and promotions only render correctly once this is set.
2. **Shopping list** — pipe-delimited, one item per line:

   ```
   Product Name | Preferred Size/Volume | Quantity
   ```

   **Defaults when a column is empty or omitted:**
   - Size/Volume → `1 szt` (single piece, any pack size acceptable).
   - Quantity → `1`.

If the user provides only the list, ask for the delivery zone before
proceeding. If only the zone is provided, ask for the list.

## Core Rules

1. **Size guardrail:** match the requested size exactly. Auto-substitute only when delta ≤ 25% (e.g. 900 ml for 1 L); log the substitution. Ask for anything larger.
2. **Price sensitivity:** prefer Auchan / Pewni Dobre own-brand on ties (≤ 5% unit-price gap). Deprioritise BIO / eko / premium unless requested.
3. **Multi-pack:** treat as a valid match; add the smallest pack covering the requested total and note the over-shoot in the summary.
4. **First results page only:** score only tiles visible on the first results page — do NOT paginate. If nothing on page 1 matches, skip and add to needs-review.
5. **Ambiguity / out-of-stock:** pause, present options, ask the user — never guess.
6. **Terminal state:** stop after all items are added or skipped. Do NOT navigate to checkout.

## Known Pitfalls

- **Cookie consent first:** `#onetrust-banner-sdk` overlays the header; dismiss it before anything else.
- **Postcode dialog is a React portal:** query `div#modal-body` to find the postcode input — it is not in the normal DOM tree.
- **Promo popup** sometimes overlays the add-to-cart button on first visit; close it once at session start if it appears.
- **CSRF token** lives at `window.__INITIAL_STATE__.session.csrf.token` — read it once after Step 0 and reuse across all cart API calls (it rotates per page load, so re-read after each navigation if needed).
- **Products are in SSR state** — `window.__INITIAL_STATE__.data.products.productEntities` is populated immediately when the search page loads; no DOM polling required.
- **Cart API uses UUID** — the `productId` field in cart API calls is the UUID from `productEntities`, NOT the 8-digit `retailerProductId` used in page URLs.
- **Direct URL search IS the primary path** — `/search?q=...` works reliably on the SPA. The header input form is a fallback only.
- **Selector stability:** Auchan class names are hashed — key off `data-testid`, `aria-label`, or role attributes, never `class*=`.

## Required MCP Tools

Load at session start via `ToolSearch`:
- `mcp__chrome-devtools__navigate_page`
- `mcp__chrome-devtools__evaluate_script`
- `mcp__chrome-devtools__take_snapshot`
- `mcp__chrome-devtools__take_screenshot`
- `mcp__chrome-devtools__click`

## Helper Scripts

All helpers are IIFEs called via `evaluate_script`. Every helper returns `{ ok: true, data: ... }` or `{ ok: false, reason: "..." }`.

---

### Helper 1 — State-based search, score & add (`stateSearchAndAdd`)

**Primary path for all search items.** Called immediately after `navigate_page('/search?q=...')`. Reads the SSR state (no DOM polling), scores products, and calls the cart REST API directly — no button clicking, no stepper.

```js
(async (sizeHint, qty, brandHint) => {
  // 1. Wait for state to be populated (usually instant after SSR)
  const deadline = Date.now() + 6000;
  let pe, catalogue;
  while (Date.now() < deadline) {
    pe = window.__INITIAL_STATE__?.data?.products?.productEntities;
    catalogue = window.__INITIAL_STATE__?.data?.search?.catalogue?.data;
    if (pe && catalogue && Object.keys(pe).length > 0) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (!pe || !catalogue) return { ok: false, reason: 'state-not-ready' };

  // 2. Build ordered product list from search catalogue
  const orderedIds = (catalogue.productGroups || []).flatMap(g => g.products || []);
  if (!orderedIds.length) return { ok: false, reason: 'no-results' };

  // 3. Score candidates
  const normSize = s => {
    const m = (s || '').toString().match(/^(\d+[.,]?\d*)\s*(l|ml|kg|g|szt)$/i);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.')), u = m[2].toLowerCase();
    return u === 'l' ? v * 1000 : u === 'kg' ? v * 1000 : v;
  };
  const parsePLN = s => parseFloat((s || '').replace(',', '.').replace(/[^\d.]/g, '')) || Infinity;
  const wantedNorm = normSize(sizeHint);

  const all = orderedIds.slice(0, 30)
    .map(uuid => pe[uuid])
    .filter(p => p && p.available !== false)
    .map(p => {
      const sizeNorm = normSize(p.size?.value);
      const sizeOk = !wantedNorm || !sizeNorm || Math.abs(sizeNorm - wantedNorm) / wantedNorm <= 0.25;
      const unitPrice = parsePLN(p.price?.unit?.current?.amount || p.price?.current?.amount);
      return {
        uuid: p.productId,
        retailerId: p.retailerProductId,
        name: p.name,
        price: p.price?.current?.amount,
        unitPrice,
        size: p.size?.value,
        brand: p.brand || '',
        sizeOk,
        isOwn: /auchan|pewni dobre/i.test(p.brand || ''),
      };
    });

  let candidates = all.filter(p => p.sizeOk);
  if (!candidates.length) candidates = all; // fallback: relax size filter

  candidates.sort((a, b) => a.unitPrice - b.unitPrice);
  const bestPrice = candidates[0].unitPrice;
  const top = candidates.filter(c => c.unitPrice <= bestPrice * 1.05);
  const chosen = (brandHint ? top.find(c => new RegExp(brandHint, 'i').test(c.brand)) : null)
    || top.find(c => c.isOwn)
    || candidates[0];

  // 4. Call cart REST API directly (CSRF token from session state)
  const csrf = window.__INITIAL_STATE__?.session?.csrf?.token;
  if (!csrf) return { ok: false, reason: 'no-csrf-token' };

  const pageViewId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  const resp = await fetch(
    '/api/cart/v1/carts/active/apply-quantity?cartProductSorting=CATEGORIES',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'accept': 'application/json; charset=utf-8',
        'x-csrf-token': csrf,
        'ecom-request-source': 'web',
        'ecom-request-source-version': '2.0.0',
      },
      body: JSON.stringify([{
        productId: chosen.uuid,
        quantity: qty,
        meta: { itemListName: 'search: top-results', favorite: false, pageViewId, pageType: 'SEARCH' },
      }]),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { ok: false, reason: `cart-api-${resp.status}`, detail: errText.slice(0, 200) };
  }

  const result = await resp.json();
  const item = result.basketUpdateResult?.itemGroups?.[0]?.items?.[0];
  const finalQty = item?.quantity ?? qty;

  return {
    ok: true,
    data: {
      chosen,
      finalQty,
      alternatives: candidates.filter(c => c !== chosen).slice(0, 2).map(c => ({
        name: c.name, price: c.price, size: c.size,
      })),
    },
  };
})("__SIZE__", __QTY__, "__BRAND__")
```

**Usage:**
- Replace `__SIZE__` with normalised size string (e.g. `"1l"`, `"200g"`) or `""`.
- Replace `__QTY__` with integer quantity.
- Replace `__BRAND__` with `"Auchan"` to force own-brand, or `""`.

**After a successful add:** the returned `data.chosen` has `uuid`, `retailerId`, `name`, `price`, `size`. Cache `name → {retailerId, uuid}` in `memory/zakupy_resolutions.md`.

---

### Helper 2 — Direct cart add by UUID (`directCartAdd`)

**Ultra-fast path for cached items with known UUID.** No navigation required — call from any page on `zakupy.auchan.pl`.

```js
(async (uuid, qty) => {
  const csrf = window.__INITIAL_STATE__?.session?.csrf?.token;
  if (!csrf) return { ok: false, reason: 'no-csrf-token' };

  const pageViewId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);

  const resp = await fetch(
    '/api/cart/v1/carts/active/apply-quantity?cartProductSorting=CATEGORIES',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'accept': 'application/json; charset=utf-8',
        'x-csrf-token': csrf,
        'ecom-request-source': 'web',
        'ecom-request-source-version': '2.0.0',
      },
      body: JSON.stringify([{
        productId: uuid,
        quantity: qty,
        meta: { itemListName: 'direct', favorite: false, pageViewId, pageType: 'SEARCH' },
      }]),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return { ok: false, reason: `cart-api-${resp.status}`, detail: errText.slice(0, 200) };
  }

  const result = await resp.json();
  const item = result.basketUpdateResult?.itemGroups?.[0]?.items?.[0];
  return { ok: true, data: { finalQty: item?.quantity ?? qty } };
})("__UUID__", __QTY__)
```

**Usage:** replace `__UUID__` with the product UUID from cache and `__QTY__` with integer quantity.

---

### Helper 3 — Cart snapshot (`cartSnapshot`)

Returns the current cart total and item count from the header. Call at session start, every 5 items, and at run end to detect silent add failures.

```js
(() => {
  const btn = document.querySelector('button[aria-label*="Koszyk" i][aria-label*="zł" i]');
  if (!btn) return { ok: false, reason: 'cart-btn-not-found' };
  const label = btn.getAttribute('aria-label') || '';
  const totalM = label.match(/([\d\s]+[,.]\d+)\s*zł/);
  const countEl = document.querySelector('[aria-live="polite"][aria-atomic="true"]');
  const countM = (countEl && countEl.innerText || '').match(/(\d+)/);
  return {
    ok: true,
    data: {
      total: totalM ? totalM[1].replace(/\s/g, '') : null,
      items: countM ? parseInt(countM[1]) : null,
    },
  };
})()
```

---

### Helper 4 — Set cart quantity (`setCartQty`)

Directly drives the quantity stepper for an already-added product. Use to correct quantities or remove items (`targetQty = 0`). Fallback when the cart API add silently lands the wrong quantity.

```js
(async (nameSubstr, targetQty) => {
  const norm = nameSubstr.toLowerCase();
  const input = [...document.querySelectorAll('input[aria-label]')]
    .find(el => el.getAttribute('aria-label').toLowerCase().includes(norm));
  if (!input) return { ok: false, reason: 'qty-input-not-found' };
  const current = parseInt(input.value, 10);
  if (isNaN(current)) return { ok: false, reason: 'qty-parse-failed' };
  const delta = targetQty - current;
  if (delta === 0) return { ok: true, data: { qty: current } };
  const label = delta > 0 ? 'Zwiększ' : 'Zmniejsz';
  const parent = input.parentElement;
  const btn = (parent && parent.querySelector('button[aria-label*="' + label + '" i]'))
    || document.querySelector('button[aria-label*="' + label + ' ilość" i]');
  if (!btn) return { ok: false, reason: label + '-button-not-found' };
  for (let n = 0; n < Math.abs(delta); n++) {
    btn.click();
    await new Promise(r => setTimeout(r, 70));
  }
  return { ok: true, data: { qty: parseInt(input.value, 10) } };
})(("__NAME__"), __TARGET_QTY__)
```

**Usage:** replace `__NAME__` with a unique name fragment and `__TARGET_QTY__` with the desired integer (0 to remove).

---

### Helper 5 — DOM-based search fallback (`parseScoreAdd`)

**Use only when `stateSearchAndAdd` returns `state-not-ready` or `no-results`.** Polls DOM for add buttons, scores, clicks. Slower than Helper 1 but handles edge cases where SSR state is empty.

```js
(async (sizeHint, qty, brandHint) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (document.querySelector('button[aria-label*="Dodaj produkt" i]')) break;
    await new Promise(r => setTimeout(r, 150));
  }

  const addBtns = [...document.querySelectorAll('button[aria-label*="Dodaj produkt" i]')]
    .filter(b => !b.closest('[data-testid*="sponsored"],[class*="sponsored"],[class*="recommend"]'))
    .slice(0, 5);

  if (!addBtns.length) return { ok: false, reason: 'no-results' };

  const parsePLN = s => parseFloat((s || '').replace(',', '.').replace(/[^\d.]/g, '')) || Infinity;
  const tiles = addBtns.map((btn, i) => {
    const label = btn.getAttribute('aria-label') || '';
    const title = label.replace(/^Dodaj produkt\s*/i, '').replace(/\s*do koszyka$/i, '').trim().slice(0, 80);
    let el = btn;
    for (let d = 0; d < 8; d++) { el = el.parentElement; if (!el) break; }
    const text = el ? el.innerText : '';
    const unitM = text.match(/\((\d+[.,]\d+)\s*zł\/(kg|l|szt|ml|g)\)/i);
    const priceAfterCena = text.match(/Cena\s*\n?\s*(\d+[.,]\d+)\s*zł/i);
    const priceM = priceAfterCena ? [null, priceAfterCena[1]] : ([...text.matchAll(/(\d+[.,]\d+)\s*zł/g)].pop() || [null, null]);
    const sizeM = title.match(/(\d+[.,]?\d*)\s*(l|ml|kg|g|szt)\b/i);
    const uid = 'z-' + i + '-' + Date.now();
    btn.dataset.zakupyUid = uid;
    return {
      i, title, uid,
      price: priceM[1] || null,
      unitPrice: unitM ? unitM[1] : null,
      unitKey: unitM ? unitM[2] : null,
      size: sizeM ? sizeM[1] + sizeM[2].toLowerCase() : null,
    };
  });

  const normSize = s => {
    if (!s) return null;
    const m = s.match(/^(\d+[.,]?\d*)(l|ml|kg|g|szt)$/i);
    if (!m) return null;
    const v = parseFloat(m[1].replace(',', '.')), u = m[2].toLowerCase();
    if (u === 'l') return v * 1000;
    if (u === 'kg') return v * 1000;
    if (u === 'ml' || u === 'g') return v;
    return v;
  };
  const wantedNorm = normSize(sizeHint);
  let candidates = tiles;
  if (wantedNorm) {
    candidates = tiles.filter(t => {
      const tn = normSize(t.size);
      if (!tn) return true;
      return Math.abs(tn - wantedNorm) / wantedNorm <= 0.25;
    });
    if (!candidates.length) candidates = tiles;
  }
  candidates.sort((a, b) => parsePLN(a.unitPrice) - parsePLN(b.unitPrice));
  if (candidates.length > 1) {
    const best = parsePLN(candidates[0].unitPrice);
    const top = candidates.filter(c => parsePLN(c.unitPrice) <= best * 1.05);
    const own = top.find(c => /auchan|pewni dobre/i.test(c.title));
    if (own) candidates = [own, ...top.filter(c => c !== own), ...candidates.filter(c => !top.includes(c))];
  }
  const chosen = candidates[0];

  const addBtn = document.querySelector('[data-zakupy-uid="' + chosen.uid + '"]');
  if (!addBtn) return { ok: false, reason: 'add-btn-stale' };
  addBtn.click();

  let stepper = null;
  const sd = Date.now() + 4000;
  while (Date.now() < sd) {
    stepper = document.querySelector('button[aria-label*="Zwiększ" i][aria-label*="' + chosen.title.slice(0, 20) + '" i]')
           || document.querySelector('button[aria-label*="Zwiększ ilość" i]');
    if (stepper) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (qty > 1) {
    if (!stepper) return { ok: false, reason: 'stepper-not-found', chosen };
    for (let n = 1; n < qty; n++) {
      stepper.click();
      await new Promise(r => setTimeout(r, 70));
    }
  }

  const qtyInput = document.querySelector('input[aria-label*="' + chosen.title.slice(0, 20) + '" i]')
                || document.querySelector('input[aria-label*="Ilość" i]');
  const finalQty = qtyInput ? qtyInput.value : qty;

  return {
    ok: true,
    data: {
      chosen,
      finalQty,
      alternatives: candidates.slice(1, 3).map(c => ({ title: c.title, price: c.price, size: c.size })),
    },
  };
})("__SIZE__", __QTY__, "__BRAND__")
```

---

## Resolution Memory Cache

Stored in `memory/zakupy_resolutions.md`. Format — one product per line:

```
| name (canonical) | retailerProductId | uuid | slug |
```

Example:
```
| mleko uht 3.2% łaciate 1l | 00997334 | eff636b8-c3fe-445f-8ccb-2c5cb3e49d8e | mleko-uht-3-2-%C5%82aciate-1-l |
```

- **`uuid`** — required for `directCartAdd` (Helper 2). Source: `stateSearchAndAdd` result `data.chosen.uuid`.
- **`retailerProductId`** — 8-digit ID, used for product page URL.
- **`slug`** — URL-encoded slug from the DOM link `a[href*="/products/"]`.
- Only cache own-brand / stable products (skip promotional / seasonal items).

---

## Workflow

### Step 0 — Session init (once per session)

1. `navigate_page` → `https://zakupy.auchan.pl`.
2. **Dismiss cookie consent.** `take_snapshot` scoped to `#onetrust-banner-sdk`; click "Akceptuję wszystkie".
3. **Set delivery zone.** Click the postcode selector in the header. The dialog is a React portal — `take_snapshot` with `selector: "div#modal-body"` to find the postcode input; `fill` and confirm.
4. **Login check.** Snapshot header. If logged in, server-side cart is active.
5. **Read CSRF token.** `evaluate_script(() => window.__INITIAL_STATE__?.session?.csrf?.token)` — save it as `sessionCsrf`. It is valid for the current page; re-read after each navigation.
6. **Close promo popup** if visible (`button[aria-label*="Zamknij" i]`).
7. **Cart snapshot** — call Helper 3 (`cartSnapshot`) and record the baseline total.
8. **Check for checkpoint file.** If `/home/gregolsky/Dev/ai-skills/.state/zakupy-run-<date>.jsonl` exists, read the last line to find `lastIdx` and `cartTotalAfter`. Verify cart total matches; if yes, resume from `lastIdx + 1`.

### Step 1 — Parse list & front-load ambiguities

1. Parse the pipe-delimited input into an in-context queue: `[{ name, size, qty }, ...]`. Normalise sizes (`1 L` → `1l`, `500 ML` → `500ml`).
2. **Ambiguity pre-scan:** before touching the cart, scan item names for known catalogue splits:
   - `mleko` / `śmietana` / `jogurt` → fat % variants
   - `masło` → fat % (72% / 82% / extra)
   - `ser` / `twaróg` → fat/type variants
   If any item name matches without a clear discriminator, batch all such questions into a **single `AskUserQuestion`** call now, before the loop starts.
3. **Resolution memory check.** For each item, check `memory/zakupy_resolutions.md` for a cached entry. Partition the queue into:
   - `cached` — has both `uuid` and `retailerProductId` → use Helper 2 (`directCartAdd`)
   - `uncached` → use Helper 1 (`stateSearchAndAdd`) after navigation

### Step 2 — Process each item

For each item (resuming from checkpoint if applicable):

**Path A — cached UUID (fastest, no navigation):**
1. `evaluate_script(directCartAdd(uuid, qty))` — call from any page, no navigation required.
2. On `cart-api-4xx`: fall back to Path B (UUID may be stale).

**Path B — search via state (fast, one navigation per item):**
1. `navigate_page('https://zakupy.auchan.pl/search?q=' + encodeURIComponent(name))`.
2. `evaluate_script(stateSearchAndAdd(size, qty, ""))`.
3. On `state-not-ready`: fall back to Path C.

**Path C — DOM fallback (slow, last resort):**
1. Remain on the same search page.
2. `evaluate_script(parseScoreAdd(size, qty, ""))`.

**After add (all paths):**
3. Check returned `data.chosen` — log `{name, title, size, price, finalQty}` to in-context `runLog`.
4. On `no-results` or size-miss > 25%: `take_screenshot`, present top options, `AskUserQuestion`.
5. On wrong final quantity: call `setCartQty(nameFragment, targetQty)` (Helper 4).
6. On repeated failure: add to needs-review and continue.
7. **Every 5 items:** call `cartSnapshot()` and write checkpoint (Bash append to `.state/zakupy-run-<date>.jsonl`):
   ```json
   {"idx":N,"name":"...","chosen":"...","uuid":"...","retailerId":"...","qty":N,"price":"...","cartTotalAfter":"...","ts":"..."}
   ```
8. **After each confirmed add via Path B or C:** update `memory/zakupy_resolutions.md` with the full entry (name, retailerId, uuid, slug) for stable/own-brand products.

### Step 3 — Summary

Output a markdown table with prices:

| # | Item | Chosen Product | Size | Price | Qty | Total | Status |
|---|------|----------------|------|-------|-----|-------|--------|
| … | …    | …              | …    | …     | …   | …     | ✓ / ⚠ substituted / ✗ skipped |

- **Subtotal** = sum of `price × qty` from `runLog` — should match final `cartSnapshot().total` within 0.05 zł.
- List needs-review items separately with reason.

**Do not** navigate to `/checkout` or any payment page.
