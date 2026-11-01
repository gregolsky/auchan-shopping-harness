import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseGrosze,
  parseDecoratedOrder,
  parsePromotionsState,
  parseCompletedOrdersPage,
  ShapeError,
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
