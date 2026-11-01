import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ShapeError } from '../src/parse.ts';
import {
  assertAllowed,
  createWorker,
  GET_COMPLETED_ORDERS_QUERY,
  type PageLike,
  assertGraphqlOperation,
  classifyResponse,
  mapLaunchError,
  whenClosed,
  Blocked,
  LoginRequired,
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

test('classifyResponse maps 403 and 429 to Blocked', () => {
  assert.throws(() => classifyResponse(403, 'https://zakupy.auchan.pl/graphql'), Blocked);
  assert.throws(() => classifyResponse(429, 'https://zakupy.auchan.pl/graphql'), Blocked);
  classifyResponse(200, 'https://zakupy.auchan.pl/orders');
});

test('classifyResponse maps a login redirect to LoginRequired', () => {
  assert.throws(() => classifyResponse(200, 'https://zakupy.auchan.pl/login?next=%2Forders'), LoginRequired);
  assert.throws(() => classifyResponse(200, 'https://login.auchan.pl/authorize'), LoginRequired);
  assert.throws(() => classifyResponse(401, 'https://zakupy.auchan.pl/orders'), LoginRequired);
});

test('graphql rejects operations other than GetCompletedOrders', () => {
  assertGraphqlOperation('GetCompletedOrders');
  assert.throws(() => assertGraphqlOperation('AddToCart'));
  assert.throws(() => assertGraphqlOperation(''));
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

// ---- route-level tests with a fake page (no browser) ----

interface FakeOpts {
  url?: string;
  gotoStatus?: number | null;
  gotoFinalUrl?: string;
  state?: any;
  fetchRes?: any;
  fetchError?: unknown;
  hrefs?: string[];
}
function fakePage(o: FakeOpts = {}) {
  let cur = o.url ?? 'https://zakupy.auchan.pl/orders';
  const calls = { goto: [] as string[], fetch: [] as { url: string; init: any }[] };
  const page: PageLike = {
    url: () => cur,
    async goto(u) {
      calls.goto.push(u);
      cur = o.gotoFinalUrl ?? u;
      return o.gotoStatus === null ? null : { status: () => o.gotoStatus ?? 200 };
    },
    async evaluate(fn: any, arg: any) {
      const g = globalThis as any;
      const oldFetch = g.fetch;
      g.window = { __INITIAL_STATE__: o.state, location: { origin: 'https://zakupy.auchan.pl', href: cur } };
      g.document = { querySelectorAll: () => (o.hrefs ?? []).map((h) => ({ href: new URL(h, cur).toString() })) };
      g.fetch = async (url: string, init: any) => {
        calls.fetch.push({ url, init });
        if (o.fetchError) throw o.fetchError;
        const r = o.fetchRes ?? { status: 200, type: 'basic', url: 'https://zakupy.auchan.pl' + url, body: '{"ok":1}' };
        return { ...r, redirected: false, text: async () => r.body };
      };
      try {
        return await fn(arg);
      } finally {
        g.fetch = oldFetch;
        delete g.window;
        delete g.document;
      }
    },
  };
  return { page, calls };
}
const goodState = { session: { csrf: { token: 'SECRET' }, isLoggedIn: true } };

test('graphql refuses a query that is not the pinned document', async () => {
  const { page, calls } = fakePage({ state: goodState });
  const w = createWorker(page);
  await assert.rejects(() => w.graphql('GetCompletedOrders', 'mutation GetCompletedOrders { x }', {}));
  assert.equal(calls.fetch.length, 0);
  await w.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, { first: 1 });
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0].init.method, 'POST');
  assert.deepEqual(Object.keys(calls.fetch[0].init.headers).sort(), [
    'content-type',
    'ecom-request-source',
    'ecom-request-source-version',
    'x-csrf-token',
  ]);
  assert.equal(calls.fetch[0].init.headers['ecom-request-source-version'], '2.0.0');
});

