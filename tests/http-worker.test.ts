import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookieHeader, createHttpWorker, MAX_BATCH, Rejected, extractLinks, extractState, retrySeconds } from '../src/http-worker.ts';
import { APPLY_QUANTITY_PATH, CART_READ_PATH, Blocked, GET_COMPLETED_ORDERS_QUERY, LoginRequired, ORIGIN, RateLimited, saveCookies } from '../src/worker.ts';
import { ShapeError } from '../src/parse.ts';

const page = (state: unknown, extra = '') => `<html><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>${extra}</html>`;

function setup(respond: (url: string, init: any) => Response | Promise<Response>, login = async () => true) {
  const dir = mkdtempSync(join(tmpdir(), 'http-'));
  const sessionFile = join(dir, 'session.json');
  saveCookies(sessionFile, [{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
  const calls: { url: string; init: any; at: number }[] = [];
  const fetchFn = (async (url: string, init: any) => {
    calls.push({ url, init, at: Date.now() });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { worker: createHttpWorker({ sessionFile, login, fetchFn, gapMs: 0 }), calls, sessionFile, dir, fetchFn, cleanup: () => rmSync(dir, { recursive: true }) };
}

test('cookies are saved for the owner only and only name and value are kept', () => {
  const { sessionFile, cleanup } = setup(() => new Response(''));
  saveCookies(sessionFile, [{ name: 'a', value: '1', domain: 'x' } as any]);
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(sessionFile, 'utf8')), [{ name: 'a', value: '1' }]);
  assert.equal(cookieHeader(sessionFile), 'a=1');
  cleanup();
});

test('a damaged session file asks for a login and its content never reaches an error', async () => {
  const { worker, calls, sessionFile, cleanup } = setup(() => new Response('{}'));
  writeFileSync(sessionFile, 'secret-cookie-value');
  await assert.rejects(
    () => worker.getJson('/orders'),
    (e: Error) => e instanceof LoginRequired && !e.message.includes('secret'),
  );
  assert.equal(calls.length, 0);
  cleanup();
});

test('an unreadable session file is a real error, not a request to log in', async () => {
  const { worker, calls, sessionFile, cleanup } = setup(() => new Response('{}'));
  rmSync(sessionFile);
  mkdirSync(sessionFile); // reading a directory fails with EISDIR
  await assert.rejects(() => worker.getJson('/orders'), (e: Error) => !(e instanceof LoginRequired) && /EISDIR/.test(e.message));
  assert.equal(calls.length, 0);
  cleanup();
});

test('no saved session means a login is needed and nothing is sent', async () => {
  const { worker, calls, sessionFile, cleanup } = setup(() => new Response('{}'));
  rmSync(sessionFile);
  await assert.rejects(() => worker.getJson('/orders'), LoginRequired);
  assert.equal(calls.length, 0);
  cleanup();
});

test('getJson sends the cookie and version header and does not follow redirects', async () => {
  const { worker, calls, cleanup } = setup(() => new Response('{"ok":1}'));
  assert.deepEqual(await worker.getJson('/orders'), { ok: 1 });
  assert.equal(calls[0].url, 'https://zakupy.auchan.pl/orders');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.cookie, 'a=1; b=2');
  assert.equal(calls[0].init.headers['ecom-request-source-version'], '2.0.0');
  cleanup();
});

test('graphql refuses a query that is not the pinned document, before any request', async () => {
  const { worker, calls, cleanup } = setup(() => new Response('{}'));
  await assert.rejects(() => worker.graphql('GetCompletedOrders', 'mutation GetCompletedOrders { x }', {}), /pinned/);
  assert.equal(calls.length, 0);
  cleanup();
});

test('a non-JSON body gives a fixed ShapeError with no body text', async () => {
  const { worker, cleanup } = setup(() => new Response('<html>secret</html>'));
  await assert.rejects(() => worker.getJson('/orders'), (e: Error) => e instanceof ShapeError && e.message === 'response was not JSON');
  cleanup();
});

test('paths outside the allowlist are refused before any request', async () => {
  const { worker, calls, cleanup } = setup(() => new Response('{}'));
  await assert.rejects(() => worker.getJson('/checkout'), /not allowed/);
  await assert.rejects(() => worker.getJson('/graphql'), /not allowed/);
  await assert.rejects(() => worker.graphql('AddToCart', GET_COMPLETED_ORDERS_QUERY, {}), /not allowed/);
  assert.equal(calls.length, 0);
  cleanup();
});

for (const status of [403, 429]) {
  test(`HTTP ${status} stops with one request and no retry`, async () => {
    const { worker, calls, cleanup } = setup(() => new Response('secret', { status }));
    await assert.rejects(() => worker.getJson('/orders'), Blocked);
    assert.equal(calls.length, 1);
    cleanup();
  });
}

test('429 and 503 with Retry-After report how long to wait', async () => {
  for (const status of [429, 503]) {
    const { worker, calls, cleanup } = setup(() => new Response('', { status, headers: { 'retry-after': '120' } }));
    await assert.rejects(() => worker.getJson('/orders'), (e: any) => e instanceof RateLimited && e instanceof Blocked && e.retrySeconds === 120);
    assert.equal(calls.length, 1);
    cleanup();
  }
});

test('503 without Retry-After is a plain server error', async () => {
  const { worker, cleanup } = setup(() => new Response('', { status: 503 }));
  await assert.rejects(() => worker.getJson('/orders'), /unexpected HTTP 503/);
  cleanup();
});

test('retrySeconds reads seconds and dates and ignores nonsense', () => {
  assert.equal(retrySeconds('60'), 60);
  assert.equal(retrySeconds(new Date(1_090_000).toUTCString(), 1_000_000), 90);
  assert.equal(retrySeconds(new Date(0).toUTCString(), 1_000_000), 0);
  assert.equal(retrySeconds('soon'), undefined);
  assert.equal(retrySeconds(null), undefined);
});

test('401 and redirects mean a login is needed', async () => {
  for (const status of [401, 302]) {
    const { worker, cleanup } = setup(() => new Response(null, { status }));
    await assert.rejects(() => worker.getJson('/orders'), LoginRequired);
    cleanup();
  }
});

test('graphql takes the CSRF token from the page, once, and it never leaves the worker', async () => {
  const { worker, calls, cleanup } = setup((url) =>
    url.endsWith('/orders')
      ? new Response(page({ session: { isLoggedIn: true, csrf: { token: 'tok' } } }))
      : new Response('{"data":{}}'),
  );
  await worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, { first: 20 });
  await worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, { first: 20 });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.method, 'POST');
  assert.equal(calls[1].init.headers['x-csrf-token'], 'tok');
  assert.equal(JSON.parse(calls[1].init.body).operationName, 'GetCompletedOrders');
  const state: any = await worker.pageState('/orders');
  assert.equal(state.session.csrf, undefined);
  cleanup();
});

