# domestic-ai

Local Claude Code commands for household automation, scoped to this working directory.
Invoke any skill by typing `/<name>` inside a Claude Code session started from this directory.

## Skills

| Command | Description |
|---------|-------------|
| `/zakupy` | Auchan grocery shopping assistant — searches products, picks the cheapest match, adds to cart, and stops before checkout |

## Auchan data layer

A local, read-only copy of order history and promotions, kept in `.state/harness.db`.

- `npm run sync` (or `npm run sync orders` / `npm run sync promotions`) fetches the data over plain HTTP with the saved session in `.state/session.json`. A browser window opens only when a login is needed. Log in in that window and leave it open: the harness saves the session, closes the window and continues the sync on its own. The sync only reads; it never changes the cart.
- `npm run sync check` tests the request format before a full import: it reads one orders page and one order, stores nothing, and prints `ok` with the order count. If Auchan refuses it, do not rerun.
- `npm run replay` replays the latest 5 orders against the draft's usual list, each using only the orders before it, and prints recall and precision per order plus the average. It reads the local database only and never prints product names.
- The `auchan-data` MCP server (`.mcp.json`) reads that database only and never contacts Auchan. Tools: `recent_orders(limit)`, `product_history(query)` and `current_promotions(bought_before, limit)`. Orders and promotions report when they were last synced.
- Planner tools on the same server: `draft_basket(items, includeUsual, budgetGrosze?)`, `record_correction`, `list_rules`, `set_brand` and `delete_rule`. Money is in grosze. They read and write the local database only (never Auchan). `approve_basket(lines, unmatched)` saves the approved basket locally; it does not touch the Auchan cart. The `auchan-plan` skill (`.claude/skills/auchan-plan/SKILL.md`) and `/zakupy` drive them from a shopping note.
- `npm run fill` fills the Auchan cart from the latest basket saved by `approve_basket` (at most 24 hours old). It reads the cart, adds only what is missing in batches of 10, never lowers or removes anything, then reads the cart again and prints a report in Polish: price rises over 10% first, then products out of stock or not added (with substitutes), terms to add by hand, what was already in the cart, and the total. It never opens checkout; pay on Auchan. If it stops on an error, the message says whether a rerun is safe; a rerun reads the cart again and adds nothing twice.
- While a fill runs, `.state/fill.lock` holds its process id and a `PreToolUse` hook (`.claude/settings.json`, `tools/fill-guard.ts`) blocks the chrome-devtools browser tools.
