import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { parseDecoratedOrder, parsePromotionsState } from '../src/parse.ts';
import type { Product, PriceObservation } from '../src/types.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

const product = (productId: string, name: string): Product => ({
  productId,
  retailerProductId: `r-${productId}`,
  name,
  brand: 'Brand',
  categoryPath: ['A', 'B'],
  unitLabel: 'kg',
  size: '500 g',
  inCatalogue: true,
});

const price = (productId: string, seenAt: string, currentGrosze: number): PriceObservation => ({
  productId,
  seenAt,
  regionId: 'r1',
  source: 'promotion',
  originalGrosze: null,
  currentGrosze,
  unitCurrentGrosze: null,
  offerText: null,
  requiredQuantity: null,
});

const promo = (products: Product[], prices: PriceObservation[]) => ({ regionId: 'r1', products, prices });

const orderOf = (orderId: string, productIds: string[]) => ({
  order: { orderId, deliveredAt: '2026-10-01T10:00:00Z', totalGrosze: 1000, regionId: 'r1' },
  lines: productIds.map((productId) => ({ orderId, productId, quantity: 1, pricePerItemGrosze: 500 })),
  products: productIds.map((id) => product(id, `Produkt ${id}`)),
  prices: [] as PriceObservation[],
});

// Count rows through a second connection to a temp file so tests see real persisted state.
function withFile(fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'store-test-'));
  try {
    fn(join(dir, 't.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function count(path: string, table: string): number {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test('saving an order twice leaves one order and no duplicate lines', () => {
  withFile((path) => {
    const store = openStore(path);
    const parsed = parseDecoratedOrder(fx('order-decorated.json'));
    store.saveOrder(parsed);
    const before = [count(path, 'orders'), count(path, 'order_lines'), count(path, 'products'), count(path, 'price_history')];
    store.saveOrder(parsed);
    const after = [count(path, 'orders'), count(path, 'order_lines'), count(path, 'products'), count(path, 'price_history')];
    store.close();
    assert.equal(before[0], 1);
    assert.equal(before[1], parsed.lines.length);
    assert.deepEqual(after, before);
  });
});

test('saveOrder is atomic', () => {
  withFile((path) => {
    const store = openStore(path);
    const parsed = orderOf('o1', ['a', 'b']);
    parsed.lines.push({ orderId: 'o1', productId: 'ghost', quantity: 1, pricePerItemGrosze: 100 });
    assert.throws(() => store.saveOrder(parsed));
    assert.equal(store.hasOrder('o1'), false);
    store.close();
    assert.equal(count(path, 'order_lines'), 0);
    assert.equal(count(path, 'products'), 0);
  });
});

test('latestOrderRegion is null with no orders, then the newest delivered order\'s region', () => {
  const store = openStore(':memory:');
  assert.equal(store.latestOrderRegion(), null);
  const newer = orderOf('o1', ['a']);
  newer.order.regionId = 'new-region';
  newer.order.deliveredAt = '2026-10-20T10:00:00Z';
  const older = orderOf('o2', ['a']);
  older.order.regionId = 'old-region';
  store.saveOrder(newer);
  store.saveOrder(older); // saved later, delivered earlier
  assert.equal(store.latestOrderRegion(), 'new-region');
  store.close();
});

test('hasOrder is true after a successful save', () => {
  const store = openStore(':memory:');
  assert.equal(store.hasOrder('o1'), false);
  store.saveOrder(orderOf('o1', ['a']));
  assert.equal(store.hasOrder('o1'), true);
  store.close();
});

test('same price observed twice on one day stores one row', () => {
  withFile((path) => {
    const store = openStore(path);
    const p = product('a', 'Masło');
    store.savePromotions(promo([p], [price('a', '2026-10-31T08:00:00Z', 599)]));
    store.savePromotions(promo([p], [price('a', '2026-10-31T17:00:00Z', 599)]));
    store.close();
    assert.equal(count(path, 'price_history'), 1);
  });
});

test('changed price stores a new row', () => {
  withFile((path) => {
    const store = openStore(path);
    const p = product('a', 'Masło');
    store.savePromotions(promo([p], [price('a', '2026-10-31T08:00:00Z', 599)]));
    store.savePromotions(promo([p], [price('a', '2026-10-31T17:00:00Z', 549)]));
    store.close();
    assert.equal(count(path, 'price_history'), 2);
  });
});

test('same price with changed offer text stores a new row', () => {
  withFile((path) => {
    const store = openStore(path);
    const p = product('a', 'Masło');
    store.savePromotions(promo([p], [{ ...price('a', '2026-10-31T08:00:00Z', 599), offerText: '2 za 10 zł' }]));
    store.savePromotions(promo([p], [{ ...price('a', '2026-10-31T17:00:00Z', 599), offerText: '3 za 15 zł' }]));
    store.close();
    assert.equal(count(path, 'price_history'), 2);
  });
});

test('same price with the same null offer stores one row', () => {
  withFile((path) => {
    const store = openStore(path);
    const p = product('a', 'Masło');
    store.savePromotions(promo([p], [price('a', '2026-10-31T08:00:00Z', 599)]));
    store.savePromotions(promo([p], [price('a', '2026-10-31T09:00:00Z', 599)]));
    store.close();
    assert.equal(count(path, 'price_history'), 1);
  });
});

test('savePromotions with a foreign-region price throws and writes nothing', () => {
  withFile((path) => {
    const store = openStore(path);
    const at = '2026-10-31T08:00:00Z';
    assert.throws(() =>
      store.savePromotions(promo([product('a', 'A'), product('b', 'B')], [price('a', at, 100), { ...price('b', at, 200), regionId: 'other' }])),
    );
    store.close();
    assert.equal(count(path, 'products'), 0);
    assert.equal(count(path, 'price_history'), 0);
  });
});

test('productHistory matches Polish text regardless of case', () => {
  const store = openStore(':memory:');
  const parsed = orderOf('o1', ['a', 'b']);
  parsed.products[0] = product('a', 'Masło ekstra');
  parsed.products[1] = product('b', 'Mleko');
  store.saveOrder(parsed);
  for (const q of ['MASŁO', 'masło', 'Ekstra']) {
    const hits = store.productHistory(q);
    assert.deepEqual(hits.map((h) => h.productId), ['a'], q);
  }
  const [hit] = store.productHistory('masło');
  assert.equal(hit.timesOrdered, 1);
  assert.equal(hit.lastPriceGrosze, 500);
  store.close();
});

test('productHistory and currentPromotions expose size', () => {
  const store = openStore(':memory:');
  store.saveOrder(orderOf('o1', ['a']));
  store.savePromotions(promo([product('a', 'Masło')], [price('a', '2026-10-31T08:00:00Z', 100)]));
  assert.equal(store.productHistory('masło')[0].size, '500 g');
  assert.equal(store.currentPromotions({ limit: 1 })[0].size, '500 g');
  store.close();
});

test('productHistory treats LIKE wildcards literally', () => {
  const store = openStore(':memory:');
  store.saveOrder(orderOf('o1', ['a']));
  assert.deepEqual(store.productHistory('%'), []);
  store.close();
});

test('recentOrders returns newest first, limited', () => {
  const store = openStore(':memory:');
  const o1 = orderOf('o1', ['a']);
  const o2 = orderOf('o2', ['a', 'b']);
  o2.order.deliveredAt = '2026-10-15T10:00:00Z';
  store.saveOrder(o1);
  store.saveOrder(o2);
  const rows = store.recentOrders(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].orderId, 'o2');
  assert.equal(rows[0].lineCount, 2);
  store.close();
});

