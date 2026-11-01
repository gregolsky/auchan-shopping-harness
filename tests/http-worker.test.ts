import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cookieHeader, createHttpWorker, extractLinks, extractState, retrySeconds, saveCookies } from '../src/http-worker.ts';
import { Blocked, GET_COMPLETED_ORDERS_QUERY, LoginRequired, RateLimited } from '../src/worker.ts';
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
