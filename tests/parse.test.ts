import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseGrosze,
  parseDecoratedOrder,
  parsePromotionsState,
  parseSearchState,
  parseCompletedOrdersPage,
  ShapeError,
  cleanText,
} from '../src/parse.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('parseGrosze handles strings, numbers and commas', () => {
  assert.equal(parseGrosze('11.98'), 1198);
  assert.equal(parseGrosze(19.98), 1998);
  assert.equal(parseGrosze('3,18'), 318);
});

test('parseGrosze rejects garbage', () => {
  assert.throws(() => parseGrosze(''), ShapeError);
  assert.throws(() => parseGrosze('n/a'), ShapeError);
});

test('decorated order yields one line per grouped product with quantity', () => {
  const json = fx('order-decorated.json');
  const expected = json.entities.order[json.result].groupedProducts.products.length;
  const { order, lines } = parseDecoratedOrder(json);
  assert.equal(lines.length, expected);
  assert.ok(lines.every((l) => l.quantity >= 1 && l.orderId === order.orderId));
  assert.equal(order.orderId, '1000000001');
  assert.equal(order.regionId, json.entities.order[json.result].regionId);
  assert.equal(order.totalGrosze, 4644);
});

test('weighed item keeps quantity 1', () => {
  const { lines, products } = parseDecoratedOrder(fx('order-decorated.json'));
  const banana = products.find((p) => /Banany/.test(p.name))!;
  assert.equal(lines.find((l) => l.productId === banana.productId)!.quantity, 1);
  assert.equal(banana.unitLabel, 'fop.price.per.kg');
});

test('promoted line stores original and current price', () => {
  const { prices } = parseDecoratedOrder(fx('order-decorated.json'));
  const promo = prices.find((p) => p.offerText === '20% taniej')!;
  assert.equal(promo.originalGrosze, 2258);
  assert.equal(promo.currentGrosze, 1807);
  assert.equal(promo.source, 'order');
  assert.equal(prices.find((p) => p.offerText === null)!.originalGrosze, null);
});

test('promotions state exposes offer text and multibuy quantity', () => {
  const { regionId, prices, products } = parsePromotionsState(fx('promotions-state.json'), '2026-10-31T10:00:00Z');
  assert.match(regionId, /^[0-9a-f-]{36}$/);
  assert.equal(prices.length, products.length);
  assert.ok(prices.some((p) => p.offerText === '20% taniej'));
  const multi = prices.find((p) => (p.requiredQuantity ?? 0) >= 2)!;
  assert.equal(multi.currentGrosze, 254);
  assert.equal(multi.source, 'promotion');
  assert.equal(multi.regionId, regionId);
});

test('completed orders page returns ids and cursor', () => {
  const page = parseCompletedOrdersPage(fx('completed-orders.json'));
  assert.deepEqual(page.orderIds, ['1000000001', '1000000002', '1000000003']);
  assert.equal(page.endCursor, 'cursor-3');
  assert.equal(page.hasNextPage, true);
});

test('missing groupedProducts throws ShapeError', () => {
  const json = fx('order-decorated.json');
  delete json.entities.order[json.result].groupedProducts;
  assert.throws(() => parseDecoratedOrder(json), ShapeError);
});

test('missing quantity throws ShapeError', () => {
  const json = fx('order-decorated.json');
  delete json.entities.order[json.result].groupedProducts.products[0].quantity;
  assert.throws(() => parseDecoratedOrder(json), ShapeError);
});

const linesOf = (json: any): any[] => json.entities.order[json.result].groupedProducts.products;

test('a line whose product is missing from entities falls back to the line itself', () => {
  const json = fx('order-decorated.json');
  const line = linesOf(json)[0];
  delete json.entities.product[line.productId];
  const { products, lines } = parseDecoratedOrder(json);
  const p = products.find((x) => x.productId === line.productId)!;
  assert.equal(p.retailerProductId, line.retailerProductId);
  assert.equal(p.name, line.name);
  assert.equal(p.brand, '');
  assert.deepEqual(p.categoryPath, []);
  assert.equal(lines.length, linesOf(json).length);
});

test('an order with no product entities at all still parses from its lines', () => {
  const json = fx('order-decorated.json');
  delete json.entities.product;
  assert.equal(parseDecoratedOrder(json).products.length, linesOf(json).length);
});

