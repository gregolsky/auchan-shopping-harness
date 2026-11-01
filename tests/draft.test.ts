import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft } from '../src/draft.ts';
import type { IntentRule, ProductFacts } from '../src/store.ts';

const now = new Date('2026-11-01T00:00:00Z');
const fact = (productId: string, over: Partial<ProductFacts> = {}): ProductFacts => ({
  productId, name: `Item ${productId}`, brand: 'Brand', categoryPath: ['Produkty', 'Kawa, herbata'], size: '1 kg', timesBought: 0,
  lastBoughtAt: null, usualQuantity: null, latestPriceGrosze: 1000, offerText: null, requiredQuantity: null,
  medianUnitPriceGrosze: null, pricePoints: 0, inCatalogue: true, boughtInLatest10: 0, ...over,
});
const usual = (id: string, over: Partial<ProductFacts> = {}) => fact(id, { timesBought: 5, boughtInLatest10: 4, usualQuantity: 2, lastBoughtAt: '2026-10-20T00:00:00Z', ...over });
const input = (items: { term: string; quantity: number }[], includeUsual = false, budgetGrosze?: number) => ({ items, includeUsual, budgetGrosze });

test('a term becomes one line with a reason and up to 3 alternatives', () => {
  const facts = ['a', 'b', 'c', 'd', 'e'].map((id, i) => fact(id, { name: `Kawa ${id}`, timesBought: 5 - i }));
  const d = buildDraft(input([{ term: 'kawa', quantity: 2 }]), facts, [], now);
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].productId, 'a');
  assert.equal(d.items[0].reason, 'bought 5 times');
  assert.equal(d.items[0].lineCostGrosze, 2000);
  assert.equal(d.items[0].alternatives.length, 3);
});

test('usual products join when asked, and not otherwise', () => {
  const facts = [usual('u', { usualQuantity: 1.2 })];
  assert.equal(buildDraft(input([]), facts, [], now).items.length, 0);
  const d = buildDraft(input([], true), facts, [], now);
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].quantity, 2);
  assert.equal(d.items[0].reason, 'bought in 4 of the latest 10 orders');
  assert.equal(d.items[0].term, null);
});

test('an item the user names keeps their quantity over the usual line', () => {
  const facts = [usual('u', { name: 'Kawa mielona' })];
  const d = buildDraft(input([{ term: 'kawa', quantity: 5 }], true), facts, [], now);
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].quantity, 5);
});

test('no product appears in two groups', () => {
  const facts = [
    usual('u', { name: 'Kawa mielona', latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4, offerText: '2 za 14 zł', requiredQuantity: 2 }),
    usual('s', { latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4 }),
    fact('p', { timesBought: 1, offerText: '2 za 10 zł', requiredQuantity: 2 }),
    fact('o', { timesBought: 3, lastBoughtAt: '2026-09-01T00:00:00Z' }),
  ];
  const d = buildDraft(input([{ term: 'kawa', quantity: 1 }], true), facts, [], now);
  const ids = [...d.items, ...d.stockUps, ...d.promotions, ...d.addOns].map((l) => l.productId);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(d.items.map((l) => l.productId).sort(), ['s', 'u']);
  assert.deepEqual(d.promotions.map((l) => l.productId), ['p']);
  assert.deepEqual(d.addOns.map((l) => l.productId), ['o']);
});

test('stock-ups draw from products outside items and are not in the total', () => {
  const facts = [usual('s', { latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4 })];
  const d = buildDraft(input([]), facts, [], now);
  assert.equal(d.stockUps.length, 1);
  assert.equal(d.stockUps[0].quantity, 2);
  assert.equal(d.stockUps[0].reason, '30% below its usual unit price');
  assert.equal(d.totalGrosze, 0);
});

test('promotions are not in the total and need a past purchase', () => {
  const facts = [fact('p', { timesBought: 1, offerText: '2 za 10 zł', requiredQuantity: 2 }), fact('n', { offerText: '2 za 10 zł', requiredQuantity: 2 })];
  const d = buildDraft(input([]), facts, [], now);
  assert.deepEqual(d.promotions.map((l) => [l.productId, l.quantity, l.lineCostGrosze]), [['p', 2, 1000]]);
  assert.equal(d.totalGrosze, 0);
});

test('a term with no match goes to unmatched and the draft still builds', () => {
  const d = buildDraft(input([{ term: 'xyz', quantity: 1 }, { term: 'kawa', quantity: 1 }]), [fact('a', { name: 'Kawa' })], [], now);
  assert.deepEqual(d.unmatched, ['xyz']);
  assert.equal(d.items.length, 1);
});

test('a guess is marked and its reason says so', () => {
  const d = buildDraft(input([{ term: 'kawa', quantity: 1 }]), [fact('a', { name: 'Kawa' })], [], now);
  assert.equal(d.items[0].guess, true);
  assert.match(d.items[0].reason, /^guess/);
});

test('a learned rule decides the pick and the reason', () => {
  const rules: IntentRule[] = [{ term: 'Kawa', brand: null, preferredProductId: 'b', acceptedProductIds: ['b'], learnedProductIds: ['b'] }];
  const facts = [fact('a', { name: 'Kawa', timesBought: 9 }), fact('b', { name: 'Kawa', timesBought: 1 })];
  const d = buildDraft(input([{ term: 'kawa', quantity: 1 }]), facts, rules, now);
  assert.equal(d.items[0].productId, 'b');
  assert.equal(d.items[0].reason, 'your usual choice for kawa');
});

test('a capped perishable is marked', () => {
  const facts = [fact('m', { name: 'Mleko', categoryPath: ['Produkty', 'Mleko, nabiał i jaja'], usualQuantity: 1, timesBought: 3 })];
  const d = buildDraft(input([{ term: 'mleko', quantity: 4 }]), facts, [], now);
  assert.equal(d.items[0].quantity, 1);
  assert.equal(d.items[0].capped, true);
  assert.match(d.items[0].reason, /capped/);
  assert.equal(d.items[0].lineCostGrosze, 1000);
});

test('over budget is a warning number and all lines stay', () => {
  const facts = [fact('a', { name: 'Kawa' }), fact('b', { name: 'Herbata' })];
  const its = [{ term: 'kawa', quantity: 1 }, { term: 'herbata', quantity: 1 }];
  const d = buildDraft(input(its, false, 1500), facts, [], now);
  assert.equal(d.items.length, 2);
  assert.equal(d.totalGrosze, 2000);
  assert.equal(d.overBudgetGrosze, 500);
  assert.equal(buildDraft(input(its, false, 2000), facts, [], now).overBudgetGrosze, null);
  assert.equal(buildDraft(input(its), facts, [], now).overBudgetGrosze, null);
});
