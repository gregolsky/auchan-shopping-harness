import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.ts';
import { ShapeError } from '../src/parse.ts';
import { parseDecoratedOrder } from '../src/parse.ts';
import { checkOrders, syncOrderImages, syncOrders } from '../src/sync-orders.ts';
import { GET_COMPLETED_ORDERS_QUERY, LoginRequired, Blocked } from '../src/worker.ts';

const decorated = JSON.parse(readFileSync(new URL('./fixtures/order-decorated.json', import.meta.url), 'utf8'));
const decoratedFor = (id: string) => {
  const o = structuredClone(decorated);
  const raw = o.entities.order[o.result];
  delete o.entities.order[o.result];
  raw.orderId = id;
  o.entities.order[id] = raw;
  o.result = id;
  return o;
};

const page = (ids: string[], endCursor: string | null, hasNextPage: boolean) => ({
  data: { customer: { ordersCompleted: {
    pageInfo: { endCursor, hasNextPage },
    edges: ids.map((orderId) => ({ node: { orderId } })),
  } } },
});

interface Fake {
  pages: ReturnType<typeof page>[];
  failOn?: Record<string, unknown>; // order id -> error to throw
  bad?: Set<string>; // order ids returning a malformed body
  calls: string[];
  vars: any[];
  worker: { graphql: any; getJson: any };
}
function fake(pages: Fake['pages'], extra: Partial<Fake> = {}): Fake {
  const f: Fake = { pages, calls: [], vars: [], worker: null as any, ...extra };
  f.worker = {
    async graphql(op: string, query: string, variables: any) {
      assert.equal(op, 'GetCompletedOrders');
      assert.equal(query, GET_COMPLETED_ORDERS_QUERY);
      f.calls.push('graphql');
      f.vars.push(variables);
      return f.pages[f.vars.length - 1];
    },
    async getJson(path: string) {
      const id = /orders\/([\w-]+)\/decorated/.exec(path)![1];
      f.calls.push(id);
      if (f.failOn?.[id]) throw f.failOn[id];
      if (f.bad?.has(id)) return { secret: 'leaky-content' };
      return decoratedFor(id);
    },
  };
  return f;
}
const noSleep = async () => {};
const opts = { paceMs: 1500, sleep: noSleep };

test('imports every order across pages', async () => {
  const store = openStore(':memory:');
  const f = fake([page(['1', '2'], 'c2', true), page(['3'], null, false)]);
  const r = await syncOrders(f.worker, store, opts);
  assert.equal(r.imported, 3);
  assert.equal(r.skipped, 0);
  assert.ok(r.oldestSeen);
  assert.deepEqual(f.vars, [{ first: 20, after: null }, { first: 20, after: 'c2' }]);
  assert.equal(store.recentOrders(10).length, 3);
  assert.equal(store.lastSyncStatus('orders'), 'ok');
});

test('stops paging once a full page is already stored', async () => {
  const store = openStore(':memory:');
  await syncOrders(fake([page(['1', '2'], null, false)]).worker, store, opts);
  const f = fake([page(['3', '1'], 'c', true), page(['2'], 'd', true), page(['0'], null, false)]);
  const r = await syncOrders(f.worker, store, opts);
  assert.equal(r.imported, 1); // 3 new; page 2 is fully stored -> stop
  assert.equal(f.vars.length, 2);
  assert.equal(store.hasOrder('0'), false);
});

test('does not stop early when the previous run did not finish ok', async () => {
  const store = openStore(':memory:');
  store.saveOrder((await import('../src/parse.ts')).parseDecoratedOrder(decoratedFor('1')));
  const id = store.startSync('orders');
  store.finishSync(id, 'failed');
  const f = fake([page(['1'], 'c', true), page(['0'], null, false)]);
  const r = await syncOrders(f.worker, store, opts);
  assert.equal(f.vars.length, 2);
  assert.equal(r.imported, 1);
  assert.equal(r.skipped, 1);
});

