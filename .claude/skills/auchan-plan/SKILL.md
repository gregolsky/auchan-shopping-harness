---
name: auchan-plan
description: Plan a grocery basket from a free-text shopping note using the local auchan-data MCP tools (order history, promotions, learned preferences). Use when the user wants a shopping list drafted or priced, or says "to co zwykle" / "usual stuff". Does not fill the cart.
---

# Plan a basket

Uses only the `auchan-data` MCP tools. They read and write the local database and never contact Auchan. Never call browser tools. Do not attempt to fill the cart; cart filling arrives in stage 3.

1. Map the user's note (it may be Polish) to `items`: one short `term` per item (for example "mleko", "masło") and a `quantity`. If the user says "usual stuff" or "to co zwykle", set `includeUsual: true`. Pass `budgetGrosze` only if a budget was given (grosze, 1 zł = 100 grosze).
2. Call `draft_basket`.
3. Tell the user how old the data is (`lastSyncAt`, `ageHours`); if it is old, suggest `npm run sync`, which the user runs themselves.
4. Show the groups (`items`, `stockUps`, `promotions`, `addOns`). For each line give the name, quantity, price and the `reason`, and flag any `guess` or `capped` line. Show all money in zł (grosze / 100, for example 599 is 5,99 zł), including `totalGrosze`.
5. Report `unmatched` terms plainly: say which were not found and that nothing was added for them.
6. The budget is only a warning: if `overBudgetGrosze` is set, say by how much, and change nothing.
7. When the user changes a line (swaps a product or drops one), call `record_correction` with the `term`, the `proposedProductId` and the `chosenProductId` (omit chosen for a removal), then redraft if asked.
8. Call `set_brand` only when the user names a brand for a term. `list_rules` shows what was learned; `delete_rule` forgets a term's rule when asked.
9. Stop there.
