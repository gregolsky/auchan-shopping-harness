import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, normaliseTerm } from '../src/store.ts';
import type { Store } from '../src/store.ts';
import type { Product } from '../src/types.ts';

const product = (productId: string): Product => ({
  productId, retailerProductId: `r-${productId}`, name: `Product ${productId}`, brand: 'Brand',
  categoryPath: [], unitLabel: null, size: null, inCatalogue: true,
});

const countCorrections = (s: Store) => s.corrections().length;

let s: Store;
beforeEach(() => {
  s = openStore(':memory:');
  s.savePromotions({ regionId: 'r1', products: ['a', 'b', 'c'].map(product), prices: [] });
});
afterEach(() => s.close());

test('one choice is accepted but not preferred, and a second makes it preferred', () => {
  s.recordCorrection({ term: 'Mleko', proposedProductId: 'a', chosenProductId: 'b' });
  assert.deepEqual(s.intentRules('mleko'), [{ term: 'mleko', brand: null, preferredProductId: null, acceptedProductIds: ['b'], learnedProductIds: [], replacedProductIds: ['a'] }]);
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: 'b' });
  assert.equal(s.intentRules('mleko')[0].preferredProductId, 'b');
  assert.deepEqual(s.intentRules('mleko')[0].learnedProductIds, ['b']);
});

test('a newer product chosen twice replaces the preferred one', () => {
  for (const id of ['b', 'b', 'c', 'c']) s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: id });
  const [rule] = s.intentRules('mleko');
  assert.equal(rule.preferredProductId, 'c');
  assert.deepEqual([...rule.acceptedProductIds].sort(), ['b', 'c']);
  assert.deepEqual([...rule.learnedProductIds].sort(), ['b', 'c']);
});

test('replaced products come from corrections that name both products and differ', () => {
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: 'b' });
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: 'b' });
  s.recordCorrection({ term: 'mleko', proposedProductId: 'b', chosenProductId: 'b' });
  s.recordCorrection({ term: 'mleko', proposedProductId: null, chosenProductId: 'c' });
  s.recordCorrection({ term: 'mleko', proposedProductId: 'c', chosenProductId: null });
  assert.deepEqual(s.intentRules('mleko')[0].replacedProductIds, ['a']);
});

test('a deleted rule\'s corrections do not return in a later rule for the term', () => {
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: 'b' });
  s.deleteRule('mleko');
  s.recordCorrection({ term: 'mleko', proposedProductId: 'c', chosenProductId: 'b' });
  assert.deepEqual(s.intentRules('mleko')[0].replacedProductIds, ['c']);
  assert.equal(countCorrections(s), 2);
});

test('removing a line is recorded but teaches no product', () => {
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: null, reason: 'niepotrzebne' });
  assert.deepEqual(s.intentRules('mleko'), []);
  assert.equal(countCorrections(s), 1);
});

test('deleting a rule keeps the corrections', () => {
  s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: 'b' });
  s.setBrandFixed('mleko', 'Brand');
  s.deleteRule('Mleko');
  assert.deepEqual(s.intentRules(), []);
  assert.equal(countCorrections(s), 1);
});

test('brand can be fixed and cleared, and intentRules lists all terms', () => {
  s.setBrandFixed('Masło', 'Brand');
  assert.equal(s.intentRules('maslo')[0].brand, 'Brand');
  s.recordCorrection({ term: 'mleko', proposedProductId: null, chosenProductId: 'a' });
  assert.equal(s.intentRules().length, 2);
  s.setBrandFixed('maslo', null);
  assert.equal(s.intentRules('maslo')[0].brand, null);
});

test('a failed write leaves nothing behind', () => {
  assert.throws(() => s.recordCorrection({ term: 'mleko', proposedProductId: 'a', chosenProductId: 'missing' }));
  assert.equal(countCorrections(s), 0);
  assert.deepEqual(s.intentRules(), []);
});

test('terms match without diacritics or case', () => {
  assert.equal(normaliseTerm(' MĄKA '), 'maka');
  assert.equal(normaliseTerm('Łosoś'), 'losos');
});

test('terms collapse inner whitespace', () => {
  assert.equal(normaliseTerm('  mleko \t  3,2%  '), 'mleko 3,2%');
});

test('the store treats a term with or without diacritics as one rule', () => {
  s.recordCorrection({ term: 'MĄKA', proposedProductId: 'a', chosenProductId: 'b' });
  s.recordCorrection({ term: 'maka', proposedProductId: 'a', chosenProductId: 'b' });
  s.setBrandFixed('Mąka', 'Brand');
  assert.equal(s.intentRules().length, 1);
  assert.equal(s.intentRules('mąka')[0].preferredProductId, 'b');
  assert.equal(s.intentRules('maka')[0].brand, 'Brand');
  s.deleteRule('MĄKA');
  assert.deepEqual(s.intentRules('maka'), []);
});

test('a read-only store on an older database still opens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-old-'));
  try {
    const path = join(dir, 'old.db');
    openStore(path).close();
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE intent_products; DROP TABLE intents; DROP TABLE corrections');
    db.close();
    const ro = openStore(path, { readOnly: true });
    assert.deepEqual(ro.recentOrders(5), []);
    ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
