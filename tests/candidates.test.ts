import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates } from '../src/candidates.ts';
import { openStore } from '../src/store.ts';
import type { ProductFacts, IntentRule } from '../src/store.ts';

const fact = (productId: string, over: Partial<ProductFacts> = {}): ProductFacts => ({
  productId, name: `Mleko ${productId}`, brand: 'Brand', categoryPath: [], size: '1 L', timesBought: 0, lastBoughtAt: null,
  usualQuantity: null, latestPriceGrosze: 300, offerText: null, requiredQuantity: null, medianUnitPriceGrosze: null,
  pricePoints: 0, inCatalogue: true, boughtInLatest10: 0, seenInLatestPromotions: false, ...over,
});
const rule = (over: Partial<IntentRule> = {}): IntentRule => ({
  term: 'mleko', brand: null, preferredProductId: null, acceptedProductIds: [], learnedProductIds: [], replacedProductIds: [], ...over,
});
const ids = (c: { productId: string }[]) => c.map((x) => x.productId);

test('preferred outranks a cheaper product', () => {
  const facts = [fact('cheap', { latestPriceGrosze: 100 }), fact('pref', { latestPriceGrosze: 500 })];
  const r = rankCandidates('mleko', 1, facts, rule({ preferredProductId: 'pref', acceptedProductIds: ['pref'] }));
  assert.deepEqual(ids(r), ['pref', 'cheap']);
  assert.equal(r[0].basis, 'preferred');
});

test('a product chosen twice leads what was bought', () => {
  const facts = [fact('bought', { timesBought: 9 }), fact('acc', { latestPriceGrosze: 900 })];
  const r = rankCandidates('mleko', 1, facts, rule({ acceptedProductIds: ['acc'], learnedProductIds: ['acc'] }));
  assert.deepEqual(ids(r), ['acc', 'bought']);
  assert.equal(r[0].basis, 'accepted');
});

test('a product chosen once stays an alternative behind what was bought', () => {
  const facts = [fact('bought', { timesBought: 9 }), fact('once', { latestPriceGrosze: 100 })];
  const r = rankCandidates('mleko', 1, facts, rule({ acceptedProductIds: ['once'] }));
  assert.deepEqual(ids(r), ['bought', 'once']);
  assert.equal(r[1].basis, 'accepted');
  assert.equal(r[1].guess, false);
});

test('the full order: preferred, learned, bought, chosen once, the rest', () => {
  const facts = [
    fact('rest', { latestPriceGrosze: 50 }), fact('once', { latestPriceGrosze: 100 }), fact('bought', { timesBought: 2 }),
    fact('learned', { latestPriceGrosze: 800 }), fact('pref', { latestPriceGrosze: 900 }),
  ];
  const r = rankCandidates('mleko', 1, facts, rule({
    preferredProductId: 'pref', acceptedProductIds: ['pref', 'learned', 'once'], learnedProductIds: ['pref', 'learned'],
  }));
  assert.deepEqual(ids(r), ['pref', 'learned', 'bought', 'once', 'rest']);
  assert.deepEqual(r.map((c) => c.basis), ['preferred', 'accepted', 'history', 'accepted', 'value']);
});

test('a product chosen once and bought keeps its place by purchase count', () => {
  const facts = [fact('more', { timesBought: 5 }), fact('once', { timesBought: 2 }), fact('less', { timesBought: 1 })];
  const r = rankCandidates('mleko', 1, facts, rule({ acceptedProductIds: ['once'] }));
  assert.deepEqual(ids(r), ['more', 'once', 'less']);
  assert.equal(r[1].basis, 'history');
});

test('a product chosen once still shows when the term does not match its name, and is bought', () => {
  const facts = [fact('acc', { name: 'Zupełnie inna nazwa', timesBought: 2 })];
  assert.deepEqual(ids(rankCandidates('mleko', 1, facts, rule({ acceptedProductIds: ['acc'] }))), ['acc']);
});

