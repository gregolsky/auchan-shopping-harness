# domestic-ai

Local Claude Code commands for household automation, scoped to this working directory.
Invoke any skill by typing `/<name>` inside a Claude Code session started from this directory.

## Shopping app

`npm run app` is the main way to shop. It starts a local page with a six-step wizard: **Dane → Szkic → Doprecyzowanie → Zatwierdzenie → Koszyk → Płatność**. Paste a list, review the matches, answer the uncertain ones, then approve to add the products to the Auchan cart.

- The server prints one URL, `http://127.0.0.1:<port>/?t=<token>`. It listens on 127.0.0.1 only and every request needs the random token, so open exactly that printed URL. The token changes on every start, so after restarting the app open the newly printed URL.
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
- `npm run sync check` tests the request format before a full import: it reads one orders page and one order, stores nothing, and prints `ok` with the order count. If Auchan refuses it, do not rerun.
- `npm run replay` replays the latest 5 orders against the draft's usual list, each using only the orders before it, and prints recall and precision per order plus the average. It reads the local database only and never prints product names.
- The `auchan-data` MCP server (`.mcp.json`) reads that database only and never contacts Auchan. Tools: `recent_orders(limit)`, `product_history(query)` and `current_promotions(bought_before, limit)`. Orders and promotions report when they were last synced.
- Planner tools on the same server: `draft_basket(items, includeUsual, budgetGrosze?)`, `record_correction`, `list_rules`, `set_brand` and `delete_rule`. Money is in grosze. They read and write the local database only (never Auchan). `approve_basket(lines, unmatched)` saves the approved basket locally; it does not touch the Auchan cart. The `auchan-plan` skill (`.claude/skills/auchan-plan/SKILL.md`) and `/zakupy` drive them from a shopping note. Each draft line carries a match `confidence` (high, medium, low, with a reason) and ranking prefers confident matches; the skill asks about every doubtful line in a clarification step before approval.
- `npm run fill` fills the Auchan cart from the latest basket saved by `approve_basket` (at most 24 hours old). It reads the cart, adds only what is missing in batches of 10, never lowers or removes anything, then reads the cart again and prints a report in Polish: price rises over 10% first, then products out of stock or not added (with substitutes), terms to add by hand, what was already in the cart, and the total. It never opens checkout; pay on Auchan. If it stops on an error, the message says whether a rerun is safe; a rerun reads the cart again and adds nothing twice.
- While a fill runs, `.state/fill.lock` holds JSON `{pid, startedAt}` (stale after 6 hours or when the pid is gone; the busy message names the file to delete) and a `PreToolUse` hook (`.claude/settings.json`, `tools/fill-guard.ts`) blocks the chrome-devtools browser tools.
