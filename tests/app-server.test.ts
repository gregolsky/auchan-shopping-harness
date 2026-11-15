import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAppServer, createBroadcaster, createStop } from '../src/app/server.ts';

const TOKEN = 'a'.repeat(32);
type Call = [string, unknown[]];

function fakeService(calls: Call[], fail = false) {
  const rec = (name: string, ret: unknown) => (...args: unknown[]) => {
    calls.push([name, args]);
    if (fail) throw new Error('secret stack detail');
    return ret;
  };
  return {
    state: rec('state', { trip: { step: 'dane' }, busy: null }),
    note: async (...a: unknown[]) => rec('note', { step: 'szkic' })(...a),
    ask: async (...a: unknown[]) => rec('ask', { step: 'szkic' })(...a),
    apply: rec('apply', { step: 'x' }),
    reject: rec('reject', { step: 'y' }),
    answer: rec('answer', { step: 'z' }),
    line: rec('line', { step: 'l' }),
    approve: async (...a: unknown[]) => rec('approve', { started: true })(...a),
    sync: async (...a: unknown[]) => rec('sync', { started: true })(...a),
    rules: rec('rules', [{ term: 'mleko' }]),
    blockedProducts: rec('blockedProducts', [{ productId: 'p1', name: 'Mąka' }]),
    searchProducts: rec('searchProducts', [{ productId: 'p2', name: 'Chleb' }]),
    blockProduct: rec('blockProduct', true),
    unblockProduct: rec('unblockProduct', true),
    deleteRule: rec('deleteRule', undefined),
    clearBrand: rec('clearBrand', undefined),
    reset: rec('reset', { step: 'dane' }),
  } as never;
}

async function start(fail = false) {
  const publicDir = mkdtempSync(join(tmpdir(), 'pub-'));
  writeFileSync(join(publicDir, 'index.html'), '<html>hi</html>');
  writeFileSync(join(publicDir, 'app.js'), 'x');
  writeFileSync(join(publicDir, 'app.css'), 'y');
  writeFileSync(join(publicDir, 'icon.svg'), '<svg/>');
  writeFileSync(join(publicDir, 'shopping.svg'), '<svg/>');
  writeFileSync(join(publicDir, 'secret.txt'), 'nope');
  const calls: Call[] = [];
  const broadcaster = createBroadcaster();
  const server = createAppServer({ service: fakeService(calls, fail), token: TOKEN, publicDir, broadcaster });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return { base, port, publicDir, calls, broadcaster, close: () => { server.closeAllConnections(); server.close(); } };
}

const api = (base: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
  fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-app-token': TOKEN, ...(body === undefined ? {} : { 'content-type': 'application/json', origin: base }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test('requests without the token get 403 and no body detail', async () => {
  const s = await start();
  try {
    for (const p of ['/', '/api/state', '/app.js', '/api/events', '/api/events?t=wrong']) {
      const r = await fetch(s.base + p);
      assert.equal(r.status, 403, p);
      assert.deepEqual(await r.json(), { error: 'Brak dostępu' });
    }
    const r = await fetch(s.base + `/api/state?t=${TOKEN}`); // query token is not enough for API calls
    assert.equal(r.status, 403);
  } finally { s.close(); }
});

test('a wrong Host gets 403', async () => {
  const s = await start();
  try {
    for (const host of ['evil.example:80', 'localhost:' + s.port, '127.0.0.1']) {
      const status = await new Promise<number>((resolve, reject) => {
        const q = http.request({ host: '127.0.0.1', port: s.port, path: '/api/state', headers: { host, 'x-app-token': TOKEN } }, (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        });
        q.on('error', reject);
        q.end();
      });
      assert.equal(status, 403, host);
    }
  } finally { s.close(); }
});

test('a POST with a foreign Origin gets 403', async () => {
  const s = await start();
  try {
    const r = await api(s.base, '/api/sync', {}, { origin: 'http://evil.example' });
    assert.equal(r.status, 403);
    assert.equal(s.calls.length, 0);
  } finally { s.close(); }
});

test('a POST without Origin but Sec-Fetch-Site same-origin is allowed; without both it is not', async () => {
  const s = await start();
  try {
    const h = { 'x-app-token': TOKEN, 'content-type': 'application/json' };
    const ok = await fetch(s.base + '/api/sync', { method: 'POST', headers: { ...h, 'sec-fetch-site': 'same-origin' }, body: '{}' });
    assert.equal(ok.status, 200);
    const no = await fetch(s.base + '/api/sync', { method: 'POST', headers: h, body: '{}' });
    assert.equal(no.status, 403);
  } finally { s.close(); }
});

test('only GET and POST are allowed', async () => {
  const s = await start();
  try {
    const r = await fetch(s.base + '/api/state', { method: 'DELETE', headers: { 'x-app-token': TOKEN } });
    assert.equal(r.status, 405);
  } finally { s.close(); }
});

