import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.ts';
import { buildDraft } from '../src/draft.ts';
import { planFill } from '../src/cart.ts';
import type { ProductFacts } from '../src/store.ts';
import { isBlockedProduct } from '../src/blacklist.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ID = '2cb9b09d-205d-48eb-9441-ea0f59e06aae';
const NAME = 'Mąka Szymanowska pszenna typ 480 Polskie Młyny 1 kg';
const other = '00000000-0000-4000-8000-000000000001';

test('blacklisted flour never becomes a draft item, alternative, or suggestion', () => {
  const base: ProductFacts = { productId: ID, name: NAME, brand: 'Polskie Młyny', categoryPath: [], size: '1 kg', timesBought: 5,
    lastBoughtAt: null, usualQuantity: 1, latestPriceGrosze: 500, offerText: null, requiredQuantity: null,
    medianUnitPriceGrosze: null, pricePoints: 0, inCatalogue: true, boughtInLatest10: 5, seenInLatestPromotions: false };
  const draft = buildDraft({ items: [{ term: 'mąka', quantity: 1 }], includeUsual: true }, [base, { ...base, productId: other, name: 'Mąka pszenna inna', timesBought: 1, boughtInLatest10: 0 }], [], new Date());
  assert.deepEqual(draft.items.map((l) => l.productId), [other]);
  assert.ok(draft.items.every((l) => l.alternatives.every((a) => a.productId !== ID)));
  assert.ok([...draft.stockUps, ...draft.promotions, ...draft.addOns].every((l) => l.productId !== ID));
});

test('approval rejects the blocked product even when the caller supplies its ID directly', () => {
  const store = openStore(':memory:');
  store.savePromotions({ regionId: 'r', products: [{ productId: ID, retailerProductId: '00104664', name: NAME, brand: 'Polskie Młyny', categoryPath: [], unitLabel: 'kg', size: '1 kg', inCatalogue: true }],
    prices: [{ productId: ID, seenAt: new Date().toISOString(), regionId: 'r', source: 'promotion', originalGrosze: null, currentGrosze: 500, unitCurrentGrosze: 500, offerText: null, requiredQuantity: null }] });
  assert.throws(() => store.approveBasket([{ term: 'mąka', productId: ID, quantity: 1 }], []), /zablokowan/i);
  assert.equal(store.latestApprovedBasket(), null);
  store.close();
});

test('a saved basket cannot send a newly blacklisted product to the cart', () => {
  assert.deepEqual(planFill([{ term: 'mąka', productId: ID, name: NAME, quantity: 1, approvedPriceGrosze: 500 }], []).send, []);
});

test('a relisted Szymanowska type 480 is blocked by its name, but other flour is allowed', () => {
  assert.equal(isBlockedProduct({ productId: other, name: NAME }), true);
  assert.equal(isBlockedProduct({ productId: other, name: 'Mąka pszenna typ 480 inna marka' }), false);
});

test('the app can search, block, unblock and persist catalog products', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'blacklist-')), 'harness.db');
  const product = (productId: string, name: string) => ({ productId, retailerProductId: productId, name, brand: '', categoryPath: [], unitLabel: 'kg', size: '1 kg', inCatalogue: true });
  const price = (productId: string) => ({ productId, seenAt: new Date().toISOString(), regionId: 'r', source: 'promotion' as const, originalGrosze: null, currentGrosze: 500, unitCurrentGrosze: 500, offerText: null, requiredQuantity: null });
  let store = openStore(file);
  const pasta = '00000000-0000-4000-8000-000000000002';
  const rice = '00000000-0000-4000-8000-000000000003';
  store.savePromotions({ regionId: 'r', products: [product(ID, NAME), product(other, 'Mąka pszenna inna'), product(pasta, 'Makaron spaghetti'), product(rice, 'Ryż preparowany Makar')], prices: [price(ID), price(other), price(pasta), price(rice)] });
  assert.deepEqual(store.searchProducts('maka').map((p) => p.productId).sort(), [other, ID].sort());
  assert.deepEqual(store.blockedProducts().map((p) => p.productId), [ID]);
  store.blockProduct(other);
  assert.throws(() => store.approveBasket([{ term: 'mąka', productId: other, quantity: 1 }], []), /zablokowan/i);
  store.close();

  store = openStore(file);
  assert.deepEqual(store.blockedProducts().map((p) => p.productId).sort(), [other, ID].sort());
  store.unblockProduct(ID);
  assert.equal(isBlockedProduct({ productId: ID, name: NAME }, store.blockedProducts()), false);
  assert.doesNotThrow(() => store.approveBasket([{ term: 'mąka', productId: ID, quantity: 1 }], []));
  store.unblockProduct(other);
  store.close();
  assert.deepEqual(openStore(file).blockedProducts(), []);
});

test('a custom blocked product is excluded from drafts and the cart plan', () => {
  const product = { productId: other, name: 'Mąka pszenna inna' };
  const blocks = [product];
  const fact: ProductFacts = { ...product, brand: '', categoryPath: [], size: '1 kg', timesBought: 5, lastBoughtAt: null, usualQuantity: 1,
    latestPriceGrosze: 500, offerText: null, requiredQuantity: null, medianUnitPriceGrosze: null, pricePoints: 0, inCatalogue: true,
    boughtInLatest10: 5, seenInLatestPromotions: false };
  const draft = buildDraft({ items: [{ term: 'mąka', quantity: 1 }], includeUsual: true }, [fact], [], new Date(), blocks);
  assert.deepEqual(draft.unmatched, []);
  assert.deepEqual(draft.blocked, ['mąka']);
  assert.deepEqual(planFill([{ term: 'mąka', productId: other, name: product.name, quantity: 1, approvedPriceGrosze: 500 }], [], blocks).send, []);
});
