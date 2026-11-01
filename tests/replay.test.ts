import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import type { Draft, DraftLine } from '../src/draft.ts';
import type { Product, PriceObservation } from '../src/types.ts';
import { replayOrder, replayLatest } from '../tools/replay.ts';

const lineOf = (productId: string): DraftLine => ({
  term: null, productId, name: productId, quantity: 1, lineCostGrosze: 100, reason: '', guess: false, capped: false, lastBought: null, alternatives: [],
});
const draftOf = (ids: string[]): Draft => ({ items: ids.map(lineOf), stockUps: [], promotions: [], addOns: [], unmatched: [], totalGrosze: 0, overBudgetGrosze: null });

test('recall and precision on a small example', () => {
  const r = replayOrder([{ productId: 'a' }, { productId: 'b' }, { productId: 'c' }, { productId: 'd' }], draftOf(['a', 'b', 'x']));
  assert.equal(r.recall, 0.5);
  assert.equal(r.precision, 2 / 3);
});

test('an empty draft gives zero, not a crash', () => {
  assert.deepEqual(replayOrder([{ productId: 'a' }], draftOf([])), { recall: 0, precision: 0 });
  assert.deepEqual(replayOrder([], draftOf(['a'])), { recall: 0, precision: 0 });
});

const product = (productId: string): Product => ({
  productId, retailerProductId: `r-${productId}`, name: `Product ${productId}`, brand: 'Brand',
  categoryPath: ['A'], unitLabel: null, size: null, inCatalogue: true,
});
const price = (productId: string, seenAt: string, g: number): PriceObservation => ({
  productId, seenAt, regionId: 'r1', source: 'order', originalGrosze: null, currentGrosze: g, unitCurrentGrosze: null, offerText: null, requiredQuantity: null,
});
const addOrder = (s: ReturnType<typeof openStore>, orderId: string, deliveredAt: string, ids: string[], g = 500) =>
  s.saveOrder({
    order: { orderId, deliveredAt, totalGrosze: 1000, regionId: 'r1' },
    lines: ids.map((productId) => ({ orderId, productId, quantity: 1, pricePerItemGrosze: g })),
    products: ids.map(product),
    prices: ids.map((id) => price(id, deliveredAt, g)),
  });

test('the replay sees no order from the target\'s date or later', () => {
  const s = openStore(':memory:');
  addOrder(s, 'o1', '2026-01-01T10:00:00Z', ['a'], 500);
  addOrder(s, 'o2', '2026-02-01T10:00:00Z', ['a'], 600);
  addOrder(s, 'o3', '2026-03-01T10:00:00Z', ['a', 'z'], 900);
  const f = s.productFacts({ asOf: '2026-03-01T10:00:00Z' });
  const a = f.find((x) => x.productId === 'a')!;
  assert.equal(a.timesBought, 2);
  assert.equal(a.lastBoughtAt, '2026-02-01T10:00:00Z');
  assert.equal(a.latestPriceGrosze, 600);
  assert.equal(a.boughtInLatest10, 2);
  const z = f.find((x) => x.productId === 'z')!;
  assert.equal(z.timesBought, 0);
  assert.equal(z.latestPriceGrosze, null);
  assert.equal(s.productFacts().find((x) => x.productId === 'a')!.timesBought, 3);
  s.close();
});

test('orders with fewer than 3 prior orders are skipped, and say so', () => {
  const s = openStore(':memory:');
  for (let i = 1; i <= 5; i++) addOrder(s, `o${i}`, `2026-0${i}-01T10:00:00Z`, ['a', 'b']);
  const rows = replayLatest(s, 5, new Date('2026-11-01T00:00:00Z'));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].skipped, undefined);
  assert.match(rows.at(-1)!.line, /skipped.*fewer than 3/);
  assert.equal(rows[0].recall, 1);
  assert.equal(rows[0].precision, 1);
  s.close();
});
