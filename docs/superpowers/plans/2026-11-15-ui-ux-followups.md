# UI review and follow-ups

The first browser review covered the then six-step local app (seven steps since 2026-11-16) at desktop and 375 px width. A separate agent reviewed the source against the stage-4 mockup and spec.

## Resolved in this pass

- Keep the payment report in the saved trip and display it in named groups after a refresh.
- Show a Polish explanation for medium and low confidence matches.
- Keep unsubmitted list, budget and “usual” choices while the page rerenders.
- Disable “Nowe zakupy” during a cart fill.
- Show and edit blocked products under “Moje reguły”.
- Label the budget and progress controls, reduce live-region noise, and use numbered step markers with one-sentence descriptions.
- Sync and fill messages reach the app as structured results and are worded in plain Polish (orders, placed orders, promotions, login prompt, failures); the CLI's own output is unchanged.
- Claude's own `ask` options skip low-confidence candidates; with none left the question offers only "Pomiń" and "Dodam sam na Auchan".
- Matcher: a short stem (under 4 letters) meets a vowel or a plain ending (-ka, -ki, -ek, -ce), so "ryba" meets "rybka" while "mąka" still misses "Makar".
- Give each clarification question its own card and provide an explicit next action on the Data step.

## Next UX review with the shopper

1. Try a real list in `npm run app` without approving the cart. Check the chosen products, confidence explanations and question wording.
2. Confirm in the app that the family block for all Szymanowska flours matches the shopper's expectation.
3. After an approved run, check that the report groups and payment hand-off are easy to scan. The app still requires the shopper to pay on Auchan.

## From the pre-merge review (2026-11-15)

- **Placed orders without a status check:** `syncPlaced` stores any order body with lines as 'placed'. Read the order's `status` and store only in-progress statuses (confirm the real values on the next order); skip cancelled/cart statuses; consider dropping placed rows that never became delivered after ~14 days. Placed-order prices use the future delivery date as `seen_at` and win "latest price" until then — use the import time instead.
- ~~**Docs:** README and the stage-4 spec missed placed orders, search, the 24 h block, the CSP `img-src` and four API routes.~~ Done 2026-11-17.
- **Read-only store on an unmigrated DB** throws (write statements prepared unconditionally) — prepare them lazily.
- **Search rank** relies on `productEntities` key order; use `data.search.catalogue.data.productGroups[].products` and check `query.searchTerm`.
- **Cleanup:** duplicated `failureText` (service vs messages.ts), `BLOCKED_TEXT`, `searchBlockText`, three Polish `plural` helpers; redundant checks in `searchAuchan`/`searchPlan`; misplaced comments (fill-cli.ts:122, candidates.ts:78, app.js:443).
- **Small:** ShapeError text "Nic nie zapisano" is wrong mid-sync; an unreadable title is treated as a captcha (5 min wait); unpaid fill order ids are re-queried on every sync.