test('does not stop early after a crashed run that never recorded a status', async () => {
  const store = openStore(':memory:');
  store.saveOrder((await import('../src/parse.ts')).parseDecoratedOrder(decoratedFor('1')));
  store.finishSync(store.startSync('orders'), 'ok');
  store.startSync('orders'); // process died here
  const f = fake([page(['1'], 'c', true), page(['0'], null, false)]);
  const r = await syncOrders(f.worker, store, opts);
  assert.equal(f.vars.length, 2);
  assert.equal(r.imported, 1);
});

test('resumes an interrupted import without duplicates', async () => {
  const store = openStore(':memory:');
  const pages = [page(['1', '2', '3', '4'], null, false)];
  const f1 = fake(pages, { failOn: { '3': new LoginRequired() } });
  await assert.rejects(syncOrders(f1.worker, store, opts), LoginRequired);
  assert.equal(store.recentOrders(10).length, 2);
  assert.equal(store.lastSyncStatus('orders'), 'failed');
  const r = await syncOrders(fake(pages).worker, store, opts);
  assert.equal(r.imported, 2);
  assert.equal(r.skipped, 2);
  assert.equal(store.recentOrders(10).length, 4);
  assert.equal(store.lastSyncStatus('orders'), 'ok');
});

test('Blocked stops at once with no retry', async () => {
  const store = openStore(':memory:');
  const f = fake([page(['1', '2'], null, false)], { failOn: { '1': new Blocked('x') } });
  await assert.rejects(syncOrders(f.worker, store, opts), Blocked);
  assert.deepEqual(f.calls, ['graphql', '1']);
  assert.equal(store.lastSyncStatus('orders'), 'failed');
});

test('ShapeError on one order stops the sync and names the order', async () => {
  const store = openStore(':memory:');
  const f = fake([page(['1', '2', '3'], null, false)], { bad: new Set(['2']) });
  await assert.rejects(syncOrders(f.worker, store, opts), (e: Error) => {
    assert.ok(e instanceof ShapeError);
    assert.match(e.message, /\b2\b/);
    assert.doesNotMatch(e.message, /leaky-content|secret/);
    return true;
  });
  assert.equal(store.hasOrder('2'), false);
  assert.equal(store.hasOrder('3'), false);
  assert.equal(store.hasOrder('1'), true);
  assert.equal(store.lastSyncStatus('orders'), 'failed');
});

test('waits paceMs between requests', async () => {
  const store = openStore(':memory:');
  const slept: number[] = [];
  const f = fake([page(['1', '2'], 'c', true), page(['3'], null, false)]);
  await syncOrders(f.worker, store, { paceMs: 1500, sleep: async (ms) => void slept.push(ms) });
  // 4 requests (2 pages + 3 orders = 5) -> 4 gaps
  assert.equal(f.calls.length, 5);
  assert.deepEqual(slept, [1500, 1500, 1500, 1500]);
});

test('hasNextPage with no cursor fails the run and the next run does not stop early', async () => {
  const store = openStore(':memory:');
  // an earlier ok run, so early stop would be enabled if this run were recorded ok
  const okId = store.startSync('orders');
  store.finishSync(okId, 'ok');
  for (const cursor of [null, '']) {
    const f = fake([page(['1'], cursor, true)]);
    await assert.rejects(syncOrders(f.worker, store, opts), (e: Error) => e instanceof ShapeError);
    assert.equal(store.lastSyncStatus('orders'), 'failed');
  }
  assert.equal(store.hasOrder('1'), true);
  const f2 = fake([page(['1'], 'c', true), page(['0'], null, false)]);
  const r = await syncOrders(f2.worker, store, opts);
  assert.equal(f2.vars.length, 2);
  assert.equal(r.imported, 1);
});

test('adds up skipped lines, substitutes, missings and returns across imported orders', async () => {
  const store = openStore(':memory:');
  const f = fake([page(['1', '2'], null, false)]);
  const getJson = f.worker.getJson;
  f.worker.getJson = async (path: string) => {
    const o = await getJson(path);
    const grouped = o.entities.order[o.result].groupedProducts;
    grouped.products[0].quantity = 0;
    Object.assign(grouped, { substitutes: [{}], missings: [{}, {}], returns: [{}, {}, {}] });
    return o;
  };
  const r = await syncOrders(f.worker, store, opts);
  assert.deepEqual(
    [r.skippedZero, r.substitutes, r.missings, r.returns],
    [2, 2, 4, 6],
  );
  assert.equal(store.hasOrder('1'), true);
});

