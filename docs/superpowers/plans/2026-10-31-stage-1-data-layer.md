# Stage 1: Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the user's Auchan order history and current promotions into a local SQLite database, and let Claude query it through a read-only MCP server.

**Architecture:** A browser worker opens the dedicated Chromium profile and runs Auchan requests inside the logged-in page. Pure parsers turn responses into typed records, a store writes them to SQLite, and sync jobs connect the two. The MCP server reads only the database and never touches Auchan.

**Tech Stack:** Node 26 running TypeScript directly (type stripping, no build step), `node:test`, `node:sqlite`, `playwright-core`, `@modelcontextprotocol/sdk`, `zod`. `typescript` is a dev dependency for `tsc --noEmit` only.

**Spec:** `docs/superpowers/specs/2026-10-31-auchan-harness-design.md`

## Global Constraints

- All Auchan traffic goes through the logged-in dedicated browser, profile `/home/gregolsky/.cache/chrome-devtools-mcp/zakupy`, executable `/usr/sbin/chromium`.
- The harness never reads, logs or stores cookies, passwords or request headers.
- The harness does not work around Auchan's bot protection. On a 403 or 429 it stops, with no retries.
- Stage 1 performs no cart writes and has no checkout operation. Its only allowed Auchan paths are those in `ALLOWED_PATHS` (Task 3).
- Requests are paced: at least 1500 ms between requests from a sync job.
- Database lives at `.state/harness.db`, already covered by the `.state/` ignore rule. Recorded fixtures contain no personal details.
- If an Auchan response changes shape, stop with a clear error and write nothing for that record.

## Review Focus

- The MCP-launched `chrome-devtools` browser already holds the profile: `openWorker` fails with "close the other browser first", not a generic Playwright lock error (Task 3).
- The session expires partway through a sync: the job stops with `login-required`, keeps what it has committed, and the next run resumes (Tasks 3 and 4).
- A sync dies between orders: rerunning adds no duplicate lines and skips orders already complete (Tasks 2 and 4).
- Amounts arrive as strings in orders and numbers in promotions, and weighed items have quantity 1 with a weight in the unit text: both are stored without rounding errors or a wrong quantity (Task 1).
- Promotions come from a region other than the user's delivery region: rows are refused rather than stored as the user's prices (Task 5).

---

### Task 1: Project setup, capture tool and parsers

**Files:**
- Create: `package.json`, `tsconfig.json`, `src/types.ts`, `src/parse.ts`, `tools/capture.md`, `tests/fixtures/order-decorated.json`, `tests/fixtures/promotions-state.json`, `tests/fixtures/completed-orders.json`, `src/queries/GetCompletedOrders.graphql`, `tests/parse.test.ts`
- Modify: `.gitignore` (add `tests/fixtures/raw/`)

**Interfaces:**
- Produces, in `src/types.ts`: `Product { productId, retailerProductId, name, brand, categoryPath: string[], unitLabel: string|null, inCatalogue: boolean }`; `PriceObservation { productId, seenAt, regionId, source: 'order'|'promotion', originalGrosze: number|null, currentGrosze: number, unitCurrentGrosze: number|null, offerText: string|null, requiredQuantity: number|null }`; `Order { orderId, deliveredAt, totalGrosze }`; `OrderLine { orderId, productId, quantity, pricePerItemGrosze }`.
- Produces, in `src/parse.ts`: `parseGrosze(v: string|number): number`; `parseDecoratedOrder(json: unknown): { order: Order; lines: OrderLine[]; products: Product[]; prices: PriceObservation[] }`; `parsePromotionsState(state: unknown, seenAt: string): { regionId: string; products: Product[]; prices: PriceObservation[] }`; `parseCompletedOrdersPage(json: unknown): { orderIds: string[]; endCursor: string|null; hasNextPage: boolean }`; `class ShapeError extends Error`.

- [ ] **Step 1: Create `package.json` and `tsconfig.json`**

