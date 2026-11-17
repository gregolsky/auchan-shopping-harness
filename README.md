# domestic-ai

Local Claude Code commands for household automation, scoped to this working directory.
Invoke any skill by typing `/<name>` inside a Claude Code session started from this directory.

## Shopping app

`npm run app` is the main way to shop. It starts a local page with a seven-step wizard: **Dane → Lista → Przegląd → Doprecyzowanie → Zatwierdzenie → Koszyk → Płatność**. Paste a list, review the matches, answer the uncertain ones, then approve to add the products to the Auchan cart. The page follows the system light or dark theme and has a switch for it.

- The server prints one URL, `http://127.0.0.1:47474/?t=<token>`. It listens on 127.0.0.1 only and every request needs the random token. The port (change it with `APP_PORT`) and the token (kept in `.state/app-token`) stay the same between starts, so a bookmark keeps working. Running `npm run app` while the app already runs only prints that URL.
- Every product line has explicit actions: **Wybierz inny** (another candidate), **Szukaj innego w Auchan**, **Dodam sam na Auchan** (moves it to the add-by-hand list) and **Nie kupuję**. Lines are grouped and marked by category, each product links to its page on Auchan ("Zobacz na Auchan ↗"), and a price older than 30 days shows its date ("· cena z 7 sie"). Near-identical products (for example the same milk under two ids) are shown once, keeping the one bought most recently.
- **Szukaj w Auchan** in the app runs the user-approved search described below for terms the local data does not know.
- Claude is used through `claude -p` to read the list and propose changes. It runs with no tools, in isolation: no MCP servers, no settings or slash commands, no saved session, and an empty temporary working directory. It only proposes; nothing changes until you click "Zastosuj" on a proposal.
- Without Claude (not installed, failing or giving an unusable answer) the page shows "Tryb bez Claude": it still builds the draft and asks about every doubtful match.
- The **Moje reguły** tab lists the choices the planner has learned (each can be removed) and the blocked products. All Mąka Szymanowska flours are blocked from the start, regardless of type or product ID. Search the local catalog there to block another product or lift the Szymanowska block. Changes are saved in `.state/harness.db` and apply to drafts, approval and cart filling; arrange the draft again after changing the list.
- The app never pays and never places an order. The last step links to Auchan; check the cart and pay there.
- Approve only once per trip: approving saves the basket and fills the cart, and the report is for that fill.

`/zakupy` is the chat fallback. `npm run fill` stays available for a basket approved through the planner (see the data layer section below).

## Skills

| Command | Description |
|---------|-------------|
| `/zakupy` | Chat fallback for planning a basket and filling the Auchan cart; stops before checkout |

## Auchan data layer

A local, read-only copy of order history and promotions, kept in `.state/harness.db`.

- `npm run sync` (or `npm run sync orders` / `npm run sync promotions`) fetches the data over plain HTTP with the saved session in `.state/session.json`. A browser window opens only when a login is needed. Log in in that window and leave it open: the harness saves the session, closes the window and continues the sync on its own. The sync only reads; it never changes the cart.
- `npm run sync images` fills in product images for orders imported before images were read: it re-fetches only orders with a product that has no image and updates only the image columns (same pacing; it stops on a refusal).
- `npm run sync placed <orderId>` imports one order that is placed but not yet delivered, so its products are known before delivery (a normal `npm run sync` already does this for the orders placed from a cart the harness filled).
- `npm run sync check` tests the request format before a full import: it reads one orders page and one order, stores nothing, and prints `ok` with the order count. If Auchan refuses it, do not rerun.
- `npm run replay` replays the latest 5 orders against the draft's usual list, each using only the orders before it, and prints recall and precision per order plus the average. It reads the local database only and never prints product names.
- The `auchan-data` MCP server (`.mcp.json`) reads that database only and never contacts Auchan. Tools: `recent_orders(limit)`, `product_history(query)` and `current_promotions(bought_before, limit)`. Orders and promotions report when they were last synced.
- Planner tools on the same server: `draft_basket(items, includeUsual, budgetGrosze?)`, `record_correction`, `list_rules`, `set_brand` and `delete_rule`. Money is in grosze. They read and write the local database only (never Auchan). `approve_basket(lines, unmatched)` saves the approved basket locally; it does not touch the Auchan cart. The `auchan-plan` skill (`.claude/skills/auchan-plan/SKILL.md`) and `/zakupy` drive them from a shopping note. Each draft line carries a match `confidence` (high, medium, low, with a reason) and ranking prefers confident matches; the skill asks about every doubtful line in a clarification step before approval.
- `npm run fill` fills the Auchan cart from the latest basket saved by `approve_basket` (at most 24 hours old). It reads the cart, adds only what is missing in batches of 10, never lowers or removes anything, then reads the cart again and prints a report in Polish: price rises over 10% first, then products out of stock or not added (with substitutes), terms to add by hand, what was already in the cart, and the total. It never opens checkout; pay on Auchan. If it stops on an error, the message says whether a rerun is safe; a rerun reads the cart again and adds nothing twice.
- While a fill runs, `.state/fill.lock` holds JSON `{pid, startedAt}` (stale after 6 hours or when the pid is gone; the busy message names the file to delete) and a `PreToolUse` hook (`.claude/settings.json`, `tools/fill-guard.ts`) blocks the chrome-devtools browser tools. A second hook (`tools/checkout-guard.ts`) always blocks those tools from opening, scripting or clicking checkout, payment and order-summary pages.
- The saved session keeps only the cookies the harness needs (`global_sid` and the load balancer's `AWSALB` / `AWSALBCORS`); trackers and the bot-protection token are never saved or sent. An Auchan bot-protection challenge stops a sync or fill like a 403, with no retry.

## Search (user-approved)

`npm run search-auchan -- <term>...` (up to 10 terms, add `--force` to search again) looks each term up on Auchan in a visible browser window with the dedicated profile, saves the results (products and prices, source `search`) and prints the planner's top match per term. Products found only by search (never bought) are offered as medium-confidence matches, so the app asks about them. Auchan shows a captcha for automated browsers: solve it by hand in the window; the harness waits and never tries to get around it. HTTP 403 or 429 stops the run without retry and pauses all searches for 24 hours; an unexpected page also stops it. It waits 5 seconds between searches, and a term searched in the last 7 days is skipped unless `--force`. Run `npm run sync orders` first (the search needs your delivery region).

## Your data / delete my data

Everything stays on this computer, except what goes to Anthropic as described below.

What is stored:

- `.state/` (owner-only, never committed): the Auchan session cookies (`session.json`, only the login and load-balancer cookies), your orders with delivery times and your region id, product prices, the choices the planner learned (corrections, brands, blocked products), the current trip (`trip.json`) and the app token (`app-token`).
- `tests/fixtures/raw/` (never committed): raw captures of Auchan responses, which can hold personal details. Delete them when you no longer need them.
- The Chromium profile at `~/.cache/chrome-devtools-mcp/zakupy`: the browser login for Auchan, used only for logging in and for the search window.

What goes to Anthropic: the app and the `/zakupy` skill call `claude -p`, which sends your shopping note, product names and prices to Anthropic. Order ids, your region, cookies and the session are not sent.

To delete everything:

```
rm -rf .state tests/fixtures/raw ~/.cache/chrome-devtools-mcp/zakupy
```

Log out on Auchan as well if you want the session to end there.
