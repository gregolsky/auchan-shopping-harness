# Auchan Shopping Harness: Design

Date: 2026-10-31
Status: awaiting review

## Intent

**Outcome:** a fast local shopping app. The user writes a short note such as "usual stuff plus pancake ingredients". The app shows a draft basket, what is discounted, current promotions and easy add-ons. The user adjusts it, approves once, and the harness fills the Auchan cart.

**User:** one person, for their household's regular shops.

**Why now:** `/zakupy` is slow and cumbersome. A 40-item run took 26 minutes with interruptions, and the user had to steer it towards cheaper products and larger packs.

**Success:**

- Under 5 minutes of user attention per shop, including review.
- The cart fills unattended after approval.
- At most 1–2 items need fixing afterwards.
- Corrections carry over to later shops.

**Agent limits:**

- It may propose brand swaps, stock-ups and unlisted extras. These appear in the draft and reach the cart only after approval.
- Brands the user names stay fixed unless the user agrees to a swap.
- Perishable quantities are capped so that large packs are not wasted.

**Constraints:**

- The user logs in personally in the dedicated browser profile. The harness never holds the password.
- The checkout block is enforced by mechanisms, not prompt text.
- Budget produces a warning, not a hard stop.
- The harness depends on undocumented Auchan interfaces that can change without notice.
- The harness does not work around Auchan's bot protection.

**Out of scope:**

- Placing or paying for orders.
- Tracking pantry or fridge contents.
- Rebuilding Auchan's browsing and search.
- A browser panel on the Auchan site.
- Other stores.
- Use by other people.

## Feasibility findings (2026-10-31)

Plain HTTP, no cookies:

| Target | Result |
|---|---|
| `/promotions` and its category pages | Readable, including multibuy offers, but only for the default region |
| `/promotions?page=2` | Returns the same 50 products as page 1 |
| `/search`, `/categories` | CloudFront 403 |
| `/orders` | Redirects to login |
| `/graphql` customer queries | Rejected without a customer session |

Logged-in browser:

| Target | Result |
|---|---|
| `GetCompletedOrders` (GraphQL) | Cursor-paginated, 20 orders per page |
| `/api/order/v6/orders/<id>/decorated` | Quantity, category path, brand, unit, original and current prices, substitutes, last-bought date, `missedPromotions` |
| `/promotions` | Server-rendered state with `offers` on each product |
| `__INITIAL_STATE__` | Includes `regulars`, `favorite` and `coupons` slices, not yet examined |

Decision (revised 2026-11-01, by the user): Auchan reads go over plain HTTP from Node with the user's own session cookies, sent as an ordinary client. A live run confirmed orders, order details, promotions and the user's region this way. The browser is used only to log in and save the session.

Confirmed in the first live sync (2026-11-01):

- Order history: 21 orders, the oldest from 22 April 2025. All of them were imported.
- Promotions: 234 products from 12 pages for the user's own region. Three pages hit the 50-product limit, including two category pages, so the list can be incomplete.
- Region: order and promotion prices both use the user's region.
- The login did not survive a browser restart under default profile settings. The worker therefore waits for login in the open window, and turns on session restore in the profile.

Cart over HTTP (2026-11-03 and 2026-11-15):

- `/search?q=` returns 403 even with the saved session. The harness does not work around it, so the cart fill does not search. Every product the planner can propose already carries the id the cart needs.
- Read the cart: `GET /api/cart/v1/carts/active`, found in the site's public script. Lines carry `productId`, `quantity` and prices as złoty strings (`"1.98"`).
- `POST /api/cart/v1/carts/active/apply-quantity` is additive (re-tested 2026-11-15: quantity 1 sent twice gave 2; -1 removes one). A product out of stock still returns HTTP 200; it is listed in `limitedItems` with `reason: "OUT_OF_STOCK"` and `addedAmount`.
- A saved session from 2026-11-01 had expired by 2026-11-15.

## Architecture

All components run on the user's machine.

- **Worker:** sends Auchan requests from Node with the saved session, one at a time, at most one every 1.5 s. The dedicated Chromium profile is opened only when a login is needed. It exposes only these operations: sync orders, list promotions, read cart, add to cart. It has no checkout operation and cannot clear the cart.
- **Local database:** a SQLite file holding orders, products, prices and corrections, excluded from git. The app reads from it, so it does not wait on Auchan's site.
- **Planner:** Claude turns the note into a draft basket using the database. Its only route to Auchan is the same operations, exposed as an MCP server.
- **Local app:** a page on `localhost`, bound to the local machine only, showing the draft, promotions and suggestions. Approval in the app triggers the cart fill.
- **Safety hooks:** block the raw browser tools during runs. After a fill, the worker compares the real cart with the approved basket.

All browser-based reading and writing goes through the worker, so Auchan changes are fixed in one place.

## Data model

