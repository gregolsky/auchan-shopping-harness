import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  assertAllowed,
  createLoginWatcher,
  LOGIN_TIMEOUT_MS,
  type PageLike,
  assertGraphqlOperation,
  GET_COMPLETED_ORDERS_QUERY,
  mapLaunchError,
  whenClosed,
  keepSessionOnRestart,
  ProfileBusy,
} from '../src/worker.ts';

test('allows only the stage 1 paths', () => {
  assertAllowed('/orders');
  assertAllowed('/promotions');
  assertAllowed('/api/order/v6/orders/123/decorated');
  assertAllowed('/graphql');
  assert.throws(() => assertAllowed('/checkout'));
  assert.throws(() => assertAllowed('/api/cart/v1/carts/active/apply-quantity'));
  assert.throws(() => assertAllowed('/orders/../checkout'));
});

test('allows promotion category pages and rejects escapes', () => {
  assertAllowed('/promotions/mi%C4%99so/12345');
  assertAllowed('/promotions/mięso/12345?page=2');
  assert.throws(() => assertAllowed('/promotions/../checkout'));
  assert.throws(() => assertAllowed('/promotions/%2e%2e/checkout'));
  assert.throws(() => assertAllowed('/promotions/mieso/abc'));
  assert.throws(() => assertAllowed('/checkout/x'));
  assert.throws(() => assertAllowed('//evil.com/orders'));
  assert.throws(() => assertAllowed('https://evil.com/orders'));
  assert.throws(() => assertAllowed('https://zakupy.auchan.pl/orders'));
  assert.throws(() => assertAllowed('/\\evil.com/orders'));
});

test('graphql rejects operations other than GetCompletedOrders', () => {
  assertGraphqlOperation('GetCompletedOrders');
  assert.throws(() => assertGraphqlOperation('AddToCart'));
  assert.throws(() => assertGraphqlOperation(''));
  assertGraphqlOperation('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY);
  assert.throws(() => assertGraphqlOperation('GetCompletedOrders', 'mutation GetCompletedOrders { x }'), /pinned/);
});

test('profile lock error becomes ProfileBusy with a clear message', () => {
  const e = mapLaunchError(new Error('Failed to create a ProcessSingleton for your profile directory'));
  assert.ok(e instanceof ProfileBusy);
  assert.match(e.message, /close the other browser first/);
  const other = new Error('boom');
  assert.equal(mapLaunchError(other), other);
});

test('encoded separators in promotion slugs are rejected, real slugs accepted', () => {
  for (const bad of [
    '/promotions/..%2F..%2Fcheckout/1',
    '/promotions/%2e%2e%2fcheckout/1',
    '/promotions/..%5Ccheckout/1',
    '/promotions/%252e%252e/1',
    '/promotions/a%00b/1',
    '/promotions/%E0%A4%A/1',
  ]) {
    assert.throws(() => assertAllowed(bad), Error, bad);
  }
  assertAllowed('/promotions/mi%C4%99so/1');
  assertAllowed('/promotions/artyku%C5%82y-spo%C5%BCywcze/22');
  assert.throws(() => assertAllowed('/orders\n'));
});

// ---- login watcher tests with a fake page (no browser) ----

function fakePage(o: { url?: string; state?: any } = {}) {
  const cur = o.url ?? 'https://zakupy.auchan.pl/orders';
  const calls = { evaluate: 0 };
  const page: PageLike & { evaluate: any } = {
    url: () => cur,
    async evaluate(fn: any, arg: any) {
      calls.evaluate++;
      const g = globalThis as any;
      g.window = { __INITIAL_STATE__: o.state };
      try {
        return await fn(arg);
      } finally {
        delete g.window;
      }
    },
  };
  return { page, calls };
}

test('whenClosed resolves on the close event, even if it fired before anyone waited', async () => {
  const context = new EventEmitter();
  const closed = whenClosed(context);
  let done = false;
  void closed.then(() => (done = true));
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  context.emit('close');
  await closed;
  await closed; // a second wait after the event still resolves
});

test('keepSessionOnRestart turns on session restore, keeps other settings, skips a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-'));
  const file = join(dir, 'Preferences');
  keepSessionOnRestart(file);
  assert.equal(existsSync(file), false);
  writeFileSync(file, JSON.stringify({ a: 1, session: { b: 2 } }));
  keepSessionOnRestart(file);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1, session: { b: 2, restore_on_startup: 1 } });
  rmSync(dir, { recursive: true });
});

const never = () => new Promise<void>(() => {});

test('createLoginWatcher.waitForLogin is true once the open page reports a login', async () => {
  const state: any = { session: { isLoggedIn: false } };
  const { page } = fakePage({ state });
  setTimeout(() => (state.session.isLoggedIn = true), 5);
  assert.equal(await createLoginWatcher(page, async () => {}, never, 1).waitForLogin(), true);
});

test('createLoginWatcher.waitForLogin gives up after its deadline while the window stays open', async () => {
  const { page } = fakePage({ state: { session: { isLoggedIn: false } } });
  const started = Date.now();
  assert.equal(await createLoginWatcher(page, async () => {}, never, 1, 30).waitForLogin(), false);
  assert.ok(Date.now() - started < 2000);
  assert.equal(LOGIN_TIMEOUT_MS, 3_600_000);
});

test('createLoginWatcher.waitForLogin is false when the window closes first', async () => {
  const { page } = fakePage({ state: { session: { isLoggedIn: false } } });
  assert.equal(await createLoginWatcher(page, async () => {}, async () => {}, 1).waitForLogin(), false);
});

test('createLoginWatcher.waitForLogin does not look inside other sites and survives a look that fails', async () => {
  const { page } = fakePage({ url: 'https://konto.auchan.pl/login' });
  let looks = 0;
  const real = page.evaluate.bind(page);
  page.evaluate = (async (fn: any, arg: any) => {
    looks++;
    if (looks === 1) throw new Error('Execution context was destroyed');
    return real(fn, arg);
  }) as any;
  const w = createLoginWatcher(page, async () => {}, async () => {}, 1);
  assert.equal(await w.waitForLogin(), false);
  assert.equal(looks, 0);

  let cur = 'https://konto.auchan.pl/login';
  page.url = () => cur;
  setTimeout(() => (cur = 'https://zakupy.auchan.pl/'), 2);
  const state = { session: { isLoggedIn: true } };
  (page as any).evaluate = (async () => {
    looks++;
    if (looks === 1) throw new Error('Execution context was destroyed');
    return state.session.isLoggedIn;
  }) as any;
  assert.equal(await createLoginWatcher(page, async () => {}, never, 1).waitForLogin(), true);
  assert.equal(looks, 2);
});

test('the search page is not on the HTTP allowlist: it happens only in the visible browser', () => {
  for (const p of ['/search', '/search?q=mleko', '/search?q=%C5%BCurek', '/search/', '/api/search', '/api/catalog/v1/search?q=mleko']) {
    assert.throws(() => assertAllowed(p), p);
  }
});

test('no checkout or order path is allowed', () => {
  assertAllowed('/api/cart/v1/carts/active');
  for (const p of ['/checkout', '/checkout/summary', '/api/checkout/v1/orders', '/api/order/v6/orders', '/api/cart/v1/carts/active/apply-quantity', '/api/cart/v1/carts/active/items', '/api/cart/v1/carts/active/checkout-start']) {
    assert.throws(() => assertAllowed(p), p);
  }
});