test('getJson refuses /graphql', async () => {
  const { page, calls } = fakePage({ state: goodState });
  const w = createWorker(page);
  await assert.rejects(() => w.getJson('/graphql?operationName=AddToCart&query=mutation%7Bx%7D'));
  assert.equal(calls.fetch.length, 0);
});

test('getJson sends the normalised URL with only the version header and no redirect following', async () => {
  const { page, calls } = fakePage();
  const w = createWorker(page);
  assert.deepEqual(await w.getJson('/api/order/v6/orders/5/decorated'), { ok: 1 });
  assert.equal(calls.fetch[0].url, '/api/order/v6/orders/5/decorated');
  assert.deepEqual(calls.fetch[0].init.headers, { 'ecom-request-source-version': '2.0.0' });
  assert.equal(calls.fetch[0].init.redirect, 'manual');
});

test('landing navigation is classified before any fetch', async () => {
  for (const [status, finalUrl, err] of [
    [403, undefined, Blocked],
    [429, undefined, Blocked],
    [200, 'https://zakupy.auchan.pl/login', LoginRequired],
    [200, 'https://login.auchan.pl/x', LoginRequired],
  ] as const) {
    const { page, calls } = fakePage({ url: 'about:blank', gotoStatus: status, gotoFinalUrl: finalUrl });
    await assert.rejects(() => createWorker(page).getJson('/orders'), err);
    assert.equal(calls.fetch.length, 0);
  }
  // landing goes to an allowed path, not '/'
  const { page, calls } = fakePage({ url: 'about:blank' });
  await createWorker(page).getJson('/orders');
  assert.equal(new URL(calls.goto[0]).pathname, '/orders');
});

test('in-page redirects are not followed and return no data', async () => {
  const { page } = fakePage({ fetchRes: { status: 0, type: 'opaqueredirect', url: '', body: '' } });
  await assert.rejects(() => createWorker(page).getJson('/orders'), LoginRequired);
});

test('missing CSRF token is LoginRequired and nothing is sent', async () => {
  const { page, calls } = fakePage({ state: { session: {} } });
  await assert.rejects(() => createWorker(page).graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {}), LoginRequired);
  assert.equal(calls.fetch.length, 0);
});

test('graphql errors array raises instead of returning success', async () => {
  const mk = (code: string) =>
    fakePage({
      state: goodState,
      fetchRes: { status: 200, type: 'basic', url: 'https://zakupy.auchan.pl/graphql', body: JSON.stringify({ errors: [{ extensions: { code } }] }) },
    }).page;
  await assert.rejects(() => createWorker(mk('missing-customer-error')).graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {}), LoginRequired);
  await assert.rejects(() => createWorker(mk('other')).graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {}), ShapeError);
});

test('pageState: redirect to a disallowed path, non-2xx and null response return no state', async () => {
  await assert.rejects(() => createWorker(fakePage({ gotoFinalUrl: 'https://zakupy.auchan.pl/checkout', state: goodState }).page).pageState('/orders'));
  await assert.rejects(() => createWorker(fakePage({ gotoStatus: 404, state: goodState }).page).pageState('/orders'));
  await assert.rejects(() => createWorker(fakePage({ gotoStatus: 503, state: goodState }).page).pageState('/orders'));
  await assert.rejects(() => createWorker(fakePage({ gotoStatus: null, state: goodState }).page).pageState('/orders'));
  await assert.rejects(() => createWorker(fakePage({ gotoFinalUrl: 'https://zakupy.auchan.pl/login', state: goodState }).page).pageState('/orders'), LoginRequired);
});

test('pageState strips the CSRF token and flags an anonymous /orders page', async () => {
  const st = await createWorker(fakePage({ state: { session: { csrf: { token: 'SECRET' }, isLoggedIn: true, metadata: { regionId: 7 } } } }).page).pageState('/orders') as any;
  assert.equal(st.session.csrf, undefined);
  assert.ok(!JSON.stringify(st).includes('SECRET'));
  assert.equal(st.session.metadata.regionId, 7);
  await assert.rejects(
    () => createWorker(fakePage({ state: { session: { isLoggedIn: false } } }).page).pageState('/orders'),
    LoginRequired,
  );
});