test('graphql without a CSRF token sends nothing to /graphql', async () => {
  const { worker, calls, cleanup } = setup(() => new Response(page({ session: { isLoggedIn: false } })));
  await assert.rejects(() => worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {}), LoginRequired);
  assert.equal(calls.length, 1);
  cleanup();
});

test('a customer error from graphql means a login is needed', async () => {
  const { worker, cleanup } = setup((url) =>
    url.endsWith('/orders')
      ? new Response(page({ session: { csrf: { token: 'tok' } } }))
      : new Response('{"errors":[{"extensions":{"code":"missing-customer-error"}}]}'),
  );
  await assert.rejects(() => worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {}), LoginRequired);
  cleanup();
});

test('an anonymous /orders page means a login is needed', async () => {
  const { worker, cleanup } = setup(() => new Response(page({ session: { isLoggedIn: false } })));
  await assert.rejects(() => worker.pageState('/orders'), LoginRequired);
  cleanup();
});

test('waitForLogin drops the old token and asks for a new login', async () => {
  let logins = 0;
  const { worker, calls, cleanup } = setup(
    (url) => (url.endsWith('/orders') ? new Response(page({ session: { csrf: { token: 'tok' } } })) : new Response('{"data":{}}')),
    async () => (logins++, true),
  );
  await worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {});
  assert.equal(await worker.waitForLogin(), true);
  await worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, {});
  assert.equal(logins, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/orders')).length, 2);
  cleanup();
});

test('requests run one at a time with the minimum gap, even when started together', async () => {
  const { sessionFile, fetchFn, calls, cleanup } = setup(() => new Response('{}'));
  const worker = createHttpWorker({ sessionFile, login: async () => true, fetchFn, gapMs: 40 });
  await Promise.all([worker.getJson('/orders'), worker.getJson('/orders'), worker.getJson('/orders')]);
  assert.ok(calls[1].at - calls[0].at >= 35);
  assert.ok(calls[2].at - calls[1].at >= 35);
  cleanup();
});

test('a failed request does not jam the queue', async () => {
  let n = 0;
  const { worker, cleanup } = setup(() => (n++ === 0 ? new Response('', { status: 500 }) : new Response('{"ok":1}')));
  await assert.rejects(() => worker.getJson('/orders'), /unexpected HTTP 500/);
  assert.deepEqual(await worker.getJson('/orders'), { ok: 1 });
  cleanup();
});

test('extractState reads the page state and fails with fixed text', () => {
  assert.deepEqual(extractState(page({ a: 1 })), { a: 1 });
  assert.throws(() => extractState('<html>secret</html>'), (e: Error) => e instanceof ShapeError && e.message === 'page has no state');
  assert.throws(() => extractState('<script>window.__INITIAL_STATE__={secret</script>'), (e: Error) => e.message === 'page state was not JSON');
});

test('extractLinks keeps same-origin links under the prefix, encoded as a browser would', () => {
  const html = '<a class="x" href="/promotions/zdrowa-żywność/3177?a=1&amp;b=2">x</a><a href="https://evil.example/promotions/x">y</a><a href="/orders">z</a>';
  assert.deepEqual(extractLinks(html, '/promotions/'), ['/promotions/zdrowa-%C5%BCywno%C5%9B%C4%87/3177?a=1&b=2']);
});

