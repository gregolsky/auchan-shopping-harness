import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.ts';
import { openStore } from '../src/store.ts';
import { parseDecoratedOrder } from '../src/parse.ts';
import type { Product, PriceObservation } from '../src/types.ts';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

async function withClient<T>(dbPath: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const server = createServer(dbPath);
  const client = new Client({ name: 'test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
  return r.content.map((p) => p.text).join('\n');
}

function withDb<T>(seed: ((path: string) => void) | null, fn: (path: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-test-'));
  const path = join(dir, 'h.db');
  if (seed) seed(path);
  return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const promoProduct: Product = {
  productId: 'p-promo', retailerProductId: 'r-promo', name: 'Masło extra', brand: 'Mlekovita',
  categoryPath: ['Nabiał'], unitLabel: 'kg', size: '200 g', inCatalogue: true,
};
const promoPrice: PriceObservation = {
  productId: 'p-promo', seenAt: '2026-10-30T10:00:00.000Z', regionId: 'r1', source: 'promotion',
  originalGrosze: 899, currentGrosze: 599, unitCurrentGrosze: 2995, offerText: '-33%', requiredQuantity: null,
};

function seedOrders(path: string) {
  const s = openStore(path);
  const id = s.startSync('orders');
  s.saveOrder(parseDecoratedOrder(fx('order-decorated.json')));
  s.finishSync(id, 'ok');
  s.close();
}

test('server registers exactly the three read tools', async () => {
  await withDb(null, (path) =>
    withClient(path, async (c) => {
      const names = (await c.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['current_promotions', 'product_history', 'recent_orders']);
    }),
  );
});

test('no MCP tool imports the worker, even transitively', () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) visit(join(dirname(file), m[1]));
  };
  visit(join(SRC, 'mcp.ts'));
  const names = [...seen].map((f) => f.slice(SRC.length + 1));
  assert.ok(names.includes('store.ts'));
  for (const n of names) assert.doesNotMatch(n, /worker|cli|sync-/);
  for (const f of seen) assert.doesNotMatch(readFileSync(f, 'utf8'), /playwright/);
});

test('recent_orders returns rows from a seeded store with data age', async () => {
  await withDb(seedOrders, (path) =>
    withClient(path, async (c) => {
      const out = JSON.parse(await call(c, 'recent_orders', { limit: 5 }));
      assert.equal(out.orders.length, 1);
      assert.ok(out.orders[0].lineCount > 0);
      assert.match(out.lastSyncAt, /^\d{4}-\d\d-\d\dT/);
      assert.equal(typeof out.ageHours, 'number');
      assert.doesNotMatch(JSON.stringify(out), /address|adres/i);
    }),
  );
});

test('product_history finds a product ordered before', async () => {
  await withDb(seedOrders, (path) =>
    withClient(path, async (c) => {
      const order = parseDecoratedOrder(fx('order-decorated.json'));
      const name = order.products[0].name;
      const out = JSON.parse(await call(c, 'product_history', { query: name.slice(0, 4) }));
      assert.ok(out.products.some((p: { name: string; timesOrdered: number }) => p.name === name && p.timesOrdered === 1));
      assert.ok('size' in out.products[0]);
    }),
  );
});

test('current_promotions filters by bought_before and reports data age', async () => {
  const seed = (path: string) => {
    seedOrders(path);
    const s = openStore(path);
    const id = s.startSync('promotions');
    s.savePromotions({ regionId: 'r1', products: [promoProduct], prices: [promoPrice] });
    s.finishSync(id, 'ok');
    s.close();
  };
  await withDb(seed, (path) =>
    withClient(path, async (c) => {
      const all = JSON.parse(await call(c, 'current_promotions', { bought_before: false, limit: 10 }));
      assert.equal(all.promotions.length, 1);
      assert.equal(all.promotions[0].name, 'Masło extra');
      assert.equal(all.promotions[0].size, '200 g');
      assert.match(all.lastSyncAt, /^\d{4}-/);
      const bought = JSON.parse(await call(c, 'current_promotions', { bought_before: true, limit: 10 }));
      assert.equal(bought.promotions.length, 0);
    }),
  );
});

test('reports run-sync-first when the database is missing or has no sync', async () => {
  await withDb(null, (path) =>
    withClient(path, async (c) => {
      for (const [name, args] of [
        ['recent_orders', { limit: 3 }],
        ['product_history', { query: 'x' }],
        ['current_promotions', { bought_before: false, limit: 3 }],
      ] as const) {
        assert.match(await call(c, name, args), /run npm run sync first/);
      }
    }),
  );
  await withDb(
    (p) => openStore(p).close(),
    (path) =>
      withClient(path, async (c) => {
        assert.match(await call(c, 'recent_orders', { limit: 3 }), /run npm run sync first/);
        assert.match(await call(c, 'current_promotions', { bought_before: false, limit: 3 }), /run npm run sync first/);
      }),
  );
});

test('CLI failure messages are fixed and carry no response content', async () => {
  const { describeFailure } = await import('../src/cli.ts');
  const { LoginRequired, Blocked, ProfileBusy } = await import('../src/worker.ts');
  const { ShapeError } = await import('../src/parse.ts');
  assert.match(describeFailure(new LoginRequired('secret-cookie')), /log in and rerun/);
  assert.doesNotMatch(describeFailure(new LoginRequired('secret-cookie')), /secret/);
  assert.match(describeFailure(new Blocked('HTTP 403 body-with-token')), /^Auchan refused the request\. Do not rerun; the request format may need review\.$/);
  assert.doesNotMatch(describeFailure(new Blocked('HTTP 403 body-with-token')), /token/);
  const { RateLimited } = await import('../src/worker.ts');
  assert.match(describeFailure(new RateLimited(429, 90)), /run it again in 2 min/);
  assert.match(describeFailure(new RateLimited(429)), /run it again later/);
  assert.match(describeFailure(new ProfileBusy('/path/x')), /close the other browser first/);
  assert.match(describeFailure(new ShapeError('expected object at order.x')), /expected object at order\.x/);
});

test('a corrupt database is an error, not the run-sync hint', async () => {
  await withDb(
    (p) => writeFileSync(p, 'this is not a sqlite database, '.repeat(200)),
    (path) =>
      withClient(path, async (c) => {
        const r = (await c.callTool({ name: 'recent_orders', arguments: { limit: 3 } })) as {
          isError?: boolean;
          content: { text: string }[];
        };
        assert.equal(r.isError, true);
        assert.doesNotMatch(r.content[0].text, /run npm run sync first/);
        assert.match(r.content[0].text, /Database error/);
      }),
  );
});
