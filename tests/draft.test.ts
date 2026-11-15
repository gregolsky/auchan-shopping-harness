import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDraft } from '../src/draft.ts';
import type { IntentRule, ProductFacts } from '../src/store.ts';

const now = new Date('2026-11-01T00:00:00Z');
const fact = (productId: string, over: Partial<ProductFacts> = {}): ProductFacts => ({
  productId, name: `Item ${productId}`, brand: 'Brand', categoryPath: ['Produkty', 'Kawa, herbata'], size: '1 kg', timesBought: 0,
  lastBoughtAt: null, usualQuantity: null, latestPriceGrosze: 1000, offerText: null, requiredQuantity: null,
  medianUnitPriceGrosze: null, pricePoints: 0, imageUrl: null, imageAlt: null, inCatalogue: true, boughtInLatest10: 0, seenInLatestPromotions: false, ...over,
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
    usual('u', { name: 'Kawa mielona', latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4, offerText: '2 za 14 zł', requiredQuantity: 2, seenInLatestPromotions: true }),
    usual('s', { latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4, seenInLatestPromotions: true }),
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
  const facts = [usual('s', { latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4, seenInLatestPromotions: true })];
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
  const rules: IntentRule[] = [{ term: 'Kawa', brand: null, preferredProductId: 'b', acceptedProductIds: ['b'], learnedProductIds: ['b'], replacedProductIds: [] }];
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

const CHEESE = ['Produkty', 'Sery'];

test('a multibuy the cap cannot reach does not win the ranking', () => {
  const facts = [
    fact('offer', { name: 'Ser gouda', categoryPath: CHEESE, latestPriceGrosze: 1000, offerText: '3 za 15 zł', requiredQuantity: 3 }),
    fact('plain', { name: 'Ser edam', categoryPath: CHEESE, latestPriceGrosze: 700 }),
  ];
  const d = buildDraft(input([{ term: 'ser', quantity: 3 }]), facts, [], now);
  assert.equal(d.items[0].productId, 'plain');
  assert.equal(d.items[0].quantity, 1);
  assert.equal(d.items[0].lineCostGrosze, 700);
});

test('a candidate ranks and costs at its own cap', () => {
  const facts = [
    fact('often', { name: 'Ser gouda', categoryPath: CHEESE, timesBought: 5, usualQuantity: 2, latestPriceGrosze: 900 }),
    fact('rare', { name: 'Ser edam', categoryPath: CHEESE, timesBought: 1, usualQuantity: 1, latestPriceGrosze: 700, offerText: '3 za 15 zł', requiredQuantity: 3 }),
    fact('tin', { name: 'Ser w puszce', timesBought: 1, latestPriceGrosze: 1000, offerText: '3 za 15 zł', requiredQuantity: 3 }),
  ];
  const d = buildDraft(input([{ term: 'ser', quantity: 3 }]), facts, [], now);
  assert.equal(d.items[0].productId, 'often');
  assert.equal(d.items[0].lineCostGrosze, 1800);
  assert.deepEqual(d.items[0].alternatives.map((a) => [a.productId, a.lineCostGrosze]), [['rare', 700], ['tin', 1500]]);
});

test('a perishable promotion is skipped when the cap cannot reach the offer', () => {
  const facts = [
    fact('out', { name: 'Ser gouda', categoryPath: CHEESE, timesBought: 1, usualQuantity: 1, offerText: '3 za 15 zł', requiredQuantity: 3 }),
    fact('in', { name: 'Ser edam', categoryPath: CHEESE, timesBought: 1, usualQuantity: 3, offerText: '3 za 15 zł', requiredQuantity: 3 }),
    fact('pantry', { name: 'Kawa', timesBought: 1, usualQuantity: 1, offerText: '3 za 15 zł', requiredQuantity: 3 }),
  ];
  assert.deepEqual(buildDraft(input([]), facts, [], now).promotions.map((l) => l.productId).sort(), ['in', 'pantry']);
});

test('an expired price gives no stock-up', () => {
  const facts = [usual('s', { latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4 })];
  assert.deepEqual(buildDraft(input([]), facts, [], now).stockUps, []);
});

test('a named item that would be a stock-up says so in its reason', () => {
  const facts = [fact('k', { name: 'Kawa', timesBought: 2, latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4, seenInLatestPromotions: true })];
  const d = buildDraft(input([{ term: 'kawa', quantity: 1 }]), facts, [], now);
  assert.equal(d.items[0].reason, 'bought 2 times; 30% below its usual unit price at quantity 2');
  assert.deepEqual(d.stockUps, []);
});

test('a usual item that would be a stock-up says so in its reason', () => {
  const facts = [usual('u', { latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4, seenInLatestPromotions: true })];
  assert.equal(buildDraft(input([], true), facts, [], now).items[0].reason, 'bought in 4 of the latest 10 orders; 30% below its usual unit price at quantity 2');
});

test('an item with no stock-up keeps its plain reason', () => {
  const facts = [fact('k', { name: 'Kawa', timesBought: 2, latestPriceGrosze: 900, medianUnitPriceGrosze: 1000, pricePoints: 4, seenInLatestPromotions: true })];
  assert.equal(buildDraft(input([{ term: 'kawa', quantity: 1 }]), facts, [], now).items[0].reason, 'bought 2 times');
});

const learnedRule = (over: Partial<IntentRule> = {}): IntentRule => ({
  term: 'mleko', brand: null, preferredProductId: 'b', acceptedProductIds: ['b'], learnedProductIds: ['b'], replacedProductIds: ['a'], ...over,
});
const lineIds = (d: { items: { productId: string }[] }) => d.items.map((l) => l.productId);

test('a usual product swapped twice gives way to the preferred one', () => {
  const facts = [usual('a', { name: 'Napój Alfa', usualQuantity: 3 }), fact('b', { name: 'Napój Beta', latestPriceGrosze: 500 })];
  const d = buildDraft(input([], true), facts, [learnedRule()], now);
  assert.deepEqual(lineIds(d), ['b']);
  assert.equal(d.items[0].term, 'mleko');
  assert.equal(d.items[0].quantity, 3);
  assert.equal(d.items[0].lineCostGrosze, 1500);
  assert.equal(d.items[0].reason, 'your usual choice for mleko');
  assert.equal(d.items[0].guess, false);
});

test('the swapped-out product does not come back in another group', () => {
  const facts = [
    usual('a', { name: 'Napój Alfa', latestPriceGrosze: 700, medianUnitPriceGrosze: 1000, pricePoints: 4, seenInLatestPromotions: true }),
    fact('b', { name: 'Napój Beta' }),
  ];
  const d = buildDraft(input([], true), facts, [learnedRule()], now);
  assert.deepEqual([...d.items, ...d.stockUps, ...d.promotions, ...d.addOns].map((l) => l.productId), ['b']);
});

test('a swap to a product already in the draft leaves one line', () => {
  const facts = [usual('a', { name: 'Napój Alfa' }), fact('b', { name: 'Mleko Beta' })];
  const d = buildDraft(input([{ term: 'mleko', quantity: 2 }], true), facts, [learnedRule()], now);
  assert.deepEqual(lineIds(d), ['b']);
  assert.equal(d.items[0].quantity, 2);
});

test('the usual line stays when the preferred product cannot be bought or breaks the fixed brand', () => {
  const a = usual('a', { name: 'Napój Alfa' });
  assert.deepEqual(lineIds(buildDraft(input([], true), [a, fact('b', { inCatalogue: false })], [learnedRule()], now)), ['a']);
  assert.deepEqual(lineIds(buildDraft(input([], true), [a], [learnedRule()], now)), ['a']);
  const facts = [a, fact('b', { brand: 'Other' })];
  assert.deepEqual(lineIds(buildDraft(input([], true), facts, [learnedRule({ brand: 'Brand' })], now)), ['a']);
});

test('a rule with no preferred product changes no usual line', () => {
  const rules = [learnedRule({ preferredProductId: null, learnedProductIds: [] })];
  assert.deepEqual(lineIds(buildDraft(input([], true), [usual('a', { name: 'Napój Alfa' }), fact('b')], rules, now)), ['a']);
});

test('a product swapped back keeps its usual line', () => {
  const rules = [learnedRule({ preferredProductId: 'a', replacedProductIds: ['a', 'b'] })];
  const d = buildDraft(input([], true), [usual('a', { name: 'Napój Alfa' })], rules, now);
  assert.deepEqual(lineIds(d), ['a']);
  assert.equal(d.items[0].term, null);
});

test('a usual product matching a term of this note is covered by the term line', () => {
  const facts = [usual('u', { name: 'Mleko UHT', timesBought: 2 }), usual('v', { name: 'Mleko świeże', timesBought: 9 })];
  const d = buildDraft(input([{ term: 'mleko', quantity: 1 }], true), facts, [], now);
  assert.deepEqual(lineIds(d), ['v']);
});

test('a fixed brand removes the other brand\'s usual line that matches the term', () => {
  const facts = [usual('o', { name: 'Mleko UHT', brand: 'Other' }), usual('x', { name: 'Herbata', brand: 'Other' })];
  const rules = [learnedRule({ brand: 'Fixed', preferredProductId: null, replacedProductIds: [], acceptedProductIds: [], learnedProductIds: [] })];
  assert.deepEqual(buildDraft(input([], true), facts, rules, now).items.map((l) => l.productId), ['x']);
});

test('a fixed brand removes a usual product proposed under the term, whatever its name', () => {
  const facts = [usual('a', { name: 'Napój Alfa', brand: 'Other' })];
  const rules = [learnedRule({ brand: 'Fixed', preferredProductId: null, learnedProductIds: [], acceptedProductIds: [] })];
  const d = buildDraft(input([], true), facts, rules, now);
  assert.deepEqual(lineIds(d), []);
});

test('a fixed brand keeps a usual line of that brand, whatever the case and accents', () => {
  const rules = [learnedRule({ brand: 'laciate', preferredProductId: null, replacedProductIds: [], acceptedProductIds: [], learnedProductIds: [] })];
  assert.deepEqual(lineIds(buildDraft(input([], true), [usual('m', { name: 'Mleko UHT', brand: 'Łaciate' })], rules, now)), ['m']);
});

test('without usual products, a wrong-brand or twice-replaced product is in no group', () => {
  const wrong = usual('a', { name: 'Napój Omega', brand: 'Other', offerText: '2 za 10 zł', requiredQuantity: 2 });
  const rules = [learnedRule({ brand: 'Fixed', preferredProductId: null, acceptedProductIds: [], learnedProductIds: [] })];
  const d1 = buildDraft(input([]), [wrong], rules, now);
  assert.deepEqual([...d1.items, ...d1.stockUps, ...d1.promotions, ...d1.addOns], []);
  const a = usual('a', { name: 'Napój Alfa', offerText: '2 za 10 zł', requiredQuantity: 2 });
  const d2 = buildDraft(input([]), [a, fact('b', { name: 'Napój Beta' })], [learnedRule()], now);
  assert.deepEqual([...d2.items, ...d2.stockUps, ...d2.promotions, ...d2.addOns], []);
});

test('a term line carries the candidate confidence and each alternative its own', () => {
  const facts = [
    fact('onion', { name: 'Cebula złota Warzywa Auchan 1 kg', timesBought: 5 }),
    fact('chips', { name: "Chipsy o smaku zielonej cebulki Lay's 190 g", timesBought: 2 }),
  ];
  const d = buildDraft(input([{ term: 'cebula', quantity: 1 }]), facts, [], now);
  assert.equal(d.items[0].productId, 'onion');
  assert.equal(d.items[0].confidence, 'high');
  assert.equal(d.items[0].confidenceReason, '');
  assert.equal(d.items[0].alternatives[0].confidence, 'low');

  const only = buildDraft(input([{ term: 'cebula', quantity: 1 }]), [facts[1]], [], now);
  assert.equal(only.items[0].confidence, 'low');
  assert.equal(only.items[0].confidenceReason, 'term only in the flavour');
});

test('lines not built from a term are high confidence', () => {
  const d = buildDraft(input([], true), [usual('u', { offerText: '2 za 1', requiredQuantity: 2 })], [], now);
  const all = [...d.items, ...d.stockUps, ...d.promotions, ...d.addOns];
  assert.ok(all.length > 0);
  for (const l of all) { assert.equal(l.confidence, 'high'); assert.equal(l.confidenceReason, ''); }
});

test('alternatives list confident matches before doubtful ones', () => {
  const facts = [
    fact('top', { name: 'Kawa top', timesBought: 9 }),
    fact('flavour', { name: 'Napój o smaku kawa', timesBought: 8 }),
    fact('mix', { name: 'Kawa z mlekiem', timesBought: 7 }),
    fact('ok', { name: 'Kawa mielona' }),
  ];
  const d = buildDraft(input([{ term: 'kawa', quantity: 1 }]), facts, [{ term: 'kawa', brand: null, preferredProductId: null, acceptedProductIds: ['ok'], learnedProductIds: [], replacedProductIds: [] }], now);
  assert.deepEqual(d.items[0].alternatives.map((a) => a.productId), ['ok', 'mix', 'flavour']);
});

test('draft lines and alternatives carry the product image', () => {
  const img = (id: string) => ({ imageUrl: `https://zakupy.auchan.pl/images-v3/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-00000000000${id}/300x300.jpg`, imageAlt: `alt ${id}` });
  const facts = [fact('a', { name: 'Kawa a', timesBought: 5, ...img('1') }), fact('b', { name: 'Kawa b', timesBought: 3, ...img('2') }), fact('c', { name: 'Kawa c', timesBought: 1 })];
  const d = buildDraft(input([{ term: 'kawa', quantity: 1 }]), facts, [], now);
  assert.equal(d.items[0].imageUrl, img('1').imageUrl);
  assert.equal(d.items[0].imageAlt, 'alt 1');
  const alt = (id: string) => d.items[0].alternatives.find((a) => a.productId === id)!;
  assert.equal(alt('b').imageUrl, img('2').imageUrl);
  assert.equal(alt('c').imageUrl, null);
  assert.equal(alt('c').imageAlt, null);
});

test('products the Auchan search saved for a term are candidates of its line', () => {
  const facts = [fact('j1', { name: 'Jaja wiejskie M', categoryPath: ['Nabiał'] }), fact('j2', { name: 'Jaja klatkowe L', categoryPath: ['Nabiał'], latestPriceGrosze: 500 })];
  const none = buildDraft(input([{ term: 'jajka', quantity: 1 }]), facts, [], now);
  assert.deepEqual(none.unmatched, ['jajka']);
  const d = buildDraft({ ...input([{ term: 'jajka', quantity: 1 }]), searched: { jajka: ['j1', 'j2'] } }, facts, [], now);
  assert.deepEqual(d.unmatched, []);
  assert.equal(d.items[0].productId, 'j1');
  assert.equal(d.items[0].confidence, 'medium');
  assert.equal(d.items[0].confidenceReason, 'z wyszukiwania Auchan');
  assert.deepEqual(d.items[0].alternatives.map((a) => a.productId), ['j2']);
});