- `products`: Auchan IDs, name, brand, category path, size, whether it is in the current catalogue.
- `orders`, `order_lines`: date, quantity, price paid. The full history is imported once, then only new orders are synced.
- `price_history`: one row each time a product's price or offer is seen, with original, current and unit prices and offer text.
- `intents`: what a word such as "mleko" or "nutella" means to the user. Links to accepted products, with one preferred, and records whether the brand is fixed.
- `corrections`: each change to a draft, with what was proposed, what was chosen, and the reason if given.

## Product selection

Applied in this order:

1. Accepted products for the intent.
2. Order history: what the user bought for this category, and how often.
3. Value: unit price after any multibuy offer the quantity actually reaches.

A pick with no intent or history behind it is marked as a guess in the draft.

## Learning

- Every edit in the app is saved as a correction.
- Choosing the same product twice for an intent makes it the preferred product.
- A single edit affects only that basket.
- A product chosen once appears as an alternative and leads only after a second choice.
- The user can view and delete rules in the app.

## Stock-ups and perishables

- Non-perishables are suggested when the unit price is well below that product's own usual price, and the app shows the reason. The exact threshold is set from real price history in stage 2.
- Perishables are capped at the usual quantity, using category path and past quantities. The category list is tuned from real data.
- The draft never assumes pantry contents. It shows facts such as "last bought 6 weeks ago".

## Run flow

1. **Start:** the app checks the login, syncs new orders and refreshes promotions in the background.
2. **Note:** the user enters a short note.
3. **Draft:** the planner groups the basket into the user's items, stock-ups, promotions and add-ons. Each line shows price, reason and any guess marker.
4. **Review:** the user edits, swaps or removes lines. The Auchan cart is not touched.
5. **Fill:** the user approves once. The worker fills the cart in batches and shows progress.
6. **Finish:** the app shows what was added and what needs attention, with a button that opens Auchan's checkout page. The user pays there.

## Cart safety

- `apply-quantity` is additive (re-tested 2026-11-15).
- The worker reads the cart, calculates the difference from the approved basket, and sends only that difference. Retries and crash recovery therefore cannot add items twice.
- The fill only adds. Basket products already in the cart at or above the approved quantity, and products not in the basket, are left alone and listed in the report. The harness never lowers or removes anything during a fill; choosing to remove them at review comes with the stage 4 app.
- There are only two automatic re-sends, both safe because each starts from a fresh cart read: after a rejected batch the products are re-sent one at a time, and after a login the fill restarts. Any other error stops the fill; a rerun reads the cart again and sends only what is still missing.
- After filling, the worker compares quantities, prices and the total with the approved basket and reports any difference.

## Error handling

| Problem | Behaviour |
|---|---|
| Login expired | Pause, ask the user to log in, resume where it left off |
| Item out of stock | Auchan reports it in `limitedItems`; list it in the report with substitutes, and continue |
| Price rose since the draft | Checked after adding, since there is no search: note small rises; list any item that rose by more than 10% first, under "check before paying" |
| Budget exceeded | Warn at review, do not block |
| Auchan's response changes shape | Stop with a clear error and leave the cart as it is |
| 403 | Stop, with no retries |
| 429, or 503 with `Retry-After` | Stop, with no automatic retry, and show how long to wait. Saved data is kept and the next sync continues |

Requests are paced and batched, and the worker fetches no more than it needs. The first order-history import runs slowly, once.

## Secrets and privacy

- The user allows the harness to save session cookies. They are kept in a git-ignored, owner-only file (`.state/session.json`) and in the browser profile.
- Cookie values are never printed, logged or committed.
- Debugging tools must not read request headers, because they contain session cookies.
- The database, logs and recorded test data stay out of git unless personal details have been removed.

## Stack

TypeScript on Node. `playwright-core` drives the installed Chromium at `/usr/sbin/chromium` with the dedicated profile. SQLite for storage. The app is served by the same local process.

## Testing

- **Recorded responses:** real order, promotion and search responses, with personal details removed, run offline as test data.
- **Scoring:** deterministic tests for unit prices, multibuy maths, and intent and category rules.
- **Regressions:** starts with the June mistakes (Nutella wafers, 3L catering syrup, loose ham). Future corrections can become new cases.
- **History replay:** given an old order and a similar note, measure how closely the draft matches what the user bought.
  - Measured 2026-11-01 with `npm run replay` (usual list only, latest 5 orders, each using only the orders before it): average recall 33%, precision 37%.
- **Cart logic:** difference calculation, retries and mid-run crashes, against a fake cart.
- **Safety:** confirm that no checkout operation exists and that hooks block the raw browser tools during runs.
- **Live smoke test:** manually started, on the real cart with one cheap item: add, verify, remove. It also re-tests whether `apply-quantity` is additive.

Each real run logs active time, number of edits and items fixed afterwards, to measure the success targets.

## Build order

Each stage gets its own plan and is usable on its own.

1. Data layer, with order and promotion sync.
2. Planner and learning.
3. Fast cart fill. Done 2026-11-15.
4. Local app. Done 2026-11-15.

Stage 4 adds the local shopping page; `/zakupy` remains the chat fallback.