test('null retailerProductId or name on an entity falls back to the line', () => {
  const json = fx('order-decorated.json');
  const line = linesOf(json)[0];
  json.entities.product[line.productId].retailerProductId = null;
  json.entities.product[line.productId].name = null;
  const p = parseDecoratedOrder(json).products.find((x) => x.productId === line.productId)!;
  assert.equal(p.retailerProductId, line.retailerProductId);
  assert.equal(p.name, line.name);
});

test('a line with no productId throws ShapeError, even at quantity 0', () => {
  for (const quantity of [1, 0]) {
    const json = fx('order-decorated.json');
    delete linesOf(json)[0].productId;
    linesOf(json)[0].quantity = quantity;
    assert.throws(() => parseDecoratedOrder(json), ShapeError);
  }
});

test('zero quantity lines are skipped and counted, whatever else they lack', () => {
  const json = fx('order-decorated.json');
  const count = linesOf(json).length;
  linesOf(json)[0].quantity = 0;
  linesOf(json)[1].quantity = '0';
  delete linesOf(json)[1].prices;
  const r = parseDecoratedOrder(json);
  assert.equal(r.skippedZero, 2);
  assert.equal(r.lines.length, count - 2);
  assert.equal(r.products.length, count - 2);
  assert.equal(r.prices.length, count - 2);
});

test('numeric string quantities are accepted, junk is not', () => {
  const json = fx('order-decorated.json');
  linesOf(json)[0].quantity = '2.5';
  assert.equal(parseDecoratedOrder(json).lines[0].quantity, 2.5);
  for (const bad of ['', ' ', 'two', 'Infinity', -1, '-1', null, true]) {
    const j = fx('order-decorated.json');
    linesOf(j)[0].quantity = bad;
    assert.throws(() => parseDecoratedOrder(j), ShapeError, String(bad));
  }
});

test('the same product twice sums quantities and keeps the first price', () => {
  const json = fx('order-decorated.json');
  const [first, second] = linesOf(json);
  first.quantity = 2;
  second.productId = first.productId;
  second.quantity = '3';
  second.prices.pricePerItem.amount = '0.01';
  const r = parseDecoratedOrder(json);
  const same = r.lines.filter((l) => l.productId === first.productId);
  assert.equal(same.length, 1);
  assert.equal(same[0].quantity, 5);
  assert.equal(same[0].pricePerItemGrosze, parseGrosze(first.prices.pricePerItem.amount));
  assert.equal(r.products.filter((p) => p.productId === first.productId).length, 1);
  assert.equal(r.prices.filter((p) => p.productId === first.productId).length, 1);
});

test('substitutes, missings and returns are counted from groupedProducts', () => {
  const json = fx('order-decorated.json');
  assert.deepEqual(
    (({ skippedZero, substitutes, missings, returns }) => ({ skippedZero, substitutes, missings, returns }))(parseDecoratedOrder(json)),
    { skippedZero: 0, substitutes: 0, missings: 0, returns: 0 },
  );
  Object.assign(json.entities.order[json.result].groupedProducts, { substitutes: [{}, {}], missings: [{}], returns: [{}, {}, {}] });
  const r = parseDecoratedOrder(json);
  assert.deepEqual([r.substitutes, r.missings, r.returns], [2, 1, 3]);
});

test('a non-array substitutes list throws ShapeError', () => {
  const json = fx('order-decorated.json');
  json.entities.order[json.result].groupedProducts.substitutes = 'many';
  assert.throws(() => parseDecoratedOrder(json), ShapeError);
});

test('size comes from size.value on order entities', () => {
  const json = fx('order-decorated.json');
  const line = linesOf(json)[0];
  const { products } = parseDecoratedOrder(json);
  assert.equal(products[0].size, json.entities.product[line.productId].size.value);
  assert.ok(products[0].size);
});

test('size is null when an order entity has none or the line has no entity', () => {
  const json = fx('order-decorated.json');
  const [a, b] = linesOf(json);
  delete json.entities.product[a.productId].size;
  delete json.entities.product[b.productId];
  const { products } = parseDecoratedOrder(json);
  assert.equal(products[0].size, null);
  assert.equal(products[1].size, null);
});

