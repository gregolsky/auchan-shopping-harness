# UI review and follow-ups

The first browser review covered the six-step local app at desktop and 375 px width. A separate agent reviewed the source against the stage-4 mockup and spec.

## Resolved in this pass

- Keep the payment report in the saved trip and display it in named groups after a refresh.
- Show a Polish explanation for medium and low confidence matches.
- Keep unsubmitted list, budget and “usual” choices while the page rerenders.
- Disable “Nowe zakupy” during a cart fill.
- Show and edit blocked products under “Moje reguły”.
- Label the budget and progress controls, reduce live-region noise, and use numbered step markers with one-sentence descriptions.
- Give each clarification question its own card and provide an explicit next action on the Data step.

## Next UX review with the shopper

1. Try a real list in `npm run app` without approving the cart. Check the chosen products, confidence explanations and question wording.
2. Confirm in the app that the family block for all Szymanowska flours matches the shopper's expectation.
3. After an approved run, check that the report groups and payment hand-off are easy to scan. The app still requires the shopper to pay on Auchan.

## To fix (reported by the shopper, 2026-11-15)

- **Sync and fill messages are unclear.** After "Odśwież dane" the page shows the CLI's English technical lines ("orders: imported 0, skipped 21, oldest seen …; zero-quantity lines …", "promotions: 263 products from 10 pages", "capped (may be incomplete): /promotions/…"). Show plain Polish instead, e.g. "Zamówienia: brak nowych (21 już w bazie). Nowe pojawiają się po dostawie." and "Promocje: 263 produkty odświeżone; 5 kategorii mogło się nie wczytać w całości." Same review for every log line the app passes through from `src/cli.ts` and `src/fill-cli.ts` (login prompt, plan total, progress, failures). Keep the CLI's own output unchanged; translate in the app layer, with tests.
- **Claude's own `ask` options** are not filtered for low-confidence candidates (pet treats could still appear when Claude asks). Filter them like the planner's questions.
- **Matcher regression:** after the "mąka"/"Makar" fix, a short stem allows only one extra letter, so "ryba" no longer matches "rybka". Find a rule that keeps both.
