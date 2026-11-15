import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillCart } from '../src/fill.ts';
import { ShapeError } from '../src/parse.ts';
import type { BasketLine } from '../src/types.ts';
import { fakeCart } from './helpers/fake-cart.ts';

const uid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const bl = (productId: string, quantity: number): BasketLine => ({ term: null, productId, name: `n-${productId}`, quantity, approvedPriceGrosze: 100 });

test('fills only what is missing', async () => {
  const cart = fakeCart({ '00000000-0000-4000-8000-000000000001': 1 });
  const r = await fillCart(cart, [bl('00000000-0000-4000-8000-000000000001', 3), bl('00000000-0000-4000-8000-000000000002', 1)]);
  assert.deepEqual(cart.quantities, { '00000000-0000-4000-8000-000000000001': 3, '00000000-0000-4000-8000-000000000002': 1 });
  assert.equal(r.sent, 2);
  assert.equal(r.missing.length, 0);
});

test('sends batches of at most MAX_BATCH', async () => {
  const cart = fakeCart({});
  const progress: number[][] = [];
  await fillCart(cart, Array.from({ length: 23 }, (_, i) => bl(uid(i), 1)), { onProgress: (s, t) => progress.push([s, t]) });
  assert.deepEqual(cart.applyCalls.map((c) => c.length), [10, 10, 3]);
  assert.deepEqual(progress, [[10, 23], [20, 23], [23, 23]]);
});

test('a rerun after a lost response adds nothing twice', async () => {
  const cart = fakeCart({}, { loseResponseOnce: true });
  const basket = [bl('00000000-0000-4000-8000-000000000001', 2), bl('00000000-0000-4000-8000-000000000002', 1)];
  await assert.rejects(fillCart(cart, basket), /timed out/);
  await fillCart(cart, basket);
  assert.deepEqual(cart.quantities, { '00000000-0000-4000-8000-000000000001': 2, '00000000-0000-4000-8000-000000000002': 1 });
});

test('a rejected batch is retried line by line after a fresh read', async () => {
  const cart = fakeCart({}, { reject: ['00000000-0000-4000-8000-000000000002'] });
  const progress: number[][] = [];
  const r = await fillCart(cart, [bl('00000000-0000-4000-8000-000000000001', 1), bl('00000000-0000-4000-8000-000000000002', 1), bl('00000000-0000-4000-8000-000000000003', 1)], { onProgress: (s, t) => progress.push([s, t]) });
  assert.deepEqual(progress.at(-1), [3, 3]);
  assert.deepEqual(cart.quantities, { '00000000-0000-4000-8000-000000000001': 1, '00000000-0000-4000-8000-000000000003': 1 });
  assert.deepEqual(r.missing.map((m) => m.productId), ['00000000-0000-4000-8000-000000000002']);
  assert.deepEqual(cart.applyCalls.map((c) => c.map((x) => x.productId)), [['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'], ['00000000-0000-4000-8000-000000000001'], ['00000000-0000-4000-8000-000000000002'], ['00000000-0000-4000-8000-000000000003']]);
  assert.equal(cart.readCalls, 3); // initial, after the rejection, final
  assert.equal(r.sent, 2);
});

test('a shape change stops before any POST', async () => {
  const cart = fakeCart({});
  cart.readCart = async () => ({});
  await assert.rejects(fillCart(cart, [bl('00000000-0000-4000-8000-000000000001', 1)]), ShapeError);
  assert.equal(cart.applyCalls.length, 0);
});

test('nothing to send still reads, compares and reports', async () => {
  const cart = fakeCart({ '00000000-0000-4000-8000-000000000001': 2, '00000000-0000-4000-8000-0000000003e7': 1 });
  const r = await fillCart(cart, [bl('00000000-0000-4000-8000-000000000001', 2)]);
  assert.equal(cart.applyCalls.length, 0);
  assert.equal(cart.readCalls, 2);
  assert.equal(r.sent, 0);
  assert.equal(r.alreadyEnough.length, 1);
  assert.deepEqual(r.extras.map((e) => e.productId), ['00000000-0000-4000-8000-0000000003e7']);
  assert.equal(r.cartTotalGrosze, 300);
});

test('an out-of-stock product is reported, not retried', async () => {
  const cart = fakeCart({}, { outOfStock: ['00000000-0000-4000-8000-000000000002'] });
  const r = await fillCart(cart, [bl('00000000-0000-4000-8000-000000000001', 1), bl('00000000-0000-4000-8000-000000000002', 1)]);
  assert.deepEqual(r.outOfStock.map((m) => m.productId), ['00000000-0000-4000-8000-000000000002']);
  assert.equal(r.missing.length, 0);
  assert.equal(cart.applyCalls.length, 1);
  assert.equal(r.sent, 1);
});

