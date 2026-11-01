# domestic-ai

Local Claude Code commands for household automation, scoped to this working directory.
Invoke any skill by typing `/<name>` inside a Claude Code session started from this directory.

## Skills

| Command | Description |
|---------|-------------|
| `/zakupy` | Auchan grocery shopping assistant — searches products, picks the cheapest match, adds to cart, and stops before checkout |

## Auchan data layer

A local, read-only copy of order history and promotions, kept in `.state/harness.db`.

- `npm run sync` (or `npm run sync orders` / `npm run sync promotions`) fetches the data through the harness browser profile. Close the chrome-devtools MCP browser first, because both use the same profile. If you are not logged in, the sync stops and leaves the browser window open: log in there, close the window, then rerun. The sync only reads; it never changes the cart.
- `npm run sync check` tests the request format before a full import: it reads one orders page and one order, stores nothing, and prints `ok` with the order count. If Auchan refuses it, do not rerun.
- The `auchan-data` MCP server (`.mcp.json`) reads that database only and never contacts Auchan. Tools: `recent_orders(limit)`, `product_history(query)` and `current_promotions(bought_before, limit)`. Orders and promotions report when they were last synced.
