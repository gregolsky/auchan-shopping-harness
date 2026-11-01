# Stage 2: Planner and Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a short note into a reviewed draft basket from local data, and remember what the user corrects.

**Architecture:** Deterministic TypeScript modules do the pricing, ranking and rules. Claude only maps the note to search terms and explains the result, through new `auchan-data` MCP tools. Nothing in this stage contacts Auchan or touches the cart.

**Tech Stack:** Node 26 running TypeScript directly, `node:test`, `node:sqlite`, `@modelcontextprotocol/sdk`, `zod`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-31-auchan-harness-design.md`

## Global Constraints

- Money is integer grosze everywhere.
- Stage 2 makes no request to Auchan, performs no cart writes and has no checkout operation.
- MCP tools may write only to the local database: `intents`, `intent_products`, `corrections`.
- Brands the user names stay fixed unless the user agrees to a swap.
- "A pick with no intent or history behind it is marked as a guess in the draft."
- "Choosing the same product twice for an intent makes it the preferred product." "A single edit affects only that basket."
- Perishables are capped at the usual quantity. The draft never assumes pantry contents.
- Budget produces a warning, not a hard stop.
- Fixtures contain no personal details. Never touch `perf/zakupy-benchmarks.md`.
- Commit messages end with the `Claude-Session` line the session gives.

## Decisions fixed by this plan

These values come from the data synced on 2026-11-01 (21 orders, 551 products, 235 promotion rows).

- **Usual item:** bought in at least 3 of the latest 10 orders. This gives 25 products today.
- **Stock-up:** not perishable, at least 3 past prices, and the effective unit price at most 80% of the product's own median.
- **Perishable categories:** second-level category in `Mleko, nabiał i jaja`, `Owoce, warzywa i zioła`, `Sery`, `Wędliny`, `Ryby i owoce morza`, `Mięso i drób`, `Pieczywo i wyroby cukiernicze`, `Dania gotowe i wyroby garmażeryjne`, `Wypieki`. An empty category path counts as perishable, the safe side for quantity.
- **Offer formats seen:** `N+1 za grosz`, `N  za X,YY zł` (two spaces), `P% taniej`. Any other text is ignored for pricing and kept for display.
- **Candidates come from the local database only.** A term with no match is reported as `unmatched` for the user. Live search belongs to stage 3, because search over HTTP is untested.

## Review Focus

1. A multibuy the quantity does not reach: `2+1 za grosz` at quantity 2 must cost the normal price twice, not the offer price.
2. Products with size `null` or a bare number such as `"0.5"` or `"1"`: unit price is unknown and must not rank as cheapest.
3. Polish diacritics and case: "maka", "mąka" and "MĄKA" must find the same products.
4. A brand-fixed intent such as "nutella" must not offer a cheaper other brand, and wafers must not outrank the spread the user accepted.
5. Deleting a rule must stop it affecting the next draft, while the corrections stay as history.

---

### Task 1: Pricing

**Files:**
- Create: `src/pricing.ts`
- Test: `tests/pricing.test.ts`

**Interfaces:**
- Produces:
  - `type Offer = { kind: 'free'; paid: number } | { kind: 'bundle'; count: number; totalGrosze: number } | { kind: 'percent' }`
  - `parseOffer(text: string | null): Offer | null`
  - `lineCost(priceGrosze: number, offer: Offer | null, quantity: number): number`
  - `parseSize(size: string | null): { amount: number; unit: 'kg' | 'L' } | null`
  - `unitPriceGrosze(lineCostGrosze: number, quantity: number, size: string | null): number | null` (per kg or L)

- [ ] **Step 1: Write the failing tests**

```ts
test('parseOffer reads the real offer formats', () => {
  assert.deepEqual(parseOffer('2+1 za grosz'), { kind: 'free', paid: 2 });
  assert.deepEqual(parseOffer('2  za 15,70 zł'), { kind: 'bundle', count: 2, totalGrosze: 1570 });
  assert.deepEqual(parseOffer('27% taniej'), { kind: 'percent' });
  assert.equal(parseOffer('Nowość'), null);
  assert.equal(parseOffer(null), null);
});
test('a free item costs one grosz and only when the quantity reaches it', () => {
  const offer = parseOffer('2+1 za grosz');
  assert.equal(lineCost(399, offer, 2), 798);
  assert.equal(lineCost(399, offer, 3), 799);
  assert.equal(lineCost(399, offer, 4), 1198);
  assert.equal(lineCost(399, offer, 6), 1598);
});
test('a bundle price applies to whole bundles only', () => {
  const offer = parseOffer('2  za 15,70 zł');
  assert.equal(lineCost(899, offer, 1), 899);
  assert.equal(lineCost(899, offer, 2), 1570);
  assert.equal(lineCost(899, offer, 3), 2469);
});
test('a percent offer is already in the current price', () => {
  assert.equal(lineCost(1395, parseOffer('27% taniej'), 2), 2790);
});
test('unit price needs a real size', () => {
  assert.deepEqual(parseSize('0.5kg'), { amount: 0.5, unit: 'kg' });
  assert.deepEqual(parseSize('1L'), { amount: 1, unit: 'L' });
  assert.equal(parseSize('0.5'), null);
  assert.equal(parseSize('1'), null);
  assert.equal(parseSize(null), null);
  assert.equal(unitPriceGrosze(798, 2, '0.5kg'), 798);
  assert.equal(unitPriceGrosze(399, 1, null), null);
});
```

- [ ] **Step 2: Run `node --test tests/pricing.test.ts`.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement `src/pricing.ts`.** A free offer of `paid` N gives every (N+1)th item for 1 grosz. Round unit prices to whole grosze.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: price lines with multibuy offers and unit sizes`.

