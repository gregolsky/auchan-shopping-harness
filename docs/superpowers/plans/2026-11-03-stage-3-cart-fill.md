# Stage 3: Fast Cart Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After the user approves a draft basket once, the harness fills the Auchan cart over HTTP without attention, sends only the difference from the real cart, and reports what was added and what needs attention.

**Architecture:** The planner skill saves the approved basket into the local database through a new local-only MCP tool. `npm run fill` reads the real cart, works out the difference, sends it in batches through the HTTP worker, reads the cart again and compares it with the basket. The worker gets exactly two new operations, read cart and apply quantities, behind the allowlist, and has no checkout operation.

**Tech Stack:** Node 26 running TypeScript directly, `node:test`, `node:sqlite`, `zod`, `@modelcontextprotocol/sdk`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-auchan-harness-design.md`

## Findings this plan rests on (2026-11-03)

- `/search?q=` over HTTP gets **403 even with the saved session**. By rule the harness does not work around it, so **stage 3 does not search**. All 552 stored products already carry the UUID `productId` that the cart API needs, so every product the planner can propose can be added without searching. Terms the planner cannot match are listed in the report as "add these yourself on Auchan".
- `/cart` is 404, so the cart read endpoint is not yet known. Task 1 finds it.
- Known from `/zakupy`: `POST /api/cart/v1/carts/active/apply-quantity?cartProductSorting=CATEGORIES` with headers `content-type: application/json; charset=utf-8`, `accept: application/json; charset=utf-8`, `x-csrf-token`, `ecom-request-source: web`, `ecom-request-source-version: 2.0.0`, and the body `[{ productId, quantity, meta: { itemListName, favorite: false, pageViewId, pageType } }]`. It was additive in June 2026. That is re-tested in Task 7 before any real fill.

## Decisions (made here; the user reviews them with this plan)

1. **No search in stage 3.** See above. The spec's worker operation list loses "search".
2. **The fill only adds.** If the cart already holds a basket product at or above the approved quantity, the line is left alone. Products in the cart that are not in the basket are kept. Both are listed in the report. The harness never lowers or removes anything during a fill. This is how stage 3 meets "items already in the cart … the harness never removes anything silently" until the stage 4 app can ask at review time.
3. **Price rises are checked after adding.** Without search there is no price read before the add. After the fill, each line's cart unit price is compared with the price at approval. A rise of 10% or less is noted. A larger rise puts the line at the top of the report under "check before paying". This replaces "leave for the user to confirm" in the spec.
4. **The apply mode is a constant.** `APPLY_QUANTITY_MODE` in `src/cart.ts` starts as `'unknown'`, and `fill` refuses to run until Task 7's live smoke test sets it to `'delta'` (additive) or `'absolute'`.
5. **Approval is the latest basket saved by `approve_basket`, at most 24 hours old.** An older one must be approved again.
6. **No automatic retries.** Any error stops the fill. A rerun reads the real cart again and sends only what is still missing, so a POST that timed out but succeeded is never added twice.

## Global Constraints

- The user logs in personally. The harness never holds the password.
- Saved cookies stay in `.state/session.json` (mode 600). Cookie values are never printed, logged or committed. Debugging tools must not read request headers (never call `get_network_request`).
- One request at a time, at most one every 1500 ms (the existing worker queue). 403 → stop, no retries. 429, or 503 with `Retry-After` → stop, no retry, show the wait.
- No checkout operation. The only POST paths allowed are `/graphql` (pinned query) and `/api/cart/v1/carts/active/apply-quantity`. Placing or paying for orders is out of scope.
- Brands the user named stay fixed. The budget is a warning only.
- The `auchan-data` MCP server (`src/mcp.ts`) must never import the worker or anything that can reach Auchan.
- Tests never launch the real CLI, the browser or the network. Fixtures contain no personal details. Raw captured responses go to `tests/fixtures/raw/` (git-ignored).
- Money is in integer grosze.
- Never touch `perf/zakupy-benchmarks.md`.
- Commit messages end with `Claude-Session: https://claude.ai/code/session_01TjAfTmTcEMZJsaVgktXDkB`.

## Review Focus

