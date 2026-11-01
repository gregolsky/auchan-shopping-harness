import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPerishable, capQuantity, stockUp, isUsual, lastBoughtText } from '../src/rules.ts';
import type { ProductFacts } from '../src/store.ts';

const fact = (over: Partial<ProductFacts> = {}): ProductFacts => ({
  productId: 'p', name: 'Item', brand: 'Brand', categoryPath: ['Spiżarnia', 'Kawa'], size: '1 kg', timesBought: 0,
  lastBoughtAt: null, usualQuantity: null, latestPriceGrosze: 1000, offerText: null, requiredQuantity: null,
  medianUnitPriceGrosze: 1000, pricePoints: 3, inCatalogue: true, boughtInLatest10: 0, ...over,
});

test('dairy, fruit and an empty path are perishable; coffee, cat food and frozen food are not', () => {
  assert.equal(isPerishable(['Produkty', 'Mleko, nabiał i jaja', 'Mleko']), true);
  assert.equal(isPerishable(['Produkty', 'Owoce, warzywa i zioła']), true);
  assert.equal(isPerishable([]), true);
  assert.equal(isPerishable(['Produkty', 'Kawa, herbata']), false);
  assert.equal(isPerishable(['Produkty', 'Karma dla kotów']), false);
  assert.equal(isPerishable(['Produkty', 'Mrożonki']), false);
});

test('perishable capped at the usual quantity and reported', () => {
  const f = fact({ categoryPath: ['A', 'Sery'], usualQuantity: 1.5 });
  assert.deepEqual(capQuantity(f, 5), { quantity: 2, capped: true });
  assert.deepEqual(capQuantity(f, 2), { quantity: 2, capped: false });
  assert.deepEqual(capQuantity(f, 1), { quantity: 1, capped: false });
  assert.deepEqual(capQuantity(fact({ categoryPath: ['A', 'Sery'] }), 3), { quantity: 1, capped: true });
  assert.deepEqual(capQuantity(fact({ categoryPath: ['A', 'Sery'] }), 1), { quantity: 1, capped: false });
});

test('non-perishable keeps the wanted quantity', () => {
  assert.deepEqual(capQuantity(fact({ usualQuantity: 1 }), 6), { quantity: 6, capped: false });
});

test('stock-up at exactly 80% of the median qualifies, 81% does not', () => {
  assert.deepEqual(stockUp(fact({ latestPriceGrosze: 800 })), { quantity: 2, savingPercent: 20 });
  assert.equal(stockUp(fact({ latestPriceGrosze: 810 })), null);
});

test('no stock-up with fewer than 3 prices, for a perishable, or with no unit price', () => {
  assert.equal(stockUp(fact({ latestPriceGrosze: 500, pricePoints: 2 })), null);
  assert.equal(stockUp(fact({ latestPriceGrosze: 500, categoryPath: ['A', 'Sery'] })), null);
  assert.equal(stockUp(fact({ latestPriceGrosze: 500, size: null })), null);
  assert.equal(stockUp(fact({ latestPriceGrosze: 500, medianUnitPriceGrosze: null })), null);
  assert.equal(stockUp(fact({ latestPriceGrosze: null })), null);
});

test('stock-up saving is measured at the quantity needed to reach the offer', () => {
  const f = fact({ latestPriceGrosze: 400, size: '1 L', medianUnitPriceGrosze: 400, offerText: '3 za 9 zł', requiredQuantity: 3 });
  assert.deepEqual(stockUp(f), { quantity: 3, savingPercent: 25 });
});

test('isUsual is true at 3 of the latest 10 and false at 2', () => {
  assert.equal(isUsual(fact({ boughtInLatest10: 3 })), true);
  assert.equal(isUsual(fact({ boughtInLatest10: 2 })), false);
});

test('lastBoughtText says nothing for a product never bought', () => {
  const now = new Date('2026-11-01T12:00:00Z');
  assert.equal(lastBoughtText(fact(), now), null);
  assert.equal(lastBoughtText(fact({ lastBoughtAt: '2026-11-01T08:00:00Z' }), now), 'last bought today');
  assert.equal(lastBoughtText(fact({ lastBoughtAt: '2026-10-27T12:00:00Z' }), now), 'last bought 5 days ago');
  assert.equal(lastBoughtText(fact({ lastBoughtAt: '2026-10-18T12:00:00Z' }), now), 'last bought 2 weeks ago');
  assert.equal(lastBoughtText(fact({ lastBoughtAt: '2026-09-20T12:00:00Z' }), now), 'last bought 6 weeks ago');
});
