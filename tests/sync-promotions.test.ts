import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openStore } from '../src/store.ts';
import { ShapeError } from '../src/parse.ts';
import { discoverPromotionCategories, syncPromotions } from '../src/sync-promotions.ts';
import { Blocked } from '../src/worker.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/promotions-state.json', import.meta.url), 'utf8'));
const REGION = fixture.session.metadata.regionId;
const baseProducts = Object.values(fixture.data.products.productEntities) as any[];

// A state with n products; ids are "<tag>-<i>" unless shared ones are given.
function stateWith(ids: string[], regionId = REGION) {
  const entities: Record<string, any> = {};
  ids.forEach((id, i) => {
    const e = structuredClone(baseProducts[i % baseProducts.length]);
    e.productId = id;
    entities[id] = e;
  });
  return { session: { metadata: { regionId } }, data: { products: { productEntities: entities } } };
}

const LINKS = ['/promotions/a/1?sortBy=relevance', '/promotions/b/2?sortBy=relevance'];

function fake(states: Record<string, unknown>, links: string[] = LINKS) {
  const calls: string[] = [];
  const worker = {
    async pageState(path: string) {
      calls.push(`state ${path}`);
      const s = states[path];
      if (s instanceof Error) throw s;
      return s;
    },
    async pageLinks(path: string, prefix: string) {
      calls.push(`links ${path} ${prefix}`);
      return links;
    },
  };
  return { worker, calls };
}

function setup() {
  const store = openStore(':memory:');
  const sleeps: number[] = [];
  const opts = { paceMs: 1500, expectedRegionId: REGION, sleep: async (ms: number) => void sleeps.push(ms) };
  return { store, sleeps, opts };
}

test('merges category pages and removes duplicates by productId', async () => {
  const { store, sleeps, opts } = setup();
  const { worker, calls } = fake({
    '/promotions': stateWith(['p1']),
    '/promotions/a/1?sortBy=relevance': stateWith(['p1', 'p2']),
    '/promotions/b/2?sortBy=relevance': stateWith(['p2', 'p3']),
  });
  const r = await syncPromotions(worker, store, opts);
  assert.deepEqual(r, { pages: 3, products: 3, capped: [], skipped: [] });
  assert.equal(store.currentPromotions({ limit: 100 }).length, 3);
  assert.equal(store.lastSyncStatus('promotions'), 'ok');
  // pageState + pageLinks both navigate /promotions; every request after the first is paced.
  assert.equal(calls.length, 4);
  assert.deepEqual(sleeps, [1500, 1500, 1500]);
});

test('a page from another region is refused and nothing is saved', async () => {
  const { store, opts } = setup();
  const { worker } = fake({
    '/promotions': stateWith(['p1']),
    '/promotions/a/1?sortBy=relevance': stateWith(['p2'], 'other-region'),
    '/promotions/b/2?sortBy=relevance': stateWith(['p3']),
  });
  await assert.rejects(() => syncPromotions(worker, store, opts), /region/);
  assert.equal(store.currentPromotions({ limit: 100 }).length, 0);
  assert.equal(store.lastSyncStatus('promotions'), 'failed');
});

test('an empty expected region is an error before any request', async () => {
  const { store, opts } = setup();
  const { worker, calls } = fake({});
  await assert.rejects(() => syncPromotions(worker, store, { ...opts, expectedRegionId: '' }), /region/);
  assert.equal(calls.length, 0);
  assert.equal(store.lastSyncStatus('promotions'), null);
});

test('reports pages that return exactly 50 products as capped, including /promotions', async () => {
  const { store, opts } = setup();
  const fifty = Array.from({ length: 50 }, (_, i) => `f${i}`);
  const { worker } = fake({
    '/promotions': stateWith(fifty),
    '/promotions/a/1?sortBy=relevance': stateWith(['p1']),
    '/promotions/b/2?sortBy=relevance': stateWith(fifty.slice(0, 49)),
  });
  const r = await syncPromotions(worker, store, opts);
  assert.deepEqual(r.capped, ['/promotions']);
  assert.equal(r.products, 51);
});

test('a page over the cap also counts as capped', async () => {
  const { store, opts } = setup();
  const many = Array.from({ length: 51 }, (_, i) => `f${i}`);
  const { worker } = fake({ '/promotions': stateWith(many), '/promotions/a/1': stateWith(['p1']) }, ['/promotions/a/1']);
  const r = await syncPromotions(worker, store, opts);
  assert.deepEqual(r.capped, ['/promotions']);
});

test('more than 40 distinct categories fails before visiting any', async () => {
  const { store, opts } = setup();
  const links = Array.from({ length: 41 }, (_, i) => `/promotions/c/${i}`);
  const { worker, calls } = fake({ '/promotions': stateWith(['p1']) }, links);
  await assert.rejects(() => syncPromotions(worker, store, opts), (e) => e instanceof ShapeError && /40/.test(e.message));
  assert.equal(calls.some((c) => c.startsWith('state /promotions/c/')), false);
  assert.equal(store.currentPromotions({ limit: 10 }).length, 0);
  assert.equal(store.lastSyncStatus('promotions'), 'failed');
});