test('the 11th line rejected is skipped and the other 10 are added', async () => {
  const cart = fakeCart({}, { reject: ['00000000-0000-4000-8000-00000000000a'] });
  const basket = Array.from({ length: 11 }, (_, i) => bl(uid(i), 1));
  const progress: number[][] = [];
  const r = await fillCart(cart, basket, { onProgress: (s, t) => progress.push([s, t]) });
  assert.equal(Object.keys(cart.quantities).length, 10);
  assert.deepEqual(r.missing.map((m) => m.productId), ['00000000-0000-4000-8000-00000000000a']);
  assert.equal(r.sent, 10);
  assert.deepEqual(progress.at(-1), [11, 11]);
});

test('a partial add ends in missing, not outOfStock, and is not retried', async () => {
  const cart = fakeCart({}, { cap: { '00000000-0000-4000-8000-000000000001': 1 } });
  const r = await fillCart(cart, [bl('00000000-0000-4000-8000-000000000001', 3)]);
  assert.deepEqual(r.missing.map((m) => m.productId), ['00000000-0000-4000-8000-000000000001']);
  assert.equal(r.outOfStock.length, 0);
  assert.equal(cart.applyCalls.length, 1);
  assert.equal(r.sent, 1);
});

test('an out-of-stock product that was partly added is missing, with how many went in', async () => {
  const cart = fakeCart({});
  cart.applyQuantities = async (c) => {
    cart.quantities[c[0].productId] = 1;
    return [{ productId: c[0].productId, reason: 'OUT_OF_STOCK', requestedAmount: 3, addedAmount: 1 }];
  };
  const r = await fillCart(cart, [bl(uid(1), 3)]);
  assert.deepEqual(r.missing.map((m) => m.productId), [uid(1)]);
  assert.equal(r.outOfStock.length, 0);
  assert.deepEqual(r.limits[uid(1)], { reason: 'OUT_OF_STOCK', added: 1, requested: 3 });
});

test('a full refusal for another reason is missing with its reason, not out of stock', async () => {
  const cart = fakeCart({});
  cart.applyQuantities = async (c) => [{ productId: c[0].productId, reason: 'MAX_QUANTITY', requestedAmount: 2, addedAmount: 0 }];
  const r = await fillCart(cart, [bl(uid(1), 2)]);
  assert.deepEqual(r.missing.map((m) => m.productId), [uid(1)]);
  assert.equal(r.outOfStock.length, 0);
  assert.deepEqual(r.limits[uid(1)], { reason: 'MAX_QUANTITY', added: 0, requested: 2 });
});

test('a partial add reports its numbers', async () => {
  const cart = fakeCart({}, { cap: { [uid(1)]: 1 } });
  const r = await fillCart(cart, [bl(uid(1), 3)]);
  assert.deepEqual(r.limits[uid(1)], { reason: 'MAX_QUANTITY', added: 1, requested: 3 });
});

test('quantities that are fractional or above 20 are skipped up front', async () => {
  const cart = fakeCart({});
  const r = await fillCart(cart, [bl(uid(1), 21), bl(uid(2), 20)]);
  assert.deepEqual(cart.quantities, { [uid(2)]: 20 });
  assert.deepEqual(r.missing.map((m) => m.productId), [uid(1)]);
});

test('onPlan gets the count and approved-price total before the first apply', async () => {
  const cart = fakeCart({ [uid(1)]: 1 });
  const events: string[] = [];
  const real = cart.applyQuantities;
  cart.applyQuantities = async (c) => (events.push('apply'), real(c));
  await fillCart(cart, [bl(uid(1), 3), bl(uid(2), 1)], { onPlan: (p) => events.push(`plan ${p.count} ${p.totalGrosze}`) });
  assert.deepEqual(events, ['plan 2 300', 'apply']);
});

test('changes applyQuantities would refuse are skipped up front and end in missing, the rest is added', async () => {
  const cart = fakeCart({});
  const good = [bl(uid(1), 1), bl(uid(2), 2)];
  const r = await fillCart(cart, [bl('not-a-uuid', 1), good[0], bl(uid(3), 21), good[1]]);
  assert.deepEqual(cart.quantities, { [uid(1)]: 1, [uid(2)]: 2 });
  assert.deepEqual(cart.applyCalls.map((c) => c.map((x) => x.productId)), [[uid(1), uid(2)]]);
  assert.deepEqual(r.missing.map((m) => m.productId).sort(), ['not-a-uuid', uid(3)].sort());
  assert.equal(r.sent, 2);
});