test('size comes from size.value on promotion entities, null when absent or blank', () => {
  const state = fx('promotions-state.json');
  const entities = Object.values<any>(state.data.products.productEntities);
  delete entities[1].size;
  entities[2].size = { value: '  ' };
  const { products } = parsePromotionsState(state, 'x');
  assert.equal(products[0].size, entities[0].size.value);
  assert.ok(products[0].size);
  assert.equal(products[1].size, null);
  assert.equal(products[2].size, null);
});

test('missing deliveryEndDate throws ShapeError', () => {
  const json = fx('order-decorated.json');
  delete json.entities.order[json.result].dates.deliveryEndDate;
  assert.throws(() => parseDecoratedOrder(json), ShapeError);
});

test('missing order regionId throws ShapeError', () => {
  const json = fx('order-decorated.json');
  delete json.entities.order[json.result].regionId;
  assert.throws(() => parseDecoratedOrder(json), ShapeError);
});

test('malformed promotion element throws ShapeError, not TypeError', () => {
  const json = fx('order-decorated.json');
  json.entities.order[json.result].groupedProducts.products[0].promotions = [null];
  assert.throws(() => parseDecoratedOrder(json), ShapeError);
});

test('promotions state shape errors throw ShapeError', () => {
  const noRegion = fx('promotions-state.json');
  delete noRegion.session.metadata.regionId;
  assert.throws(() => parsePromotionsState(noRegion, 'x'), ShapeError);
  const noPrice = fx('promotions-state.json');
  delete Object.values<any>(noPrice.data.products.productEntities)[0].price;
  assert.throws(() => parsePromotionsState(noPrice, 'x'), ShapeError);
  const noId = fx('promotions-state.json');
  delete Object.values<any>(noId.data.products.productEntities)[0].productId;
  assert.throws(() => parsePromotionsState(noId, 'x'), ShapeError);
});

test('completed orders page shape errors throw ShapeError', () => {
  const noEdges = fx('completed-orders.json');
  delete noEdges.data.customer.ordersCompleted.edges;
  assert.throws(() => parseCompletedOrdersPage(noEdges), ShapeError);
  const noId = fx('completed-orders.json');
  delete noId.data.customer.ordersCompleted.edges[0].node.orderId;
  assert.throws(() => parseCompletedOrdersPage(noId), ShapeError);
});

const DIRTY = 'Mleko\u001b]52;c;ZXZpbA==\u0007 3,2%\u202e\u2066x\u2069\u009b\u007f';

test('cleanText strips control and bidi characters and keeps the rest', () => {
  assert.equal(cleanText(DIRTY), 'Mleko]52;c;ZXZpbA== 3,2%x');
  assert.equal(cleanText('Żółć 1\u00a0l – ok'), 'Żółć 1\u00a0l – ok');
});

test('parsing cleans product names, brands and offer texts from Auchan', () => {
  const order = fx('order-decorated.json');
  const raw = order.entities.order[order.result];
  const first = raw.groupedProducts.products[0];
  order.entities.product[first.productId].name = DIRTY;
  order.entities.product[first.productId].brand = DIRTY;
  first.promotions = [{ name: DIRTY }];
  const parsed = parseDecoratedOrder(order);
  const product = parsed.products.find((p) => p.productId === first.productId)!;
  assert.equal(product.name, 'Mleko]52;c;ZXZpbA== 3,2%x');
  assert.equal(product.brand, 'Mleko]52;c;ZXZpbA== 3,2%x');
  assert.equal(parsed.prices.find((p) => p.productId === first.productId)!.offerText, 'Mleko]52;c;ZXZpbA== 3,2%x');

  const promo = fx('promotions-state.json');
  const entity = Object.values<any>(promo.data.products.productEntities).find((e) => Array.isArray(e.offers) && e.offers.length)!;
  entity.name = DIRTY;
  entity.offers[0].description = DIRTY;
  const out = parsePromotionsState(promo, '2026-10-31T10:00:00Z');
  const id = entity.productId;
  assert.equal(out.products.find((p) => p.productId === id)!.name, 'Mleko]52;c;ZXZpbA== 3,2%x');
  assert.equal(out.prices.find((p) => p.productId === id)!.offerText, 'Mleko]52;c;ZXZpbA== 3,2%x');
});

test('fixtures carry no real location data', () => {
  for (const f of ['completed-orders.json', 'promotions-state.json', 'order-decorated.json']) {
    const text = readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
    for (const m of text.matchAll(/"regionId": "([^"]+)"/g)) assert.equal(m[1], '00000000-0000-4000-8000-000000000010');
    for (const m of text.matchAll(/"retailerRegionId": "([^"]+)"/g)) assert.equal(m[1], 'PL_00000_TEST');
  }
});