test('exactly 40 categories are visited, and sort variants of one count once', async () => {
  const { store, opts } = setup();
  const links = Array.from({ length: 40 }, (_, i) => `/promotions/c/${i}`);
  links.push('/promotions/c/0?sortBy=price', '/promotions/c/1?sortBy=relevance');
  const states: Record<string, unknown> = { '/promotions': stateWith(['p1']) };
  for (let i = 0; i < 40; i++) states[`/promotions/c/${i}`] = stateWith(['p1']);
  const { worker } = fake(states, links);
  assert.equal((await syncPromotions(worker, store, opts)).pages, 41);
});

test('Blocked stops the sync with no retry and keeps the previous snapshot', async () => {
  const { store, opts } = setup();
  const ok = fake({
    '/promotions': stateWith(['old']),
    '/promotions/a/1?sortBy=relevance': stateWith(['old']),
    '/promotions/b/2?sortBy=relevance': stateWith(['old']),
  });
  await syncPromotions(ok.worker, store, opts);
  const { worker, calls } = fake({
    '/promotions': stateWith(['new']),
    '/promotions/a/1?sortBy=relevance': new Blocked('HTTP 429'),
  });
  await assert.rejects(() => syncPromotions(worker, store, opts), Blocked);
  assert.equal(calls.filter((c) => c === 'state /promotions/a/1?sortBy=relevance').length, 1);
  assert.equal(calls.some((c) => c.includes('/promotions/b/2')), false);
  assert.deepEqual(store.currentPromotions({ limit: 10 }).map((p) => p.productId), ['old']);
  assert.equal(store.lastSyncStatus('promotions'), 'failed');
});

test('a changed page shape stops the sync and saves nothing', async () => {
  const { store, opts } = setup();
  const { worker } = fake({ '/promotions': stateWith(['p1']), '/promotions/a/1?sortBy=relevance': { session: {} } });
  await assert.rejects(() => syncPromotions(worker, store, opts), ShapeError);
  assert.equal(store.currentPromotions({ limit: 100 }).length, 0);
});

test('discovered paths that fail the allowlist are skipped and reported', async () => {
  const { store, opts } = setup();
  const { worker } = fake(
    { '/promotions': stateWith(['p1']), '/promotions/a/1': stateWith(['p2']) },
    ['/promotions/a/1?source=nav', '/promotions/%2e%2e%2fx/3'],
  );
  const r = await syncPromotions(worker, store, opts);
  assert.equal(r.pages, 2);
  assert.deepEqual(r.skipped, ['/promotions/%2e%2e%2fx/3']);
});

test('discoverPromotionCategories dedupes by pathname and keeps the first query', () => {
  assert.deepEqual(
    discoverPromotionCategories(['/promotions/a/1?sortBy=relevance', '/promotions/a/1?sortBy=price', '/promotions/a/1']),
    ['/promotions/a/1?sortBy=relevance'],
  );
});

test('discoverPromotionCategories keeps /promotions/<slug>/<id>, dedupes and strips source=', () => {
  const found = discoverPromotionCategories([
    '/promotions/artykuły-spożywcze/2091?sortBy=relevance',
    '/promotions/artykuły-spożywcze/2091?sortBy=relevance&source=menu',
    '/promotions/artykuły-spożywcze/2091?source=menu&sortBy=relevance',
    '/promotions/mieso/5?source=banner',
    '/promotions/mieso/5',
    '/promotions',
    '/promotions/abc',
    '/promotions/a/b/7',
    '/orders',
  ]);
  assert.deepEqual(found, ['/promotions/artykuły-spożywcze/2091?sortBy=relevance', '/promotions/mieso/5']);
});

async function keepsOldSnapshot(links: string[], states: Record<string, unknown>, message: RegExp) {
  const { store, opts } = setup();
  const ok = fake({
    '/promotions': stateWith(['old']),
    '/promotions/a/1?sortBy=relevance': stateWith(['old']),
    '/promotions/b/2?sortBy=relevance': stateWith(['old']),
  });
  await syncPromotions(ok.worker, store, opts);
  const { worker } = fake(states, links);
  await assert.rejects(() => syncPromotions(worker, store, opts), (e) => e instanceof ShapeError && message.test(e.message));
  assert.deepEqual(store.currentPromotions({ limit: 10 }).map((p) => p.productId), ['old']);
  assert.equal(store.lastSyncStatus('promotions'), 'failed');
}

test('no discovered categories fails the sync and keeps the old snapshot', async () => {
  await keepsOldSnapshot([], { '/promotions': stateWith(['new']) }, /category/);
});

test('every discovered category being skipped fails the sync and keeps the old snapshot', async () => {
  await keepsOldSnapshot(['/promotions/%2e%2e%2fx/3'], { '/promotions': stateWith(['new']) }, /category/);
});

test('zero products fails the sync and keeps the old snapshot', async () => {
  await keepsOldSnapshot(
    ['/promotions/a/1'],
    { '/promotions': stateWith([]), '/promotions/a/1': stateWith([]) },
    /no products/,
  );
});