test('currentPromotions boughtBefore returns only products with order lines', () => {
  const store = openStore(':memory:');
  store.saveOrder(orderOf('o1', ['a']));
  const at = '2026-10-31T08:00:00Z';
  store.savePromotions(promo([product('a', 'Kupiony'), product('b', 'Nowy')], [price('a', at, 100), price('b', at, 200)]));
  assert.deepEqual(store.currentPromotions({ boughtBefore: true, limit: 10 }).map((r) => r.productId), ['a']);
  assert.deepEqual(store.currentPromotions({ limit: 10 }).map((r) => r.productId).sort(), ['a', 'b']);
  assert.equal(store.currentPromotions({ limit: 1 }).length, 1);
  store.close();
});

test('currentPromotions excludes rows from earlier syncs', () => {
  const store = openStore(':memory:');
  store.savePromotions(promo([product('a', 'Stary')], [price('a', '2026-10-30T08:00:00Z', 100)]));
  store.savePromotions(promo([product('b', 'Nowy')], [price('b', '2026-10-31T08:00:00Z', 200)]));
  assert.deepEqual(store.currentPromotions({ limit: 10 }).map((r) => r.productId), ['b']);
  store.close();
});

test('currentPromotions keeps an unchanged product re-seen in a same-day later sync', () => {
  const store = openStore(':memory:');
  const p = product('a', 'Masło');
  store.savePromotions(promo([p], [price('a', '2026-10-31T08:00:00Z', 599)]));
  store.savePromotions(promo([p, product('b', 'Ser')], [price('a', '2026-10-31T17:00:00Z', 599), price('b', '2026-10-31T17:00:00Z', 300)]));
  assert.deepEqual(store.currentPromotions({ limit: 10 }).map((r) => r.productId).sort(), ['a', 'b']);
  store.close();
});