import { parseImage } from '../src/parse.ts';

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '10000000-0000-4000-8000-000000000001';
const good = (size = '500x500', ext = 'jpg') => `https://zakupy.auchan.pl/images-v3/${U1}/${U2}/${size}.${ext}`;

test('parseImage normalises the size to 300x300 and cleans the description', () => {
  assert.deepEqual(parseImage([{ src: good(), description: 'Pack\u0007 shot' }]), { url: good('300x300'), alt: 'Pack shot' });
  assert.equal(parseImage([{ src: good('64x64', 'webp') }])?.url, good('300x300', 'webp'));
  assert.equal(parseImage([{ src: good(), description: 'x'.repeat(400) }])?.alt?.length, 300);
  assert.equal(parseImage([{ src: good(), description: '' }])?.alt, null);
});

test('parseImage only takes the first image and refuses hostile or malformed urls', () => {
  assert.equal(parseImage(undefined), null);
  assert.equal(parseImage([]), null);
  assert.equal(parseImage([{ src: 'https://evil.example/images-v3/' + U1 + '/' + U2 + '/300x300.jpg' }]), null);
  assert.equal(parseImage([{ src: 'javascript:alert(1)' }]), null);
  assert.equal(parseImage([{ src: `https://zakupy.auchan.pl/images-v3/${U1}/../${U2}/300x300.jpg` }]), null);
  assert.equal(parseImage([{ src: good() + '?x=1' }]), null);
  assert.equal(parseImage([{ src: 'http://zakupy.auchan.pl/images-v3/' + U1 + '/' + U2 + '/300x300.jpg' }]), null);
  assert.equal(parseImage([{ src: 42 }]), null);
  assert.equal(parseImage([{ src: 'https://evil.example/x.jpg' }, { src: good() }]), null);
  assert.equal(parseImage('nope'), null);
});

test('orders carry the first image of each product', () => {
  const { products } = parseDecoratedOrder(fx('order-decorated.json'));
  const withImage = products.filter((p) => p.imageUrl);
  assert.equal(withImage.length, 2);
  assert.match(withImage[0].imageUrl!, /\/300x300\.jpg$/);
  assert.equal(withImage[0].imageAlt, 'Synthetic pack shot of a test product.');
  assert.equal(withImage[1].imageAlt!.length, 300);
  assert.ok(products.filter((p) => !p.imageUrl).every((p) => p.imageUrl === null && p.imageAlt === null));
});

test('promotions carry the first image of each product', () => {
  const { products } = parsePromotionsState(fx('promotions-state.json'), '2026-11-01T10:00:00Z');
  const withImage = products.filter((p) => p.imageUrl);
  assert.ok(withImage.length >= 1);
  assert.match(withImage[0].imageUrl!, /^https:\/\/zakupy\.auchan\.pl\/images-v3\/.+\/300x300\.jpg$/);
  assert.ok(products.some((p) => p.imageUrl === null && p.imageAlt === null));
});

test('parseSearchState reads products and search-sourced prices', () => {
  const r = parseSearchState(fx('search-state.json'), 'parówki', '2026-11-15T10:00:00Z');
  assert.equal(r.term, 'parówki');
  assert.equal(r.regionId, '00000000-0000-4000-8000-000000000010');
  assert.equal(r.products.length, 4);
  assert.equal(r.prices.length, 4);
  assert.ok(r.prices.every((p) => p.source === 'search' && p.seenAt === '2026-11-15T10:00:00Z' && p.regionId === r.regionId));
  const [plain, offer, , gone] = r.products;
  assert.equal(plain.name, 'Parówki klasyczne Testowo 270 g');
  assert.equal(plain.inCatalogue, true);
  assert.equal(gone.inCatalogue, false);
  assert.equal(r.prices[0].currentGrosze, 497);
  assert.equal(r.prices[0].offerText, null);
  assert.equal(offer.productId, r.prices[1].productId);
  assert.equal(r.prices[1].originalGrosze, 499);
  assert.equal(r.prices[1].offerText, '2  za 7,52 zł');
  assert.equal(r.prices[1].requiredQuantity, 2);
});

