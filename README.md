# domestic-ai

Local Claude Code commands for household automation, scoped to this working directory.
Invoke any skill by typing `/<name>` inside a Claude Code session started from this directory.

## Skills

| Command | Description |
|---------|-------------|
| `/zakupy` | Auchan grocery shopping assistant — searches products, picks the cheapest match, adds to cart, and stops before checkout |

## Auchan data layer

A local, read-only copy of order history and promotions, kept in `.state/harness.db`.

- `npm run sync` (or `npm run sync orders` / `npm run sync promotions`) fetches the data over plain HTTP with the saved session in `.state/session.json`. A browser window opens only when a login is needed. Close the chrome-devtools MCP browser first, because both use the same profile. If you are not logged in, the sync stops and leaves the browser window open: log in there, close the window, then rerun. The sync only reads; it never changes the cart.
- `npm run sync check` tests the request format before a full import: it reads one orders page and one order, stores nothing, and prints `ok` with the order count. If Auchan refuses it, do not rerun.
- `npm run replay` replays the latest 5 orders against the draft's usual list, each using only the orders before it, and prints recall and precision per order plus the average. It reads the local database only and never prints product names.
- The `auchan-data` MCP server (`.mcp.json`) reads that database only and never contacts Auchan. Tools: `recent_orders(limit)`, `product_history(query)` and `current_promotions(bought_before, limit)`. Orders and promotions report when they were last synced.
- Planner tools on the same server: `draft_basket(items, includeUsual, budgetGrosze?)`, `record_correction`, `list_rules`, `set_brand` and `delete_rule`. Money is in grosze. They read and write the local database only (never Auchan) and there is no cart tool. The `auchan-plan` skill (`.claude/skills/auchan-plan/SKILL.md`) drives them from a shopping note; cart filling arrives in stage 3.