test('a fixed brand hides an accepted product of another brand', () => {
  const facts = [fact('other', { brand: 'Other', timesBought: 9 }), fact('fixed', { brand: 'Fixed' })];
  const r = rankCandidates('mleko', 1, facts, rule({ brand: 'Fixed', acceptedProductIds: ['other'], learnedProductIds: ['other'], preferredProductId: 'other' }));
  assert.deepEqual(ids(r), ['fixed']);
});

test('purchase count beats value within history', () => {
  const facts = [fact('often', { timesBought: 5, latestPriceGrosze: 600 }), fact('rare', { timesBought: 1, latestPriceGrosze: 100 })];
  assert.deepEqual(ids(rankCandidates('mleko', 1, facts, null)), ['often', 'rare']);
});

test('a bigger pack wins on unit price among products never bought, and is marked as a guess', () => {
  const facts = [fact('small', { size: '1 L', latestPriceGrosze: 400 }), fact('big', { size: '3 L', latestPriceGrosze: 900 })];
  const r = rankCandidates('mleko', 1, facts, null);
  assert.deepEqual(ids(r), ['big', 'small']);
  assert.equal(r[0].basis, 'value');
  assert.equal(r[0].guess, true);
  assert.equal(r[0].unitPriceGrosze, 300);
});

test('a product with no known unit price ranks after one with a known price', () => {
  const facts = [fact('nosize', { size: null, latestPriceGrosze: 50 }), fact('sized', { latestPriceGrosze: 900 })];
  assert.deepEqual(ids(rankCandidates('mleko', 1, facts, null)), ['sized', 'nosize']);
});

test('the unit price uses the offer only if the quantity reaches it', () => {
  const f = [fact('a', { latestPriceGrosze: 400, offerText: '2 za 6 zł', requiredQuantity: 2 })];
  assert.equal(rankCandidates('mleko', 1, f, null)[0].unitPriceGrosze, 400);
  assert.equal(rankCandidates('mleko', 1, f, null)[0].lineCostGrosze, 400);
  const two = rankCandidates('mleko', 2, f, null)[0];
  assert.equal(two.lineCostGrosze, 600);
  assert.equal(two.unitPriceGrosze, 300);
});

test('"maka" finds "Mąka pszenna"', () => {
  const r = rankCandidates('maka', 1, [fact('f', { name: 'Mąka pszenna' }), fact('g', { name: 'Mleko' })], null);
  assert.deepEqual(ids(r), ['f']);
});

const named = (...names: string[]) => names.map((name, i) => fact(`p${i}`, { name }));
const found = (term: string, facts: ProductFacts[]) => rankCandidates(term, 1, facts, null).map((c) => c.name);

test('flour terms find flour, not pasta or poppy seed', () => {
  const facts = named('Mąka pszenna', 'Makaron świderki', 'Mak niebieski');
  for (const term of ['maka', 'mąka', 'MĄKA', 'mąki']) assert.deepEqual(found(term, facts), ['Mąka pszenna'], term);
});

test('an inflected term finds its word', () => {
  assert.deepEqual(found('makaronu', named('Makaron świderki', 'Mąka pszenna')), ['Makaron świderki']);
  assert.deepEqual(found('mleka', named('Mleko UHT')), ['Mleko UHT']);
  assert.deepEqual(found('mleko', named('Napój z mleka')), ['Napój z mleka']);
});

test('a short term matches the start of a word with a short ending only', () => {
  assert.deepEqual(found('ser', named('Serek wiejski', 'Deser czekoladowy', 'Serwetki papierowe')), ['Serek wiejski']);
  assert.deepEqual(found('sol', named('Sól kuchenna', 'Fasola czerwona')), ['Sól kuchenna']);
  assert.deepEqual(found('kawa', named('Kawa mielona', 'Kawałki kurczaka')), ['Kawa mielona']);
});