1. **The cart already has some of the basket.** The user expects nothing doubled and nothing removed. → Task 3 `planFill` tests and Task 5 `fills only what is missing`.
2. **A POST times out after Auchan applied it, then the user reruns.** The user expects no duplicates. → Task 5 `a rerun after a lost response adds nothing twice`.
3. **The session expires mid-fill.** The user expects to log in and have the fill continue. → Task 6 `fill resumes after login`.
4. **One product in a batch is no longer sold and Auchan rejects the batch.** The user expects the rest to be added and that one reported. → Task 5 `a rejected batch is retried line by line after a fresh read`.
5. **Auchan changes the cart response shape.** The user expects the fill to stop before sending anything. → Task 3 `parseCart rejects an unknown shape` and Task 5 `a shape change stops before any POST`.

---

### Task 1: Find the cart read endpoint (controller, live, with the user)

Not for a subagent: it needs the user's browser and their judgement. The controller runs it before Task 2 and records the results in the ledger.

**Files:**
- Create: `tools/discover-cart.ts` (deleted again in Task 9)
- Create: `tests/fixtures/cart.json` (hand-written, synthetic names)
- Raw capture: `tests/fixtures/raw/cart.json` (git-ignored)
- Modify: `docs/superpowers/specs/2026-10-31-auchan-harness-design.md`

- [ ] **Step 1: Write `tools/discover-cart.ts`.** It opens the dedicated profile with `chromium.launchPersistentContext` (the same options as `browserLogin`), goes to `https://zakupy.auchan.pl/`, and for every request whose URL contains `/api/` prints only `method` and `pathname+search`, never headers or bodies. It stops when the window is closed.
- [ ] **Step 2: Ask the user to run `! node tools/discover-cart.ts`**, open their cart in that window and close it. The cart should hold at least one product. The cart read is the GET request that ends in a cart path, for example `/api/cart/v1/carts/active…`.
- [ ] **Step 3: Send one HTTP GET to that path** with the saved session and the `ecom-request-source-version: 2.0.0` header. Save the body to `tests/fixtures/raw/cart.json`. On 403, stop and tell the user. The fallback (cart operations through the browser page) would be a new plan.
- [ ] **Step 4: Write `tests/fixtures/cart.json`**: the same structure with two or three lines, synthetic product names, UUIDs taken from `tests/fixtures/order-decorated.json`, and no address, name or cart id from the real response. Record in the ledger the field paths for product id, quantity, unit price in grosze or złoty, total, and any availability flag.
- [ ] **Step 5: Update the spec.** In Feasibility findings, add the 2026-11-03 search 403 and the cart read path. In Architecture, remove "search" from the worker operations. In Cart safety and Error handling, add decisions 2, 3 and 6 above.
- [ ] **Step 6: Commit** `tests/fixtures/cart.json`, `tools/discover-cart.ts` and the spec: `docs: record the cart read endpoint and drop search from stage 3`.

### Task 2: Cart operations in the HTTP worker

**Files:**
- Modify: `src/worker.ts` (allowlist)
- Modify: `src/http-worker.ts`
- Test: `tests/http-worker.test.ts`, `tests/worker.test.ts`

**Interfaces:**
- Consumes: the cart read path from Task 1, as `CART_READ_PATH`.
- Produces, in `src/worker.ts`: `export const CART_READ_PATH: string`, `export const APPLY_QUANTITY_PATH = '/api/cart/v1/carts/active/apply-quantity'`. `CART_READ_PATH` (pathname only) is added to `ALLOWED_PATHS`.
- Produces, in `src/http-worker.ts`:
  ```ts
  export interface CartChange { productId: string; quantity: number }
  export interface CartAccess {
    readCart(): Promise<unknown>;
    /** Sends at most MAX_BATCH changes in one POST; resolves on 2xx, throws otherwise. */
    applyQuantities(changes: CartChange[]): Promise<void>;
  }
  export const MAX_BATCH = 10;
  export class Rejected extends Error { status: number }  // a 4xx other than 401/403/429
  export function createHttpWorker(o: HttpOptions): Worker & CartAccess;
  ```