test('parseSearchState caps at 40 products and skips unpriced ones', () => {
  const state = fx('search-state.json');
  const base = Object.values(state.data.products.productEntities)[0] as any;
  const many: Record<string, unknown> = { nope: { ...base, productId: 'nope', price: undefined } };
  for (let i = 0; i < 60; i++) many[`p${i}`] = { ...base, productId: `p${i}` };
  state.data.products.productEntities = many;
  const r = parseSearchState(state, 'x');
  assert.equal(r.products.length, 40);
  assert.equal(r.prices.length, 40);
  assert.ok(r.products.every((p) => p.productId !== 'nope'));
});

test('parseSearchState rejects a state without a region or products', () => {
  assert.throws(() => parseSearchState({ session: { metadata: {} }, data: {} }, 'x'), ShapeError);
  assert.throws(() => parseSearchState(null, 'x'), ShapeError);
  assert.throws(() => parseSearchState({ session: { metadata: { regionId: 'r' } }, data: {} }, 'x'), ShapeError);
});

test('category path, size and unit label are cleaned of control characters and cut to 200 characters', () => {
  const state = fx('search-state.json');
  const first = Object.values(state.data.products.productEntities)[0] as any;
  first.categoryPath = ['Dział‮\u0007', 'x'.repeat(500)];
  first.size = { value: `  1\u001b[31m kg${'y'.repeat(500)} ` };
  first.price.unit.label = `fop.\u0000${'z'.repeat(500)}`;
  const p = parseSearchState(state, 'x').products[0];
  assert.equal(p.categoryPath[0], 'Dział');
  assert.equal(p.categoryPath[1].length, 200);
  assert.ok(!/[\u0000-\u001f‮]/.test(p.size!) && p.size!.length === 200);
  assert.ok(!/\u0000/.test(p.unitLabel!) && p.unitLabel!.length === 200);
});

test('one malformed product on a search page is skipped, the others are kept', () => {
  const state = fx('search-state.json');
  const entities = state.data.products.productEntities as Record<string, any>;
  const ids = Object.keys(entities);
  entities[ids[1]].price.current = { amount: 'not money' };
  entities[ids[2]].name = '';
  const r = parseSearchState(state, 'x');
  assert.deepEqual(r.products.map((p) => p.productId), [ids[0], ids[3]]);
  assert.equal(r.prices.length, 2);
  assert.throws(() => parsePromotionsState(state, '2026-11-01T10:00:00Z'), ShapeError, 'other pages stay strict');
});

test('product names and brands are cut to 200 characters, offer texts to 300', () => {
  const order = fx('order-decorated.json');
  const first = order.entities.order[order.result].groupedProducts.products[0];
  order.entities.product[first.productId].name = 'n'.repeat(500);
  order.entities.product[first.productId].brand = 'b'.repeat(500);
  first.promotions = [{ name: 'o'.repeat(900) }];
  const parsed = parseDecoratedOrder(order);
  const product = parsed.products.find((p) => p.productId === first.productId)!;
  assert.equal(product.name.length, 200);
  assert.equal(product.brand.length, 200);
  assert.equal(parsed.prices.find((p) => p.productId === first.productId)!.offerText!.length, 300);

  const promo = fx('promotions-state.json');
  const entity = Object.values<any>(promo.data.products.productEntities).find((e) => Array.isArray(e.offers) && e.offers.length)!;
  entity.name = 'n'.repeat(500);
  entity.brand = 'b'.repeat(500);
  entity.offers[0].description = 'o'.repeat(900);
  const out = parsePromotionsState(promo, '2026-10-31T10:00:00Z');
  assert.equal(out.products.find((p) => p.productId === entity.productId)!.name.length, 200);
  assert.equal(out.products.find((p) => p.productId === entity.productId)!.brand.length, 200);
  assert.equal(out.prices.find((p) => p.productId === entity.productId)!.offerText!.length, 300);
});

test('cleanText also strips direction marks, line separators and zero-width characters', () => {
  for (const ch of ['‎', '‏', '؜', ' ', ' ', '​', '‌', '‍', '﻿', '⁠']) {
    assert.equal(cleanText(`Mle${ch}ko`), 'Mleko', `U+${ch.codePointAt(0)!.toString(16)}`);
  }
  assert.equal(cleanText('Żółć 1 l – ok'), 'Żółć 1 l – ok');
});