test('words split on spaces, hyphens and slashes, and the brand counts', () => {
  assert.deepEqual(found('mleko', named('Napój-mleko', 'Kawa/mleko')).length, 2);
  assert.deepEqual(found('alfa', [fact('a', { name: 'Olej', brand: 'Alfa' })]), ['Olej']);
});

test('a term with a percentage still matches', () => {
  assert.deepEqual(found('mleko 3,2%', named('Mleko UHT 3,2%', 'Mleko UHT 2%')), ['Mleko UHT 3,2%']);
});

test('a blank term matches nothing', () => {
  assert.deepEqual(found('   ', named('Mleko UHT')), []);
});

test('regression: flour does not lead with a bought pasta', () => {
  const facts = [fact('pasta', { name: 'Makaron', timesBought: 8 }), fact('flour', { name: 'Mąka pszenna' })];
  assert.deepEqual(ids(rankCandidates('maka', 1, facts, null)), ['flour']);
});

test('a fixed brand returns only that brand, even when another is cheaper', () => {
  const facts = [fact('x', { brand: 'Łaciate', latestPriceGrosze: 500 }), fact('y', { brand: 'Other', latestPriceGrosze: 100 })];
  assert.deepEqual(ids(rankCandidates('mleko', 1, facts, rule({ brand: 'laciate' }))), ['x']);
});

test('excludes products out of the catalogue or without a price', () => {
  const facts = [fact('gone', { inCatalogue: false }), fact('noprice', { latestPriceGrosze: null }), fact('ok')];
  assert.deepEqual(ids(rankCandidates('mleko', 1, facts, null)), ['ok']);
});

test('an accepted product still shows when the term no longer matches its name', () => {
  const facts = [fact('acc', { name: 'Zupełnie inna nazwa' }), fact('gone', { name: 'Zupełnie', inCatalogue: false })];
  const r = rankCandidates('mleko', 1, facts, rule({ acceptedProductIds: ['acc', 'gone'] }));
  assert.deepEqual(ids(r), ['acc']);
});

test('regression: "nutella" with the spread chosen twice does not lead with wafers', () => {
  const facts = [
    fact('wafer', { name: 'Nutella B-ready wafelki', size: '0.132 kg', latestPriceGrosze: 300 }),
    fact('spread', { name: 'Nutella krem', size: '0.4 kg', latestPriceGrosze: 1500 }),
  ];
  const r = rankCandidates('nutella', 1, facts, rule({ term: 'nutella', acceptedProductIds: ['spread'], learnedProductIds: ['spread'] }));
  assert.equal(r[0].productId, 'spread');
});

test('regression: a catering 3L syrup does not outrank the usual bottle the user bought', () => {
  const facts = [
    fact('catering', { name: 'Syrop malinowy', size: '3 L', latestPriceGrosze: 1500 }),
    fact('usual', { name: 'Syrop malinowy', size: '0.5 L', latestPriceGrosze: 900, timesBought: 3 }),
  ];
  assert.equal(rankCandidates('syrop', 1, facts, null)[0].productId, 'usual');
});

test('regression: loose ham with no size does not outrank sliced ham that was bought', () => {
  const facts = [
    fact('loose', { name: 'Szynka luzem', size: null, latestPriceGrosze: 100 }),
    fact('sliced', { name: 'Szynka plastry', size: '0.1 kg', latestPriceGrosze: 700, timesBought: 2 }),
  ];
  assert.equal(rankCandidates('szynka', 1, facts, null)[0].productId, 'sliced');
});

test('productFacts: a latest promotion row with no offer text still counts as seen', () => {
  const s = openStore(':memory:');
  const product = { productId: 'a', retailerProductId: 'r-a', name: 'A', brand: 'B', categoryPath: [], unitLabel: null, size: null, inCatalogue: true };
  s.savePromotions({ regionId: 'r1', products: [product], prices: [{
    productId: 'a', seenAt: '2026-02-01T10:00:00.000Z', regionId: 'r1', source: 'promotion', originalGrosze: 500, currentGrosze: 400,
    unitCurrentGrosze: null, offerText: null, requiredQuantity: null,
  }] });
  assert.equal(s.productFacts()[0].seenInLatestPromotions, true);
  s.close();
});