const P1 = '7866c30c-0b4e-402b-a90c-f292bca0ef6b';
const cartServer = (apply: () => Response = () => new Response('{}')) => (url: string) =>
  url.endsWith('/orders') ? new Response(page({ session: { csrf: { token: 't1' } } })) : url.includes(APPLY_QUANTITY_PATH) ? apply() : new Response('{}');

test('readCart sends a GET to the cart path with the version header and returns parsed JSON', async () => {
  const { worker, calls, cleanup } = setup(() => new Response('{"a":1}'));
  assert.deepEqual(await worker.readCart(), { a: 1 });
  assert.equal(calls[0].url, ORIGIN + CART_READ_PATH);
  assert.equal(calls[0].init.method, undefined);
  assert.equal(calls[0].init.headers['ecom-request-source-version'], '2.0.0');
  cleanup();
});

test('applyQuantities posts the body to apply-quantity with the CSRF token from page state', async () => {
  const { worker, calls, cleanup } = setup(cartServer());
  assert.deepEqual(await worker.applyQuantities([{ productId: P1, quantity: 2 }]), []);
  const post = calls[1];
  assert.equal(post.url, ORIGIN + APPLY_QUANTITY_PATH);
  assert.equal(post.init.method, 'POST');
  assert.equal(post.init.headers['x-csrf-token'], 't1');
  const body = JSON.parse(post.init.body);
  assert.match(body[0].meta.pageViewId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(body, [{ productId: P1, quantity: 2, meta: { itemListName: 'search', favorite: false, pageViewId: body[0].meta.pageViewId, pageType: 'search' } }]);
  cleanup();
});

test('applyQuantities asks for a login when the session expired since the last token, and posts nothing', async () => {
  let loggedIn = true;
  const { worker, calls, cleanup } = setup((url) =>
    url.endsWith('/orders') ? new Response(page({ session: loggedIn ? { csrf: { token: 't1' } } : { isLoggedIn: false } })) : new Response('{}'),
  );
  await worker.applyQuantities([{ productId: P1, quantity: 1 }]);
  loggedIn = false;
  await assert.rejects(() => worker.applyQuantities([{ productId: P1, quantity: 1 }]), LoginRequired);
  assert.equal(calls.filter((c) => c.init.method === 'POST').length, 1);
  cleanup();
});

test('applyQuantities fetches a fresh CSRF token on every call', async () => {
  const { worker, calls, cleanup } = setup(cartServer());
  await worker.applyQuantities([{ productId: P1, quantity: 1 }]);
  await worker.applyQuantities([{ productId: P1, quantity: 1 }]);
  assert.equal(calls.filter((c) => c.url.endsWith('/orders')).length, 2);
  cleanup();
});

test('applyQuantities refuses bad batches, ids and quantities, and sends nothing', async () => {
  const { worker, calls, cleanup } = setup(cartServer());
  const ok = { productId: P1, quantity: 1 };
  await assert.rejects(() => worker.applyQuantities([]));
  await assert.rejects(() => worker.applyQuantities(Array(MAX_BATCH + 1).fill(ok)));
  await assert.rejects(() => worker.applyQuantities([{ productId: 'p1', quantity: 1 }]));
  for (const quantity of [0, -1, 101, NaN, Infinity]) await assert.rejects(() => worker.applyQuantities([{ productId: P1, quantity }]));
  assert.equal(calls.length, 0);
  cleanup();
});

test('a 400 from apply-quantity throws Rejected with the status and no body text', async () => {
  const { worker, cleanup } = setup(cartServer(() => new Response('secret-body', { status: 400 })));
  await assert.rejects(
    () => worker.applyQuantities([{ productId: P1, quantity: 1 }]),
    (e: any) => e instanceof Rejected && e.status === 400 && !e.message.includes('secret'),
  );
  cleanup();
});

test('403 from apply-quantity throws Blocked; 401 throws LoginRequired', async () => {
  const a = setup(cartServer(() => new Response('', { status: 403 })));
  await assert.rejects(() => a.worker.applyQuantities([{ productId: P1, quantity: 1 }]), Blocked);
  a.cleanup();
  const b = setup(cartServer(() => new Response('', { status: 401 })));
  await assert.rejects(() => b.worker.applyQuantities([{ productId: P1, quantity: 1 }]), LoginRequired);
  b.cleanup();
});

test('applyQuantities returns limited items from the response', async () => {
  const body = readFileSync(new URL('./fixtures/apply-quantity-limited.json', import.meta.url), 'utf8');
  const { worker, cleanup } = setup(cartServer(() => new Response(body)));
  assert.deepEqual(await worker.applyQuantities([{ productId: P1, quantity: 1 }]), [
    { productId: P1, reason: 'OUT_OF_STOCK', requestedAmount: 1, addedAmount: 0 },
  ]);
  cleanup();
});

test('a malformed limitedItems is a ShapeError', async () => {
  for (const bad of ['{"limitedItems":"x"}', '{"limitedItems":[{}]}']) {
    const { worker, cleanup } = setup(cartServer(() => new Response(bad)));
    await assert.rejects(() => worker.applyQuantities([{ productId: P1, quantity: 1 }]), ShapeError);
    cleanup();
  }
});