- [ ] **Step 1: Write the failing tests** in `tests/http-worker.test.ts`, using the existing `setup()`:
  - `readCart sends a GET to the cart path with the version header and returns parsed JSON`
  - `applyQuantities posts the body to apply-quantity with the CSRF token from page state`: the respond function serves `/orders` with `page({ session: { csrf: { token: 't1' } } })`. Assert the URL is `ORIGIN + APPLY_QUANTITY_PATH + '?cartProductSorting=CATEGORIES'`, `method` is `'POST'`, the header `x-csrf-token` is `'t1'`, and `JSON.parse(body)` deep-equals `[{ productId: 'p1', quantity: 2, meta: { itemListName: 'harness', favorite: false, pageViewId: <any uuid string>, pageType: 'CART' } }]`.
  - `applyQuantities fetches a fresh CSRF token on every call`: two calls → two GETs of `/orders`.
  - `applyQuantities refuses more than MAX_BATCH changes, an empty list, and non-UUID ids, and sends nothing`.
  - `a 400 from apply-quantity throws Rejected with the status and no body text`.
  - `403 from apply-quantity throws Blocked; 401 throws LoginRequired`.
  - In `tests/worker.test.ts`: `no checkout or order path is allowed`. `assertAllowed` throws for `/checkout`, `/checkout/summary`, `/api/checkout/v1/orders`, `/api/order/v6/orders` (POST target), and `/api/cart/v1/carts/active/apply-quantity` via GET.
- [ ] **Step 2: Run** `node --test tests/http-worker.test.ts tests/worker.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** The POST goes through the existing `request()` queue, so pacing and the status mapping are shared. Insert `Rejected` before the generic `unexpected HTTP` branch for 400–499 apart from 401/403/429. The CSRF token comes from a fresh `loadState('/orders')` on each `applyQuantities` call and is never logged. `APPLY_QUANTITY_PATH` is not added to `ALLOWED_PATHS`, so `getJson` cannot reach it. `applyQuantities` builds its URL itself after its own checks. UUID check: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`. Quantity: finite and between -100 and 100. Negative values are needed only by Task 7's removal in delta mode.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: read the cart and apply quantities over HTTP, with no checkout path`.

### Task 3: Pure cart logic

**Files:**
- Create: `src/cart.ts`
- Test: `tests/cart.test.ts`

**Interfaces:**
- Consumes: `tests/fixtures/cart.json` and the field paths in the ledger from Task 1. `CartChange` from Task 2.
- Produces:
  ```ts
  export type ApplyMode = 'unknown' | 'delta' | 'absolute';
  export const APPLY_QUANTITY_MODE: ApplyMode = 'unknown';
  export interface CartLine { productId: string; name: string; quantity: number; unitPriceGrosze: number | null; available: boolean }
  export interface BasketLine { term: string | null; productId: string; name: string; quantity: number; approvedPriceGrosze: number }
  export interface FillPlan { send: CartChange[]; alreadyEnough: BasketLine[]; extras: CartLine[] }
  export interface PriceNote { productId: string; name: string; approvedGrosze: number; nowGrosze: number; risePercent: number }
  export interface FillReport {
    added: BasketLine[]; alreadyEnough: BasketLine[]; extras: CartLine[];
    missing: BasketLine[];            // not in the cart, or below the approved quantity, after the fill
    checkBeforePaying: PriceNote[];   // rise > 10%
    smallRises: PriceNote[];          // 0% < rise <= 10%
    cartTotalGrosze: number | null;
  }
  export function parseCart(json: unknown): { lines: CartLine[]; totalGrosze: number | null };
  export function planFill(basket: BasketLine[], cart: CartLine[], mode: 'delta' | 'absolute'): FillPlan;
  export function compareCart(basket: BasketLine[], before: CartLine[], after: { lines: CartLine[]; totalGrosze: number | null }): FillReport;
  ```

- [ ] **Step 1: Write the failing tests** in `tests/cart.test.ts`:
  - `parseCart reads the fixture`: the line count, product ids, quantities and prices equal the values written in Task 1 Step 4.
  - `parseCart reads an empty cart` (`lines: []`).
  - `parseCart rejects an unknown shape with ShapeError` for `{}`, `null`, and a line without a product id.
  - `planFill sends the missing difference in delta mode`: basket p1×3, cart p1×1 → `send` `[{ productId: 'p1', quantity: 2 }]`.
  - `planFill sends the target in absolute mode`: same input → `[{ productId: 'p1', quantity: 3 }]`.
  - `planFill never lowers or removes`: basket p1×1, cart p1×4 and p9×2 → `send: []`, p1 in `alreadyEnough`, p9 in `extras`.
  - `planFill merges duplicate basket lines for one product`: p1×1 and p1×2 → one change with total 3.
  - `compareCart flags a 12% rise to check before paying and a 5% rise as small`: approved 1000; cart 1120 → `checkBeforePaying`, 1050 → `smallRises`, 990 → neither.
  - `compareCart lists a product still below its quantity as missing`.