### Task 2: Intents and corrections in the store

**Files:**
- Modify: `src/store.ts`
- Test: `tests/store-learning.test.ts`

**Interfaces:**
- Consumes: `openStore`, `Store`.
- Produces on `Store`:
  - `recordCorrection(c: { term: string; proposedProductId: string | null; chosenProductId: string | null; reason?: string }): void`
  - `intentRules(term?: string): IntentRule[]`
  - `setBrandFixed(term: string, brand: string | null): void`
  - `deleteRule(term: string): void`
- `IntentRule`: `{ term: string; brand: string | null; preferredProductId: string | null; acceptedProductIds: string[] }`

Tables, all `CREATE TABLE IF NOT EXISTS`:

- `intents(term TEXT PRIMARY KEY, brand TEXT)`
- `intent_products(term TEXT, product_id TEXT REFERENCES products, times_chosen INTEGER NOT NULL, PRIMARY KEY (term, product_id))`
- `corrections(id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL, proposed_product_id TEXT, chosen_product_id TEXT, reason TEXT, created_at TEXT NOT NULL)`

Terms are stored through `normaliseTerm` from Task 3's file; define it here in `src/store.ts` as `export function normaliseTerm(s: string): string` (trim, lower case, strip diacritics including `ł`). Task 3 imports it.

- [ ] **Step 1: Write the failing tests**

```ts
test('one choice is accepted but not preferred, and a second makes it preferred', () => {
  s.recordCorrection({ term: 'Mleko', proposedProductId: 'a', chosenProductId: 'b' });
  assert.deepEqual(s.intentRules('mleko'), [{ term: 'mleko', brand: null, preferredProductId: null, acceptedProductIds: ['b'] }]);
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: 'b' });
  assert.equal(s.intentRules('mleko')[0].preferredProductId, 'b');
});
test('a newer product chosen twice replaces the preferred one', () => { /* b twice, c twice: preferred is c, both stay accepted */ });
test('removing a line is recorded but teaches no product', () => {
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: null, reason: 'niepotrzebne' });
  assert.deepEqual(s.intentRules('mleko'), []);
  assert.equal(countCorrections(s), 1);
});
test('deleting a rule keeps the corrections', () => { /* rule gone, corrections count unchanged */ });
test('terms match without diacritics or case', () => {
  assert.equal(normaliseTerm(' MĄKA '), 'maka');
  assert.equal(normaliseTerm('Łosoś'), 'losos');
});
```

For "replaces the preferred one", the preferred product is the one that most recently reached two choices. Add `last_chosen_at TEXT NOT NULL` to `intent_products` and pick, among products with `times_chosen >= 2`, the latest.