test('savePromotions stores real parsed fixture', () => {
  const store = openStore(':memory:');
  const parsed = parsePromotionsState(fx('promotions-state.json'), '2026-10-31T10:00:00Z');
  store.savePromotions(parsed);
  assert.equal(store.currentPromotions({ limit: 1000 }).length, parsed.prices.length);
  store.close();
});

test('sync runs track status per kind', () => {
  const store = openStore(':memory:');
  assert.equal(store.lastSyncStatus('orders'), null);
  const id = store.startSync('orders');
  assert.equal(store.lastSyncStatus('orders'), null, 'unfinished run has no status');
  store.finishSync(id, 'ok');
  assert.equal(store.lastSyncStatus('orders'), 'ok');
  assert.equal(store.lastSyncStatus('promotions'), null);
  store.finishSync(store.startSync('orders'), 'failed');
  assert.equal(store.lastSyncStatus('orders'), 'failed');
  store.close();
});

test('lastSyncClean is false for an unfinished latest run, lastSyncFinishedAt ignores it', () => {
  const store = openStore(':memory:');
  assert.equal(store.lastSyncClean('orders'), false);
  store.finishSync(store.startSync('orders'), 'ok');
  assert.equal(store.lastSyncClean('orders'), true);
  const finished = store.lastSyncFinishedAt('orders');
  store.startSync('orders'); // crashed: never finished
  assert.equal(store.lastSyncClean('orders'), false);
  assert.equal(store.lastSyncFinishedAt('orders'), finished);
  assert.equal(store.lastSyncClean('promotions'), false);
  store.finishSync(store.startSync('orders'), 'failed');
  assert.equal(store.lastSyncClean('orders'), false);
  store.close();
});

test('writer waits about 5 s for a held lock before giving up', () => {
  withFile((path) => {
    const store = openStore(path);
    const holder = new DatabaseSync(path);
    holder.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    assert.throws(() => store.startSync('orders'), /locked|busy/i);
    assert.ok(Date.now() - started >= 4500);
    holder.exec('ROLLBACK');
    holder.close();
    store.close();
  });
});

test('upserts keep existing non-blank values against blank incoming ones', () => {
  const store = openStore(':memory:');
  const at = '2026-10-31T08:00:00Z';
  const full = { ...product('a', 'Masło'), brand: 'Łaciate', categoryPath: ['Nabiał'], unitLabel: 'kg', size: '200 g' };
  store.savePromotions(promo([full], [price('a', at, 100)]));
  const blank = { ...full, brand: '', categoryPath: [], unitLabel: null, size: null };
  store.savePromotions(promo([blank], [price('a', at, 100)]));
  const [row] = store.currentPromotions({ limit: 1 });
  assert.deepEqual([row.brand, row.unitLabel, row.size], ['Łaciate', 'kg', '200 g']);
  store.close();
  withFile((path) => {
    const s = openStore(path);
    s.savePromotions(promo([full], [price('a', at, 100)]));
    s.savePromotions(promo([{ ...blank, unitLabel: '' as string, size: '' as string }], [price('a', at, 100)]));
    s.close();
    const db = new DatabaseSync(path);
    const r = db.prepare('SELECT brand, category_path, unit_label, size FROM products').get() as Record<string, string>;
    db.close();
    assert.deepEqual({ ...r }, { brand: 'Łaciate', category_path: '["Nabiał"]', unit_label: 'kg', size: '200 g' });
  });
});

test('upserts take new non-blank values', () => {
  const store = openStore(':memory:');
  const at = '2026-10-31T08:00:00Z';
  store.savePromotions(promo([product('a', 'Masło')], [price('a', at, 100)]));
  store.savePromotions(promo([{ ...product('a', 'Masło'), brand: 'Nowa', size: '1 kg' }], [price('a', at, 100)]));
  const [row] = store.currentPromotions({ limit: 1 });
  assert.deepEqual([row.brand, row.size], ['Nowa', '1 kg']);
  store.close();
});

test('read-only store reads but refuses writes, and reports last sync time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'store-ro-'));
  try {
    const path = join(dir, 'h.db');
    const w = openStore(path);
    assert.equal(w.lastSyncFinishedAt('orders'), null);
    const id = w.startSync('orders');
    assert.equal(w.lastSyncFinishedAt('orders'), null);
    w.finishSync(id, 'ok');
    assert.match(w.lastSyncFinishedAt('orders')!, /^\d{4}-\d\d-\d\dT/);
    w.close();

    const r = openStore(path, { readOnly: true });
    assert.deepEqual(r.recentOrders(5), []);
    assert.ok(r.lastSyncFinishedAt('orders'));
    assert.throws(() => r.startSync('orders'), /readonly/i);
    r.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