- [ ] **Step 2: Run** `node --test tests/cart.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/cart.ts`.** It has no I/O. Prices in złoty strings convert with `Math.round(parseFloat(s.replace(',', '.')) * 100)`. Rise percent is `Math.round((now - approved) / approved * 100)`, using the unrounded ratio for the 10% threshold.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: work out cart differences and compare the filled cart with the basket`.

### Task 4: Approved baskets in the database, and `approve_basket`

**Files:**
- Create: `src/store-baskets.ts`
- Modify: `src/store.ts` (schema, add the methods to `Store`)
- Modify: `src/mcp.ts`
- Test: `tests/store-baskets.test.ts`, `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `BasketLine` from Task 3, `ProductFacts.latestPriceGrosze` and `inCatalogue`.
- Produces on `Store`:
  ```ts
  approveBasket(lines: { term: string | null; productId: string; quantity: number }[], unmatched: string[], now?: Date): { basketId: number; totalGrosze: number };
  latestApprovedBasket(now?: Date): { basketId: number; approvedAt: string; lines: BasketLine[]; unmatched: string[] } | null; // null when none or older than 24 h
  startFill(basketId: number): number;
  finishFill(runId: number, r: { status: 'ok' | 'failed'; sent: number; missing: number; checkBeforePaying: number }): void;
  ```
- Schema (in `store-baskets.ts`, run with the rest of `SCHEMA`):
  `baskets(id INTEGER PK AUTOINCREMENT, approved_at TEXT NOT NULL, unmatched TEXT NOT NULL)`,
  `basket_lines(basket_id INTEGER NOT NULL REFERENCES baskets(id), term TEXT, product_id TEXT NOT NULL REFERENCES products(product_id), quantity REAL NOT NULL, approved_price_grosze INTEGER NOT NULL)`,
  `fill_runs(id INTEGER PK AUTOINCREMENT, basket_id INTEGER NOT NULL REFERENCES baskets(id), started_at TEXT NOT NULL, finished_at TEXT, status TEXT CHECK (status IN ('ok','failed')), sent INTEGER, missing INTEGER, check_before_paying INTEGER)`.
- MCP tool `approve_basket`, inputs `{ lines: z.array(z.object({ term: z.string().min(1).max(100).nullable(), productId: z.string().min(1).max(100), quantity: z.number().min(0.01).max(100) })).min(1).max(150), unmatched: z.array(z.string().max(100)).max(100).default([]) }`. It returns `{ basketId, totalGrosze }`. Its description says it writes the local database only and does not touch the Auchan cart; `npm run fill` does that.

- [ ] **Step 1: Write the failing tests:**
  - `approveBasket stores lines with the current price and returns the total`: two products with known latest prices → `totalGrosze` = sum of price × quantity, rounded.
  - `approveBasket rejects an unknown product or one out of the catalogue, and stores nothing`.
  - `latestApprovedBasket returns the newest basket and null after 24 hours` (pass `now`).
  - `fill runs record status and counts`.
  - In `tests/mcp.test.ts`: `approve_basket saves a basket and never imports the worker`. Extend the existing import-graph test so it also covers `store-baskets.ts`.
- [ ] **Step 2: Run** `node --test tests/store-baskets.test.ts tests/mcp.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `basketMethods(db: DatabaseSync)` in `src/store-baskets.ts`, spread into the object `openStore` returns. One transaction per `approveBasket`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: save approved baskets locally through approve_basket`.

### Task 5: The fill run

**Files:**
- Create: `src/fill.ts`
- Create: `tests/helpers/fake-cart.ts`
- Test: `tests/fill.test.ts`

**Interfaces:**
- Consumes: `CartAccess`, `MAX_BATCH` and `Rejected` (Task 2); `parseCart`, `planFill`, `compareCart` and `BasketLine` (Task 3).
- Produces:
  ```ts
  export interface FillOptions { mode: 'delta' | 'absolute'; onProgress?(sent: number, total: number): void }
  export async function fillCart(cart: CartAccess, basket: BasketLine[], o: FillOptions): Promise<FillReport & { sent: number }>;
  ```