- [ ] **Step 2: Run `node --test tests/store-learning.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement the tables and methods.**
- [ ] **Step 4: Run the test.** Expected: PASS. Then `npm test` and `npm run typecheck`, all clean.
- [ ] **Step 5: Commit** with `feat: store intents and corrections`.

### Task 3: Candidate ranking

**Files:**
- Create: `src/candidates.ts`
- Modify: `src/store.ts` (read method only)
- Test: `tests/candidates.test.ts`

**Interfaces:**
- Consumes: `normaliseTerm`, `intentRules`, `Offer` functions from Task 1.
- Produces:
  - `Store.productFacts(): ProductFacts[]`, one row per product: `{ productId, name, brand, categoryPath: string[], size, timesBought, lastBoughtAt: string | null, usualQuantity: number | null, latestPriceGrosze: number | null, offerText: string | null, requiredQuantity: number | null, medianUnitPriceGrosze: number | null, pricePoints: number, inCatalogue: boolean, boughtInLatest10: number }`. `usualQuantity` is the median line quantity. Offer fields come only from rows seen in the latest promotion sync.
  - `rankCandidates(term: string, quantity: number, facts: ProductFacts[], rule: IntentRule | null): Candidate[]`
  - `Candidate`: `ProductFacts & { lineCostGrosze: number | null; unitPriceGrosze: number | null; basis: 'preferred' | 'accepted' | 'history' | 'value'; guess: boolean }`

Matching: every word of the normalised term appears in the normalised name or brand. Excludes `inCatalogue: false` and rows with no price.

Order: preferred, accepted, bought before (more purchases first), then the rest. Within a group, lower unit price first, and unknown unit price after known. `guess` is true only for `basis: 'value'`.

If `rule.brand` is set, only that brand's products are returned.

- [ ] **Step 1: Write the failing tests**, built from small inline `ProductFacts`:
  - `preferred outranks a cheaper product`
  - `accepted products are never hidden by history`
  - `purchase count beats value within history`
  - `a bigger pack wins on unit price among products never bought, and is marked as a guess`
  - `a product with no known unit price ranks after one with a known price`
  - `the unit price uses the offer only if the quantity reaches it`
  - `"maka" finds "Mąka pszenna"`
  - `a fixed brand returns only that brand, even when another is cheaper`
  - `regression: "nutella" with the spread accepted does not lead with wafers`
  - `regression: a catering 3L syrup does not outrank the usual bottle the user bought`
  - `regression: loose ham with no size does not outrank sliced ham that was bought`
- [ ] **Step 2: Run `node --test tests/candidates.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `productFacts` and `rankCandidates`.** Compute the median in TypeScript. One query per table, no query per product.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: rank candidates by intent, history and value`.

### Task 4: Perishable and stock-up rules

**Files:**
- Create: `src/rules.ts`
- Test: `tests/rules.test.ts`

**Interfaces:**
- Consumes: `ProductFacts`, Task 1 functions.
- Produces:
  - `isPerishable(categoryPath: string[]): boolean`
  - `capQuantity(facts: ProductFacts, wanted: number): { quantity: number; capped: boolean }`
  - `stockUp(facts: ProductFacts): { quantity: number; savingPercent: number } | null`
  - `isUsual(facts: ProductFacts): boolean`
  - `lastBoughtText(facts: ProductFacts, now: Date): string | null`, such as `last bought 6 weeks ago`

Rule values are in "Decisions fixed by this plan". `capQuantity` leaves non-perishables alone, and caps perishables with no history at 1 only if `wanted` is above 1 and sets `capped`. `stockUp` uses `requiredQuantity` when the offer has one, otherwise 2.

- [ ] **Step 1: Write the failing tests:**
  - `dairy, fruit and an empty path are perishable; coffee, cat food and frozen food are not`
  - `perishable capped at the usual quantity and reported`
  - `non-perishable keeps the wanted quantity`
  - `stock-up at exactly 80% of the median qualifies, 81% does not`
  - `no stock-up with fewer than 3 prices, for a perishable, or with no unit price`
  - `stock-up saving is measured at the quantity needed to reach the offer`
  - `isUsual is true at 3 of the latest 10 and false at 2`
  - `lastBoughtText says nothing for a product never bought`
- [ ] **Step 2: Run `node --test tests/rules.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `src/rules.ts`.**
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: add perishable caps and stock-up rules`.

### Task 5: Draft builder

**Files:**
- Create: `src/draft.ts`
- Test: `tests/draft.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 4.
- Produces:
  - `buildDraft(input: DraftInput, facts: ProductFacts[], rules: IntentRule[], now: Date): Draft`
  - `DraftInput`: `{ items: { term: string; quantity: number }[]; includeUsual: boolean; budgetGrosze?: number }`
  - `Draft`: `{ items: DraftLine[]; stockUps: DraftLine[]; promotions: DraftLine[]; addOns: DraftLine[]; unmatched: string[]; totalGrosze: number; overBudgetGrosze: number | null }`
  - `DraftLine`: `{ term: string | null; productId: string; name: string; quantity: number; lineCostGrosze: number; reason: string; guess: boolean; capped: boolean; lastBought: string | null; alternatives: { productId: string; name: string; lineCostGrosze: number }[] }`