test('pageLinks returns only same-origin links under the prefix', async () => {
  const { page, calls } = fakePage({
    hrefs: [
      '/promotions/a/1?sortBy=relevance',
      'https://zakupy.auchan.pl/promotions/b/2',
      'https://evil.example/promotions/c/3',
      '//evil.example/promotions/d/4',
      '/orders',
      '/promotions',
    ],
  });
  const links = await createWorker(page).pageLinks('/promotions', '/promotions/');
  assert.deepEqual(links, ['/promotions/a/1?sortBy=relevance', '/promotions/b/2']);
  assert.equal(calls.fetch.length, 0);
});

test('pageLinks navigates through the checked path and classifies responses', async () => {
  await assert.rejects(() => createWorker(fakePage().page).pageLinks('/checkout', '/promotions/'));
  await assert.rejects(() => createWorker(fakePage().page).pageLinks('/promotions', 'https://x'));
  await assert.rejects(
    () => createWorker(fakePage({ gotoFinalUrl: 'https://zakupy.auchan.pl/login' }).page).pageLinks('/promotions', '/promotions/'),
    LoginRequired,
  );
  for (const status of [403, 429]) {
    await assert.rejects(() => createWorker(fakePage({ gotoStatus: status }).page).pageLinks('/promotions', '/promotions/'), Blocked);
  }
  await assert.rejects(() => createWorker(fakePage({ gotoStatus: 404 }).page).pageLinks('/promotions', '/promotions/'));
});

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

test('waitForLogin is true once the open page reports a login, and never navigates', async () => {
  const state: any = { session: { isLoggedIn: false } };
  const { page, calls } = fakePage({ state });
  setTimeout(() => (state.session.isLoggedIn = true), 5);
  assert.equal(await createWorker(page, async () => {}, never, 1).waitForLogin(), true);
  assert.deepEqual(calls.goto, []);
  assert.deepEqual(calls.fetch, []);
});

test('waitForLogin is false when the window closes first', async () => {
  const { page } = fakePage({ state: { session: { isLoggedIn: false } } });
  assert.equal(await createWorker(page, async () => {}, async () => {}, 1).waitForLogin(), false);
});

test('waitForLogin does not look inside other sites and survives a look that fails', async () => {
  const { page } = fakePage({ url: 'https://konto.auchan.pl/login' });
  let looks = 0;
  const real = page.evaluate.bind(page);
  page.evaluate = (async (fn: any, arg: any) => {
    looks++;
    if (looks === 1) throw new Error('Execution context was destroyed');
    return real(fn, arg);
  }) as any;
  const w = createWorker(page, async () => {}, async () => {}, 1);
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
  assert.equal(await createWorker(page, async () => {}, never, 1).waitForLogin(), true);
  assert.equal(looks, 2);
});

test('a non-JSON body gives a fixed ShapeError with no body text', async () => {
  const body = '<html>secret-page</html>';
  const { page } = fakePage({ fetchRes: { status: 200, type: 'basic', url: 'https://zakupy.auchan.pl/orders', body } });
  await assert.rejects(
    () => createWorker(page).getJson('/orders'),
    (e: Error) => e instanceof ShapeError && e.message === 'response was not JSON',
  );
});

test('in-page requests carry a timeout signal', async () => {
  const { page, calls } = fakePage({ state: goodState });
  const w = createWorker(page);
  await w.getJson('/orders');
  await w.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {});
  for (const c of calls.fetch) assert.ok(c.init.signal instanceof AbortSignal);
});

test('a timed out request reports a timeout, other failures do not', async () => {
  const timedOut = fakePage({ fetchError: new DOMException('signal timed out', 'TimeoutError') }).page;
  await assert.rejects(() => createWorker(timedOut).getJson('/orders'), /timed out after 30 s/);
  const failed = fakePage({ fetchError: new TypeError('Failed to fetch') }).page;
  await assert.rejects(() => createWorker(failed).getJson('/orders'), /request failed in page/);
});