- `tests/helpers/fake-cart.ts`: `fakeCart(mode, initial: Record<string, number>, opts?: { reject?: string[]; loseResponseOnce?: boolean })` returns a `CartAccess` that keeps quantities in memory. `readCart` returns JSON in the fixture's shape. `applyQuantities` applies in the given mode. A product in `reject` makes the whole batch throw `Rejected(400)` without applying anything. `loseResponseOnce` applies the first batch, then throws `new Error('request timed out after 30 s')`.

- [ ] **Step 1: Write the failing tests** in `tests/fill.test.ts`:
  - `fills only what is missing` (delta and absolute): initial p1×1, basket p1×3 and p2×1 → final p1=3, p2=1, `sent` = 2 changes.
  - `sends batches of at most MAX_BATCH`: 23 lines → 3 `applyQuantities` calls, `onProgress` called after each with (10,23), (20,23), (23,23).
  - `a rerun after a lost response adds nothing twice`: `loseResponseOnce`, delta mode. The first `fillCart` rejects. A second `fillCart` on the same fake ends with each quantity exactly as approved.
  - `a rejected batch is retried line by line after a fresh read`: `reject: ['p2']` → p1 and p3 added, p2 in `missing`, and `readCart` called again before the single-line sends.
  - `a shape change stops before any POST`: `readCart` returns `{}` → rejects with `ShapeError`, `applyQuantities` never called.
  - `nothing to send still reads, compares and reports`.
- [ ] **Step 2: Run** `node --test tests/fill.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `fillCart`.** Read and parse the cart, then `planFill`, then send in chunks of `MAX_BATCH`. On `Rejected` for a chunk with more than one change: read the cart again, re-plan that chunk's products against it, and send them one at a time. A single change that is rejected is skipped and ends up in `missing`. Any other error propagates and stops the fill. Finally read the cart again and return `compareCart(...)` with `sent`.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: fill the cart in batches from a fresh read, without duplicates`.

### Task 6: `npm run fill`, `npm run smoke-cart`, and the run guard

**Files:**
- Create: `src/fill-cli.ts`
- Create: `tools/fill-guard.ts`
- Create: `.claude/settings.json`
- Modify: `src/cli.ts` (export the login retry and the failure text for reuse)
- Modify: `package.json` scripts: `"fill": "node src/fill-cli.ts"`, `"smoke-cart": "node src/fill-cli.ts smoke"`
- Test: `tests/fill-cli.test.ts`, `tests/fill-guard.test.ts`

**Interfaces:**
- Consumes: `fillCart` (Task 5), `latestApprovedBasket`, `startFill` and `finishFill` (Task 4), `APPLY_QUANTITY_MODE` (Task 3).
- Produces:
  - In `src/cli.ts`: `export async function withLogin<T>(worker: Worker, work: () => Promise<T>): Promise<T | undefined>` (the existing catch-LoginRequired, print, `waitForLogin`, retry once; `undefined` if the user gave up). Also `describeFailure(err, action: 'sync' | 'fill' = 'sync')`, with the action word put into the rate-limit text.
  - In `src/fill-cli.ts`: `export async function main(args: string[], deps: FillDeps): Promise<number>`, where `FillDeps = { openWorker(): Promise<Worker & CartAccess>; openStore(): Store; mode?: ApplyMode; lockFile?: string }`.
  - `export function formatReport(r: FillReport & { sent: number }, unmatched: string[]): string`, in Polish. Order: "Sprawdź przed zapłatą" (check before paying), "Nie dodano" (missing, with up to 2 substitutes each), "Dodaj sam na Auchan" (unmatched), "Było już w koszyku" (alreadyEnough and extras), small rises, then the count added and the cart total in zł. The last line is `Zapłać na https://zakupy.auchan.pl/checkout`, printed as a link only; the harness never requests that path.
  - Lock file `.state/fill.lock` holding the pid. It is written at start and removed in `finally`.
  - `tools/fill-guard.ts`: reads the hook JSON from stdin. If `.state/fill.lock` exists and its pid is alive (`process.kill(pid, 0)`), it prints `cart fill in progress: browser tools are blocked` to stderr and exits 2. Otherwise it exits 0.
  - `.claude/settings.json`: a `PreToolUse` hook with matcher `mcp__chrome-devtools__.*` and command `node tools/fill-guard.ts`.