test('a body over 64 KB gets 413', async () => {
  const s = await start();
  try {
    const r = await api(s.base, '/api/note', { note: 'a'.repeat(70_000), includeUsual: false });
    assert.equal(r.status, 413);
  } finally { s.close(); }
});

test('non-JSON body gets 400, as does a wrong content type', async () => {
  const s = await start();
  try {
    const h = { 'x-app-token': TOKEN, origin: s.base };
    const bad = await fetch(s.base + '/api/ask', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    const ct = await fetch(s.base + '/api/ask', { method: 'POST', headers: { ...h, 'content-type': 'text/plain' }, body: '{"text":"a"}' });
    assert.equal(ct.status, 400);
  } finally { s.close(); }
});

test('every response carries the security headers', async () => {
  const s = await start();
  try {
    const rs = [
      await fetch(s.base + '/'), await fetch(s.base + '/nope'), await api(s.base, '/api/state'),
      await fetch(s.base + `/?t=${TOKEN}`), await api(s.base, '/api/sync', { x: 1 }, { origin: 'http://evil.example' }),
    ];
    for (const r of rs) {
      assert.equal(r.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(r.headers.get('cache-control'), 'no-store');
    }
  } finally { s.close(); }
});

test('GET / serves index.html with the CSP, and the two other files are served', async () => {
  const s = await start();
  try {
    const r = await fetch(s.base + `/?t=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await r.text(), '<html>hi</html>');
    const js = await fetch(s.base + `/app.js?t=${TOKEN}`);
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    const css = await fetch(s.base + `/app.css?t=${TOKEN}`);
    assert.match(css.headers.get('content-type') ?? '', /text\/css/);
    const image = await fetch(s.base + `/shopping.svg?t=${TOKEN}`);
    assert.match(image.headers.get('content-type') ?? '', /image\/svg\+xml/);
  } finally { s.close(); }
});

test('an unknown path gets 404 and no file outside the three is served', async () => {
  const s = await start();
  try {
    for (const p of ['/secret.txt', '/../package.json', '/%2e%2e/package.json', '/app.js/../secret.txt', '/nope', '/api/nope']) {
      const r = await fetch(s.base + p + (p.startsWith('/api') ? '' : `?t=${TOKEN}`), { headers: { 'x-app-token': TOKEN } });
      assert.equal(r.status, 404, p);
    }
  } finally { s.close(); }
});

test('a missing static file is 404', async () => {
  const s = await start();
  try {
    rmSync(join(s.publicDir, 'app.css'));
    assert.equal((await fetch(s.base + `/app.css?t=${TOKEN}`)).status, 404);
  } finally { s.close(); }
});

test('each API route calls the service and returns its JSON', async () => {
  const s = await start();
  try {
    const cases: [string, unknown | undefined, string, unknown[]][] = [
      ['/api/state', undefined, 'state', []],
      ['/api/sync', {}, 'sync', []],
      ['/api/note', { note: 'mleko', includeUsual: true, budgetGrosze: 5000 }, 'note', [{ note: 'mleko', includeUsual: true, budgetGrosze: 5000 }]],
      ['/api/ask', { text: 'bez masła' }, 'ask', ['bez masła']],
      ['/api/apply', { proposalId: 'p1' }, 'apply', ['p1']],
      ['/api/reject', { proposalId: 'p1' }, 'reject', ['p1']],
      ['/api/answer', { lineKey: 'k', productId: 'p' }, 'answer', ['k', 'p']],
      ['/api/answer', { lineKey: 'k', productId: null }, 'answer', ['k', null]],
      ['/api/line', { lineKey: 'k', quantity: 3 }, 'line', ['k', { quantity: 3 }]],
      ['/api/line', { lineKey: 'k', remove: true }, 'line', ['k', { remove: true }]],
      ['/api/line', { lineKey: 'k', included: false }, 'line', ['k', { included: false }]],
      ['/api/approve', {}, 'approve', []],
      ['/api/rules', undefined, 'rules', []],
      ['/api/blocked', undefined, 'blockedProducts', []],
      ['/api/blocked/search', { query: 'mąka' }, 'searchProducts', ['mąka']],
      ['/api/blocked/add', { productId: 'p2' }, 'blockProduct', ['p2']],
      ['/api/blocked/remove', { productId: 'p1' }, 'unblockProduct', ['p1']],
      ['/api/rules/delete', { term: 'mleko' }, 'deleteRule', ['mleko']],
      ['/api/rules/brand', { term: 'mleko', brand: null }, 'clearBrand', ['mleko']],
      ['/api/trip/reset', {}, 'reset', []],
    ];
    for (const [path, body, name, args] of cases) {
      s.calls.length = 0;
      const r = await api(s.base, path, body);
      assert.equal(r.status, 200, path);
      await r.json();
      assert.deepEqual(s.calls, [[name, args]], path);
    }
    assert.deepEqual(await (await api(s.base, '/api/rules')).json(), [{ term: 'mleko' }]);
    assert.deepEqual(await (await api(s.base, '/api/approve', {})).json(), { started: true });
  } finally { s.close(); }
});

test('invalid bodies get 400 with a fixed message and no service call', async () => {
  const s = await start();
  try {
    const bad: [string, unknown][] = [
      ['/api/note', { note: 5, includeUsual: true }],
      ['/api/note', { note: 'a'.repeat(10_001), includeUsual: true }],
      ['/api/note', { note: 'a', includeUsual: 'yes' }],
      ['/api/note', { note: 'a', includeUsual: true, budgetGrosze: -1 }],
      ['/api/note', { note: 'a', includeUsual: true, budgetGrosze: 1.5 }],
      ['/api/ask', { text: 'a'.repeat(2001) }],
      ['/api/ask', { text: '' }],
      ['/api/apply', {}],
      ['/api/answer', { lineKey: 'k' }],
      ['/api/answer', { lineKey: 'k', productId: 4 }],
      ['/api/line', { lineKey: 'k', quantity: 21 }],
      ['/api/line', { lineKey: 'k', quantity: 0 }],
      ['/api/line', { lineKey: 'k', quantity: 1.5 }],
      ['/api/line', { lineKey: 'k' }],
      ['/api/line', { quantity: 2 }],
      ['/api/rules/delete', { term: 3 }],
      ['/api/rules/brand', { term: 'x', brand: 'Y' }],
      ['/api/blocked/search', { query: 'a' }],
      ['/api/blocked/add', {}],
      ['/api/blocked/remove', { productId: 4 }],
      ['/api/ask', [1]],
    ];
    for (const [path, body] of bad) {
      const r = await api(s.base, path, body);
      assert.equal(r.status, 400, JSON.stringify([path, body]));
      assert.deepEqual(await r.json(), { error: 'Niepoprawne dane' });
    }
    assert.equal(s.calls.length, 0);
  } finally { s.close(); }
});

test('wrong method on a route is 405', async () => {
  const s = await start();
  try {
    assert.equal((await api(s.base, '/api/state', {})).status, 405);
    assert.equal((await api(s.base, '/api/sync')).status, 405);
  } finally { s.close(); }
});

test('the events stream sends state and progress events as SSE', async () => {
  const s = await start();
  try {
    const r = await fetch(s.base + `/api/events?t=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const reader = r.body!.getReader();
    await reader.read(); // initial comment flushes headers
    s.broadcaster.emit({ type: 'state' });
    s.broadcaster.emit({ type: 'progress', sent: 1, total: 3 });
    s.broadcaster.emit({ type: 'working', stage: 'parse', text: 'Czytam listę (1/3)…' });
    let text = '';
    const dec = new TextDecoder();
    while (!text.includes('Czytam')) text += dec.decode((await reader.read()).value);
    assert.match(text, /event: state\ndata: \{"type":"state"\}\n\n/);
    assert.match(text, /event: progress\ndata: \{"type":"progress","sent":1,"total":3\}\n\n/);
    assert.match(text, /event: working\ndata: \{"type":"working","stage":"parse","text":"Czytam listę \(1\/3\)…"\}\n\n/);
    await reader.cancel();
    for (let i = 0; i < 50 && s.broadcaster.size() > 0; i++) await new Promise((x) => setTimeout(x, 20));
    assert.equal(s.broadcaster.size(), 0);
  } finally { s.close(); }
});

test('service errors come back as a fixed message, never a stack', async () => {
  const s = await start(true);
  const orig = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  try {
    const r = await api(s.base, '/api/ask', { text: 'tajny tekst' });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { error: 'Błąd aplikacji' });
    assert.ok(logged.length > 0);
    assert.ok(!logged.join('\n').includes('tajny tekst'));
  } finally { console.error = orig; s.close(); }
});

test('icon.svg is served as an SVG with the security headers', async () => {
  const s = await start();
  try {
    const r = await fetch(s.base + `/icon.svg?t=${TOKEN}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /^image\/svg\+xml/);
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  } finally { s.close(); }
});

test('the stop function shuts the service down, closes the server and exits', async () => {
  const server = http.createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const order: string[] = [];
  const exited = new Promise<number>((resolve) => {
    createStop({ shutdown: () => void order.push('shutdown') }, server, (code) => { order.push('exit'); resolve(code); })();
  });
  assert.equal(await exited, 0);
  assert.deepEqual(order, ['shutdown', 'exit']);
  assert.equal(server.listening, false);
});