test('checkOrders paces its two requests and touches no store', async () => {
  const slept: number[] = [];
  const f = fake([page(['1', '2'], 'c', true)]);
  const r = await checkOrders(f.worker, { paceMs: 1500, sleep: async (ms) => void slept.push(ms) });
  assert.deepEqual(r, { orders: 2 });
  assert.deepEqual(f.calls, ['graphql', '1']);
  assert.deepEqual(slept, [1500]);
  assert.deepEqual(f.vars, [{ first: 20, after: null }]);
});

test('checkOrders refuses a response for another order', async () => {
  const f = fake([page(['1'], null, false)]);
  f.worker.getJson = async () => decoratedFor('2');
  await assert.rejects(checkOrders(f.worker, opts), ShapeError);
});

// Orders imported before images were read: same products, no image on any of them.
function seedImageless(store: ReturnType<typeof openStore>, ids: string[]) {
  for (const id of ids) {
    const parsed = parseDecoratedOrder(decoratedFor(id));
    store.saveOrder({ ...parsed, products: parsed.products.map((p) => ({ ...p, imageUrl: null, imageAlt: null })) });
  }
  store.saveOrder({
    order: { orderId: 'done', deliveredAt: '2026-10-01T10:00:00Z', totalGrosze: 100, regionId: 'r' },
    lines: [{ orderId: 'done', productId: 'z', quantity: 1, pricePerItemGrosze: 100 }],
    products: [{ productId: 'z', retailerProductId: 'z', name: 'Z', brand: '', categoryPath: [], unitLabel: null, size: null, inCatalogue: true, imageUrl: 'https://zakupy.auchan.pl/images-v3/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/300x300.jpg', imageAlt: 'z' }],
    prices: [],
  });
}

test('the image backfill fetches only orders with an imageless product and writes only images', async () => {
  const store = openStore(':memory:');
  seedImageless(store, ['1', '2']);
  const before = store.productFacts();
  const pricePoints = (facts: typeof before) => facts.reduce((n, f) => n + f.pricePoints, 0);
  assert.deepEqual(store.ordersMissingImages(), ['1', '2']);
  const f = fake([]);
  const slept: number[] = [];
  const r = await syncOrderImages(f.worker, store, { paceMs: 1500, sleep: async (ms) => void slept.push(ms) });
  assert.deepEqual(f.calls, ['1', '2']); // no listing, and the order with an image is not fetched
  assert.deepEqual(slept, [1500]);
  assert.equal(r.fetched, 2);
  const after = store.productFacts();
  assert.equal(after.filter((p) => p.imageUrl).length, before.filter((p) => p.imageUrl).length + 2);
  assert.equal(after.length, before.length);
  assert.equal(pricePoints(after), pricePoints(before));
  assert.equal(store.recentOrders(10).length, 3);
  assert.equal(store.lastSyncStatus('orders'), null);
  for (const p of after) assert.equal(p.name, before.find((b) => b.productId === p.productId)!.name);
});

test('the image backfill does nothing, and asks for nothing, when every order has images', async () => {
  const store = openStore(':memory:');
  const f = fake([]);
  assert.equal((await syncOrderImages(f.worker, store, opts)).fetched, 0);
  assert.deepEqual(f.calls, []);
});

test('the image backfill stops at a Blocked without another request', async () => {
  const store = openStore(':memory:');
  seedImageless(store, ['1', '2']);
  const f = fake([], { failOn: { '1': new Blocked('HTTP 403') } });
  await assert.rejects(syncOrderImages(f.worker, store, opts), Blocked);
  assert.deepEqual(f.calls, ['1']);
});

test('the image backfill refuses an order body of another shape without leaking it', async () => {
  const store = openStore(':memory:');
  seedImageless(store, ['1']);
  const f = fake([], { bad: new Set(['1']) });
  await assert.rejects(syncOrderImages(f.worker, store, opts), (e: Error) => e instanceof ShapeError && !/leaky/.test(e.message));
});
