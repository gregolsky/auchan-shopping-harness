import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillCart } from '../src/fill.ts';
import { ShapeError } from '../src/parse.ts';
import type { BasketLine } from '../src/types.ts';
import { fakeCart } from './helpers/fake-cart.ts';

const bl = (productId: string, quantity: number): BasketLine => ({ term: null, productId, name: `n-${productId}`, quantity, approvedPriceGrosze: 100 });

test('fills only what is missing', async () => {
  const cart = fakeCart({ p1: 1 });
  const r = await fillCart(cart, [bl('p1', 3), bl('p2', 1)]);
  assert.deepEqual(cart.quantities, { p1: 3, p2: 1 });
  assert.equal(r.sent, 2);
  assert.equal(r.missing.length, 0);
});

test('sends batches of at most MAX_BATCH', async () => {
  const cart = fakeCart({});
  const progress: number[][] = [];
  await fillCart(cart, Array.from({ length: 23 }, (_, i) => bl(`p${i}`, 1)), { onProgress: (s, t) => progress.push([s, t]) });
  assert.deepEqual(cart.applyCalls.map((c) => c.length), [10, 10, 3]);
  assert.deepEqual(progress, [[10, 23], [20, 23], [23, 23]]);
});

test('a rerun after a lost response adds nothing twice', async () => {
  const cart = fakeCart({}, { loseResponseOnce: true });
  const basket = [bl('p1', 2), bl('p2', 1)];
  await assert.rejects(fillCart(cart, basket), /timed out/);
  await fillCart(cart, basket);
  assert.deepEqual(cart.quantities, { p1: 2, p2: 1 });
});

test('a rejected batch is retried line by line after a fresh read', async () => {
  const cart = fakeCart({}, { reject: ['p2'] });
  const r = await fillCart(cart, [bl('p1', 1), bl('p2', 1), bl('p3', 1)]);
  assert.deepEqual(cart.quantities, { p1: 1, p3: 1 });
  assert.deepEqual(r.missing.map((m) => m.productId), ['p2']);
  assert.deepEqual(cart.applyCalls.map((c) => c.map((x) => x.productId)), [['p1', 'p2', 'p3'], ['p1'], ['p2'], ['p3']]);
  assert.equal(cart.readCalls, 3); // initial, after the rejection, final
  assert.equal(r.sent, 2);
});

test('a shape change stops before any POST', async () => {
  const cart = fakeCart({});
  cart.readCart = async () => ({});
  await assert.rejects(fillCart(cart, [bl('p1', 1)]), ShapeError);
  assert.equal(cart.applyCalls.length, 0);
});

test('nothing to send still reads, compares and reports', async () => {
  const cart = fakeCart({ p1: 2, x: 1 });
  const r = await fillCart(cart, [bl('p1', 2)]);
  assert.equal(cart.applyCalls.length, 0);
  assert.equal(cart.readCalls, 2);
  assert.equal(r.sent, 0);
  assert.equal(r.alreadyEnough.length, 1);
  assert.deepEqual(r.extras.map((e) => e.productId), ['x']);
  assert.equal(r.cartTotalGrosze, 300);
});

test('an out-of-stock product is reported, not retried', async () => {
  const cart = fakeCart({}, { outOfStock: ['p2'] });
  const r = await fillCart(cart, [bl('p1', 1), bl('p2', 1)]);
  assert.deepEqual(r.outOfStock.map((m) => m.productId), ['p2']);
  assert.equal(r.missing.length, 0);
  assert.equal(cart.applyCalls.length, 1);
});