test('productFacts: median unit price, latest promotion only, boughtInLatest10', () => {
  const s = openStore(':memory:');
  const p = (productId: string, size: string | null) => ({
    productId, retailerProductId: `r-${productId}`, name: `Item ${productId}`, brand: 'B', categoryPath: ['x', 'y'],
    unitLabel: null, size, inCatalogue: true,
  });
  const price = (productId: string, seenAt: string, source: 'order' | 'promotion', currentGrosze: number, offerText: string | null = null) => ({
    productId, seenAt, regionId: 'r1', source, originalGrosze: null, currentGrosze, unitCurrentGrosze: null,
    offerText, requiredQuantity: offerText ? 2 : null,
  });
  for (let i = 1; i <= 12; i++) {
    const day = String(i).padStart(2, '0');
    const at = `2026-01-${day}T10:00:00.000Z`;
    const orderId = `o${day}`;
    const withA = i !== 1; // a is absent from the oldest order
    s.saveOrder({
      order: { orderId, deliveredAt: at, totalGrosze: 0, regionId: 'r1' },
      lines: [
        ...(withA ? [{ orderId, productId: 'a', quantity: i === 12 ? 4 : 2, pricePerItemGrosze: 100 }] : []),
        ...(i === 1 ? [{ orderId, productId: 'old', quantity: 1, pricePerItemGrosze: 100 }] : []),
      ],
      products: [p('a', '1 L'), p('old', null)],
      prices: i <= 3 && withA ? [price('a', at, 'order', 100 * i)] : [],
    });
  }
  // a: order prices 200, 300 -> median 250 per L; plus a promotion price that must not count
  s.savePromotions({ regionId: 'r1', products: [p('a', '1 L'), p('b', null)], prices: [
    price('a', '2026-02-01T10:00:00.000Z', 'promotion', 150, '2 za 2 zł'),
    price('b', '2026-02-01T10:00:00.000Z', 'promotion', 500, '2 za 8 zł'),
  ] });
  s.savePromotions({ regionId: 'r1', products: [p('b', null)], prices: [price('b', '2026-03-01T10:00:00.000Z', 'promotion', 450, '2 za 8 zł')] });

  const facts = new Map(s.productFacts().map((f) => [f.productId, f]));
  const a = facts.get('a')!;
  assert.equal(a.timesBought, 11);
  assert.equal(a.boughtInLatest10, 10);
  assert.equal(a.usualQuantity, 2);
  assert.equal(a.pricePoints, 2);
  assert.equal(a.medianUnitPriceGrosze, 250);
  assert.deepEqual(a.categoryPath, ['x', 'y']);
  assert.equal(a.latestPriceGrosze, 150);
  assert.equal(a.offerText, null); // its promotion is not in the latest promotion sync
  assert.equal(a.seenInLatestPromotions, false);
  assert.equal(a.lastBoughtAt, '2026-01-12T10:00:00.000Z');
  const b = facts.get('b')!;
  assert.equal(b.offerText, '2 za 8 zł');
  assert.equal(b.latestPriceGrosze, 450);
  assert.equal(b.requiredQuantity, 2);
  assert.equal(b.seenInLatestPromotions, true);
  assert.equal(b.medianUnitPriceGrosze, null);
  assert.equal(facts.get('old')!.boughtInLatest10, 0);
  assert.equal(facts.get('old')!.medianUnitPriceGrosze, null);
  assert.equal(s.productFacts({ asOf: '2026-12-01T00:00:00.000Z' }).find((f) => f.productId === 'b')!.seenInLatestPromotions, false);
  s.close();
});
