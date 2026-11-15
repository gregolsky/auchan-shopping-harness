import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareCart, parseCart, planFill, type BasketLine, type CartLine } from '../src/cart.ts';
import { ShapeError } from '../src/parse.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cart.json', import.meta.url), 'utf8'));
const bl = (productId: string, quantity: number, approvedPriceGrosze = 1000): BasketLine => ({ term: null, productId, name: `n-${productId}`, quantity, approvedPriceGrosze });
const cl = (productId: string, quantity: number, unitPriceGrosze: number | null = 1000): CartLine => ({ productId, quantity, unitPriceGrosze, lineTotalGrosze: null });

test('parseCart reads the fixture', () => {
  const c = parseCart(fixture);
  assert.deepEqual(c.lines.map((l) => [l.productId, l.quantity, l.unitPriceGrosze]), [
    ['4d99971b-6c8f-4f61-8082-b4feb76ef9d0', 2, 198],
    ['7866c30c-0b4e-402b-a90c-f292bca0ef6b', 1, 318],
    ['95bba835-bad9-40df-a7ec-7766ac0d3354', 3, 374],
  ]);
  assert.equal(c.lines[0].lineTotalGrosze, 396);
  assert.equal(c.lines[2].lineTotalGrosze, 1122);
  assert.equal(c.totalGrosze, 1836);
});

test('parseCart reads an empty cart', () => {
  assert.deepEqual(parseCart({ items: [] }), { lines: [], totalGrosze: null });
});

test('parseCart rejects an unknown shape with ShapeError', () => {
  for (const bad of [{}, null, { items: [{ quantity: 1 }] }, { items: [{ productId: 'secret', quantity: 'x' }] }]) {
    assert.throws(() => parseCart(bad), (e: Error) => e instanceof ShapeError && !e.message.includes('secret'));
  }
});

test('planFill sends the missing difference', () => {
  assert.deepEqual(planFill([bl('p1', 3)], [cl('p1', 1)]).send, [{ productId: 'p1', quantity: 2 }]);
});

test('planFill never lowers or removes', () => {
  const p = planFill([bl('p1', 1)], [cl('p1', 4), cl('p9', 2)]);
  assert.deepEqual(p.send, []);
  assert.equal(p.alreadyEnough[0].productId, 'p1');
  assert.equal(p.extras[0].productId, 'p9');
});

test('planFill merges duplicate basket lines for one product', () => {
  assert.deepEqual(planFill([bl('p1', 1), bl('p1', 2)], []).send, [{ productId: 'p1', quantity: 3 }]);
});

test('planFill sends integer deltas only, also against a fractional cart quantity', () => {
  assert.deepEqual(planFill([bl('p1', 2)], [cl('p1', 1)]).send, [{ productId: 'p1', quantity: 1 }]);
  const frac = planFill([bl('p1', 2)], [cl('p1', 0.9)]);
  assert.deepEqual(frac.send, [{ productId: 'p1', quantity: 1 }]);
  for (const s of planFill([bl('p1', 3), bl('p2', 2)], [cl('p1', 1.4), cl('p2', 0.1)]).send) assert.ok(Number.isInteger(s.quantity));
  // less than half a piece missing sends nothing
  const near = planFill([bl('p1', 2)], [cl('p1', 1.6)]);
  assert.deepEqual(near.send, []);
  assert.equal(near.alreadyEnough.length, 1);
});

test('compareCart counts one added product per product, not per basket line', () => {
  const r = compareCart([bl('p1', 1), bl('p1', 2)], [], { lines: [cl('p1', 3)], totalGrosze: null });
  assert.equal(r.added.length, 1);
});

test('compareCart keeps one decimal in the rise percent', () => {
  const r = compareCart([bl('p1', 1)], [], { lines: [cl('p1', 1, 1104)], totalGrosze: null });
  assert.equal(r.checkBeforePaying[0].risePercent, 10.4);
});

test('compareCart carries the limits of the products it reports as missing', () => {
  const limits = { p1: { reason: 'MAX_QUANTITY', added: 1, requested: 3 } };
  const r = compareCart([bl('p1', 3)], [], { lines: [cl('p1', 1)], totalGrosze: null }, [], limits);
  assert.deepEqual(r.missing.map((b) => b.productId), ['p1']);
  assert.deepEqual(r.limits, limits);
});

test('compareCart flags a 12% rise to check before paying and a 5% rise as small', () => {
  const run = (price: number) => compareCart([bl('p1', 1)], [], { lines: [cl('p1', 1, price)], totalGrosze: null });
  assert.equal(run(1120).checkBeforePaying[0].risePercent, 12);
  assert.equal(run(1050).smallRises.length, 1);
  assert.equal(run(1100).smallRises.length, 1);
  const none = run(990);
  assert.equal(none.checkBeforePaying.length + none.smallRises.length, 0);
  assert.equal(run(1500).smallRises.length, 0);
});

test('compareCart skips price notes when the cart price is null', () => {
  const r = compareCart([bl('p1', 1)], [], { lines: [cl('p1', 1, null)], totalGrosze: 5 });
  assert.equal(r.checkBeforePaying.length + r.smallRises.length, 0);
  assert.equal(r.cartTotalGrosze, 5);
});

test('compareCart lists a product still below its quantity as missing', () => {
  const r = compareCart([bl('p1', 3), bl('p2', 1)], [], { lines: [cl('p1', 1)], totalGrosze: null });
  assert.deepEqual(r.missing.map((b) => b.productId), ['p1', 'p2']);
  assert.equal(r.added.length, 0);
});

test('compareCart moves out-of-stock products from missing and splits added from alreadyEnough', () => {
  const r = compareCart([bl('p1', 1), bl('p2', 2), bl('p3', 1)], [cl('p1', 1)], { lines: [cl('p1', 1), cl('p2', 2), cl('x', 1)], totalGrosze: null }, ['p3']);
  assert.deepEqual(r.outOfStock.map((b) => b.productId), ['p3']);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.added.map((b) => b.productId), ['p2']);
  assert.deepEqual(r.alreadyEnough.map((b) => b.productId), ['p1']);
  assert.deepEqual(r.extras.map((c) => c.productId), ['x']);
});

test('the rise group follows the rounded percent that is printed (25,00 -> 27,51 and 27,50 are +10,0%, small)', () => {
  const at = (b: number, now: number) => compareCart([{ ...bl('p1', 1), approvedPriceGrosze: b }], [], { lines: [cl("p1", 1, now)], totalGrosze: null });
  for (const now of [2751, 2750]) {
    const r = at(2500, now);
    assert.equal(r.smallRises.length, 1);
    assert.equal(r.checkBeforePaying.length, 0);
    assert.equal(r.smallRises[0].risePercent, 10);
  }
  assert.equal(at(2500, 2753).checkBeforePaying.length, 1); // 10,1%
});