- [ ] **Step 1: Write the failing tests**, with fake deps only:
  - `fill refuses while the apply mode is unknown` (exit 1, message names `npm run smoke-cart`, no worker opened).
  - `fill refuses with no approved basket, or one older than 24 hours`.
  - `fill prints progress and the report, and records a fill run` (fake cart from Task 5's helper wrapped as a worker).
  - `fill resumes after login`: the first `readCart` throws `LoginRequired`, `waitForLogin` resolves true, and the fill completes.
  - `the lock file exists during the fill and is gone afterwards, also after a failure`.
  - `formatReport puts check-before-paying first and never contains a cookie or token`.
  - `smoke-cart adds one unit of the given product, reads, adds again, reports the mode it saw, then restores the original quantity` (both fake modes: delta reports `delta` and removes with -2, absolute reports `absolute` and sends 0).
  - `fill-guard blocks while a live pid holds the lock and allows a stale one`.
- [ ] **Step 2: Run** `node --test tests/fill-cli.test.ts tests/fill-guard.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `smoke` takes one argument, a product id that must exist in the store, and refuses a product already in the cart, so the original quantity is 0. It sends quantity 1, reads, sends 1 again, reads. A quantity of 2 means `delta`, 1 means `absolute`, anything else stops with the observed numbers. It then restores 0 (`-2` in delta, `0` in absolute), reads again and reports. If the restore fails, it prints the product name and asks the user to remove it on Auchan. `fill` uses `withLogin` around the whole `fillCart`; a rerun after login starts from a fresh read.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: add npm run fill and the cart smoke test, and block browser tools during a fill`.

### Task 7: Live smoke test (user-started)

Not for a subagent.

- [ ] **Step 1: The controller picks a cheap product.** It must be in the catalogue, cost under 3 zł at its latest price and not be in the cart now (`readCart` once). The controller gives the user its name and id.
- [ ] **Step 2: The user runs `! npm run smoke-cart <productId>`.** Expected: `mode: delta` or `mode: absolute`, then `restored`. On 403 the controller stops and reports; there is no retry.
- [ ] **Step 3: Set `APPLY_QUANTITY_MODE`** in `src/cart.ts` to the observed mode, add a line to the spec's Cart safety section (`apply-quantity re-tested 2026-11-xx: <mode>`), and commit: `feat: set the apply-quantity mode from the live smoke test`.

### Task 8: Planner skill, `/zakupy`, and docs

**Files:**
- Modify: `.claude/skills/auchan-plan/SKILL.md`
- Modify: `.claude/commands/zakupy.md` (replace)
- Modify: `README.md`

- [ ] **Step 1: In the skill**, replace "Do not attempt to fill the cart; cart filling arrives in stage 3" and step 9 with these steps. Once the user approves the draft ("ok", "tak", "zamawiaj"…), call `approve_basket` with every line the user kept: `term`, `productId`, `quantity`, and `unmatched` set to the terms still unmatched. Then run `npm run fill` with Bash and show its report as printed. Never call browser tools. Never open or request checkout. The user pays on Auchan.
- [ ] **Step 2: Replace `/zakupy`** with a short command. It takes the pasted note, follows the `auchan-plan` skill, and states that the old browser helpers are gone. Delivery zone questions are dropped, because the region comes from the user's orders.
- [ ] **Step 3: In README**, add `npm run fill` and `npm run smoke-cart`, the guard hook, and remove the stale "close the chrome-devtools browser" note on the sync line.
- [ ] **Step 4: Run** `npm test`. Expected: pass, since the docs have no tests but nothing else may break. Commit: `docs: plan, approve and fill from one skill; retire the old /zakupy helpers`.

### Task 9: Remove the browser data path

The user decided on 2026-11-03 to delete this after the cart was verified. Do this task only if Task 7 passed over HTTP.

**Files:**
- Modify: `src/worker.ts`, `tests/worker.test.ts`
- Delete: `tools/discover-cart.ts`

- [ ] **Step 1: Delete** `openWorker`, `classifyResponse`, the `InPageResult` and `InPageRequest` types, and the data methods inside `createWorker`. What remains is a small login watcher used by `browserLogin`: `createLoginWatcher(page, closeFn, waitForCloseFn, loginPollMs)` returning `{ waitForLogin(), close() }`. Delete the tests of the removed functions and keep the `waitForLogin` ones, renamed.
- [ ] **Step 2: Run** `npm test && npm run typecheck`, and `grep -rn "openWorker\|classifyResponse" src tests tools`. Expected: pass, and no grep hits.
- [ ] **Step 3: Commit** `refactor: drop the unused browser data path; the browser only logs in`.
