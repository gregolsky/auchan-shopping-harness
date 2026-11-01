import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOffer, lineCost, parseSize, unitPriceGrosze } from '../src/pricing.ts';

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

test('a fractional quantity still costs whole grosze', () => {
  assert.equal(lineCost(399, null, 0.33), 132);
  assert.equal(lineCost(399, parseOffer('2+1 za grosz'), 0.33), 132);
  assert.equal(lineCost(899, parseOffer('2  za 15,70 zł'), 2.5), 2020);
});
