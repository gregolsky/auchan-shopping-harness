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