`"type": "module"`, `"test": "node --test tests/"`, `"typecheck": "tsc --noEmit"`. `tsconfig` sets `noEmit`, `strict`, `allowImportingTsExtensions`, `erasableSyntaxOnly`. Run `npm install playwright-core @modelcontextprotocol/sdk zod` and `npm install -D typescript @types/node`.

- [ ] **Step 2: Capture real responses (requires the user's logged-in browser)**

Write `tools/capture.md`: navigate with an `initScript` that wraps `fetch` and records only URL, `operationName`, `query`, variables and response JSON. Never call `get_network_request`, because it returns cookies. Save raw output to `tests/fixtures/raw/`, which is git-ignored. Save the `GetCompletedOrders` query text to `src/queries/GetCompletedOrders.graphql`.

- [ ] **Step 3: Sanitise and commit fixtures**

Reduce each raw file to 3 orders or 5 products, covering a promoted line, a weighed item and a multibuy offer. Remove address, `addressId`, `slotId`, `fulfillmentId`, delivery instructions and any customer fields. Replace order IDs with `1000000001` onward.

Run: `grep -riE 'addressId|deliveryDestination|"address"' tests/fixtures/*.json`
Expected: no output. Also read the sanitised files to confirm that the street name shown on the orders page does not appear.

- [ ] **Step 4: Write failing tests in `tests/parse.test.ts`**

```ts
test('parseGrosze handles strings, numbers and commas', () => {
  assert.equal(parseGrosze('11.98'), 1198);
  assert.equal(parseGrosze(19.98), 1998);
  assert.equal(parseGrosze('3,18'), 318);
});
test('parseGrosze rejects garbage', () => {
  assert.throws(() => parseGrosze(''), ShapeError);
  assert.throws(() => parseGrosze('n/a'), ShapeError);
});
test('decorated order yields one line per grouped product with quantity', () => { /* lines.length === fixture groupedProducts length; every line has quantity >= 1 */ });
test('weighed item keeps quantity 1', () => { /* banana line from fixture: quantity === 1 */ });
test('promoted line stores original and current price', () => { /* originalGrosze > currentGrosze */ });
test('promotions state exposes offer text and multibuy quantity', () => { /* one price has offerText, one has requiredQuantity >= 2 */ });
test('completed orders page returns ids and cursor', () => { /* orderIds.length, hasNextPage */ });
test('missing groupedProducts throws ShapeError', () => { /* delete key, expect ShapeError */ });
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find `src/parse.ts`.

- [ ] **Step 6: Implement `src/types.ts` and `src/parse.ts`**

Money is integer grosze, computed with `Math.round(Number(s.replace(',', '.')) * 100)`. Order data is at `entities.order[result]`, lines at `groupedProducts.products`, products at `entities.product`. Promotions come from `data.products.productEntities`, and offers from each product's `offers` array. Region comes from `session` or `data` state; record the actual path found during capture.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src tools tests
git commit -m "feat: add parsers for Auchan orders and promotions"
```

### Task 2: SQLite store

**Files:**
- Create: `src/store.ts`, `tests/store.test.ts`

**Interfaces:**
- Consumes: types from Task 1.
- Produces: `openStore(path: string): Store`, with `saveOrder(parsed: ReturnType<typeof parseDecoratedOrder>): void`, `hasOrder(orderId: string): boolean`, `savePromotions(parsed): void`, `recentOrders(limit: number)`, `productHistory(query: string)`, `currentPromotions(opts: { boughtBefore?: boolean; limit: number })`, `close(): void`.

- [ ] **Step 1: Write failing tests**

```ts
test('saving an order twice leaves one order and no duplicate lines', () => { /* counts unchanged */ });
test('saveOrder is atomic', () => { /* a line with an unknown productId throws; hasOrder === false */ });
test('same price observed twice on one day stores one row', () => {});
test('changed price stores a new row', () => {});
test('productHistory matches Polish text regardless of case', () => { /* 'MASŁO' finds 'Masło ekstra' */ });
test('currentPromotions boughtBefore returns only products with order lines', () => {});
test('currentPromotions excludes rows from earlier syncs', () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find `src/store.ts`.

- [ ] **Step 3: Implement `src/store.ts`**

Tables `products`, `orders`, `order_lines`, `price_history`, and `sync_runs(kind, started_at, finished_at, status)`. Each `saveOrder` runs in one transaction, and `orders` is written last, so `hasOrder` means complete. `order_lines` primary key is `(order_id, product_id)`. Case-insensitive Polish matching uses a `name_lower` column filled with JavaScript `toLocaleLowerCase('pl')`. Leave `intents` and `corrections` to stage 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts tests/store.test.ts
git commit -m "feat: add SQLite store with idempotent order saves"
```

### Task 3: Browser worker

**Files:**
- Create: `src/worker.ts`, `tests/worker.test.ts`

**Interfaces:**
- Produces: `openWorker(): Promise<Worker>`; `Worker { getJson(path: string): Promise<unknown>; graphql(operationName: string, query: string, variables: object): Promise<unknown>; pageState(path: string): Promise<unknown>; close(): Promise<void> }`; errors `LoginRequired`, `Blocked`, `ProfileBusy`; constants `ALLOWED_PATHS`, `assertAllowed(path: string): void`.

- [ ] **Step 1: Write failing tests**

```ts
test('allows only the stage 1 paths', () => {
  assertAllowed('/orders');
  assertAllowed('/promotions');
  assertAllowed('/api/order/v6/orders/123/decorated');
  assert.throws(() => assertAllowed('/checkout'));
  assert.throws(() => assertAllowed('/api/cart/v1/carts/active/apply-quantity'));
  assert.throws(() => assertAllowed('/orders/../checkout'));
});
test('classifyResponse maps 403 and 429 to Blocked', () => {});
test('classifyResponse maps a login redirect to LoginRequired', () => {});
test('graphql rejects operations other than GetCompletedOrders', () => {});
test('profile lock error becomes ProfileBusy with a clear message', () => { /* message contains 'close the other browser first' */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find `src/worker.ts`.

- [ ] **Step 3: Implement `src/worker.ts`**

`chromium.launchPersistentContext(profile, { executablePath: '/usr/sbin/chromium', headless: false })`. Run requests with `page.evaluate` using in-page `fetch` with `credentials: 'same-origin'`, and read the CSRF token from `__INITIAL_STATE__`. Return only parsed bodies, never headers. Export `classifyResponse(status, finalUrl)` and pure helpers so they test without a browser. `ALLOWED_PATHS` is a list of anchored regexes checked after URL normalisation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Live check (requires the user's login; close the chrome-devtools browser first)**

Run: `node -e "import('./src/worker.ts').then(async m => { const w = await m.openWorker(); console.log(Object.keys(await w.pageState('/orders'))); await w.close() })"`
Expected: prints state keys, no cookies, and the browser closes.

- [ ] **Step 6: Commit**

```bash
git add src/worker.ts tests/worker.test.ts
git commit -m "feat: add browser worker with path allowlist"
```

### Task 4: Order sync

**Files:**
- Create: `src/sync-orders.ts`, `tests/sync-orders.test.ts`

**Interfaces:**
- Consumes: `Worker` (Task 3), `Store` (Task 2), parsers (Task 1).
- Produces: `syncOrders(worker: Pick<Worker,'graphql'|'getJson'>, store: Store, opts: { paceMs: number; sleep?: (ms: number) => Promise<void> }): Promise<{ imported: number; skipped: number; oldestSeen: string|null }>`.

- [ ] **Step 1: Write failing tests with a fake worker**

```ts
test('imports every order across pages', () => {});
test('stops paging once a full page is already stored', () => {});
test('resumes an interrupted import without duplicates', () => { /* fake throws on order 3; rerun imports the rest */ });
test('LoginRequired mid-sync propagates and keeps committed orders', () => {});
test('Blocked stops at once with no retry', () => { /* fake call count unchanged after the throw */ });
test('ShapeError on one order stops the sync and names the order', () => {});
test('waits paceMs between requests', () => { /* injected sleep called with 1500 */ });
```

The early-stop rule applies only once a previous run finished with status `ok`. A first import that was interrupted must page past stored orders to reach older ones.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find `src/sync-orders.ts`.

- [ ] **Step 3: Implement `syncOrders`**

Page with `first: 20` and the cursor. Skip stored orders. Record the run in `sync_runs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync-orders.ts tests/sync-orders.test.ts
git commit -m "feat: add resumable order sync"
```

### Task 5: Promotion sync

**Files:**
- Create: `src/sync-promotions.ts`, `tests/sync-promotions.test.ts`

**Interfaces:**
- Consumes: `Worker.pageState`, `Store.savePromotions`, `parsePromotionsState`.
- Produces: `syncPromotions(worker: Pick<Worker,'pageState'>, store: Store, opts: { paceMs: number; expectedRegionId: string; categories: string[]; sleep?: (ms: number) => Promise<void> }): Promise<{ pages: number; products: number; capped: string[] }>`; `discoverPromotionCategories(state: unknown): string[]`.

- [ ] **Step 1: Write failing tests**

```ts
test('merges category pages and removes duplicates by productId', () => {});
test('a page from another region is refused', () => { /* throws, nothing saved */ });
test('reports categories that return exactly 50 products as capped', () => { /* capped includes the path */ });
test('discoverPromotionCategories finds /promotions/<slug>/<id> links', () => {});
test('Blocked stops the sync', () => {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find `src/sync-promotions.ts`.

- [ ] **Step 3: Implement**

Visit `/promotions`, discover category paths, then visit each one, pacing between pages. Take the expected region from the same-session `pageState('/orders')` read in the CLI (Task 6). Report capped categories rather than guessing at pagination.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sync-promotions.ts tests/sync-promotions.test.ts
git commit -m "feat: add promotion sync with region check"
```

### Task 6: CLI, read-only MCP server and live run

**Files:**
- Create: `src/cli.ts`, `src/mcp.ts`, `tests/mcp.test.ts`
- Modify: `.mcp.json`, `package.json`, `README.md`, `docs/superpowers/specs/2026-10-31-auchan-harness-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `npm run sync` (`orders`, `promotions` or both); MCP server `auchan-data` with tools `recent_orders(limit)`, `product_history(query)`, `current_promotions(bought_before, limit)`.

- [ ] **Step 1: Write failing tests**

```ts
test('server registers exactly the three read tools', () => {});
test('no MCP tool imports the worker', () => { /* read src/mcp.ts; assert no 'worker' import */ });
test('recent_orders returns rows from a seeded store', () => {});
test('reports when data is stale or missing', () => { /* empty store returns "run npm run sync first" */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, cannot find `src/mcp.ts`.

- [ ] **Step 3: Implement `src/cli.ts` and `src/mcp.ts`**

The CLI prints counts and capped categories, and its failure messages are `LoginRequired`: "log in in the browser window, then rerun"; `Blocked`: "Auchan refused the request, try later"; `ProfileBusy`: "close the other browser first". Open the database read-only in the MCP server. Add `auchan-data` to `.mcp.json`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Live sync (requires the user's login)**

Run: `npm run sync`
Expected: orders imported, a promotion product count, and a list of any capped categories. Run it again and expect `imported: 0`.

- [ ] **Step 6: Answer the spec's open questions**

Add results under "Feasibility findings": how far back history goes, whether category pages get past 50 products, and whether the user's region is confirmed. If promotions remain capped, say so there. Stage 2 then works from the partial list.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/mcp.ts tests/mcp.test.ts .mcp.json package.json README.md docs/superpowers/specs/2026-10-31-auchan-harness-design.md
git commit -m "feat: add sync CLI and read-only MCP server"
```