Group rules:

- `items`: the top candidate per term, plus usual products when `includeUsual` is true. Usual lines use the usual quantity. At most 3 alternatives.
- `stockUps`: products in the draft or usual list with a `stockUp` result. Up to 5, biggest saving first. They are not in the total.
- `promotions`: promoted products bought before and not already listed. Up to 10, by saving.
- `addOns`: products bought in at least 3 of all orders, not usual, not listed, with the oldest `lastBoughtAt` first. Up to 5.
- No product appears in two groups. A product named in `items` wins over its usual line, and the quantity stays the one the user wrote.

`totalGrosze` sums `items` only. `overBudgetGrosze` is null when there is no budget or the total fits.

- [ ] **Step 1: Write the failing tests:**
  - `a term becomes one line with a reason and up to 3 alternatives`
  - `usual products join when asked, and not otherwise`
  - `an item the user names keeps their quantity over the usual line`
  - `no product appears in two groups`
  - `a term with no match goes to unmatched and the draft still builds`
  - `a guess is marked and its reason says so`
  - `a capped perishable is marked`
  - `over budget is a warning number and all lines stay`
  - `stock-ups and promotions are not in the total`
- [ ] **Step 2: Run `node --test tests/draft.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement `src/draft.ts`** as pure functions with no database access.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat: build the draft basket`.

### Task 6: MCP tools and the planner skill

**Files:**
- Modify: `src/mcp.ts`, `README.md`
- Create: `.claude/skills/auchan-plan/SKILL.md`
- Test: `tests/mcp.test.ts`

**Interfaces:**
- Consumes: `buildDraft`, `Store` methods.
- Produces these tools, with zod schemas and the existing data-age fields:
  - `draft_basket({ items, includeUsual, budgetGrosze? })` returns a `Draft`
  - `record_correction({ term, proposedProductId?, chosenProductId?, reason? })`
  - `list_rules()`
  - `set_brand({ term, brand })`, where a null brand frees it
  - `delete_rule({ term })`

The four existing read tools stay read-only. The new write tools open the store writable. All failures use the existing fixed-text error path.

The skill tells Claude to: map the note to `items` (polish terms, "usual stuff" means `includeUsual: true`); call `draft_basket`; show the groups, each line's price and reason, and any guess or cap; record each user change with `record_correction`; call `set_brand` only when the user names a brand; and stop there. It says that cart filling arrives in stage 3, and never uses browser tools.

- [ ] **Step 1: Write the failing tests:**
  - `draft_basket returns the groups from a seeded store`
  - `record_correction twice changes the next draft`
  - `delete_rule stops the rule affecting the next draft and keeps the corrections`
  - `set_brand limits candidates, and null frees them`
  - `the tool list has no cart, checkout or order tool`
  - `no module the MCP server imports can reach Auchan` (the module graph from `src/mcp.ts` does not include `src/worker.ts` or `src/http-worker.ts`)
- [ ] **Step 2: Run `node --test tests/mcp.test.ts`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement the tools.** If `src/mcp.ts` reaches the worker today through `cli.ts`, move what it needs so the import test can pass.
- [ ] **Step 4: Write the skill and the README section.**
- [ ] **Step 5: Run `npm test` and `npm run typecheck`.** Expected: all pass, typecheck clean.
- [ ] **Step 6: Commit** with `feat: expose the planner through MCP and a skill`.

### Task 7: History replay

**Files:**
- Create: `tools/replay.ts`
- Modify: `README.md`
- Test: `tests/replay.test.ts`

**Interfaces:**
- Consumes: `buildDraft`, `Store`.
- Produces:
  - `replayOrder(target: { productId: string }[], draft: Draft): { recall: number; precision: number }`, where a hit is a line in `items` with a product from the target order
  - `npm run replay`, which replays each of the latest 5 orders using only orders before it, with `includeUsual: true` and no terms, and prints one line per order plus the average

The replay measures the usual list only, because no real notes exist for old orders. It reads the real database and prints only counts and percentages, never product names.

- [ ] **Step 1: Write the failing tests:**
  - `recall and precision on a small example`
  - `an empty draft gives zero, not a crash`
  - `the replay sees no order from the target's date or later`
- [ ] **Step 2: Run `node --test tests/replay.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement it.** Add an `asOf` option to `Store.productFacts` for the date cut-off. Keep today's default behaviour.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Run `npm run replay` on the real database.** Expected: one line per order, no product names. Record the average in the spec under Testing.
- [ ] **Step 6: Commit** with `feat: replay old orders to measure the draft`.
