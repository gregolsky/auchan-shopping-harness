import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserSearch, type PageLike, type SearchStatus } from '../src/search-browser.ts';

const CAPTCHA = "Let's confirm you are human";
const stateOf = (n: number) => ({ session: { isLoggedIn: true }, data: { products: { productEntities: Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { productId: `p${i}` }])) } } });

interface Script {
  loggedIn?: () => boolean;
  /** For a search url: what the page shows right now. */
  show(url: string, clock: Clock): { status: number; title: string; state: unknown };
}
class Clock { t = 0; sleeps: number[] = []; sleep = async (ms: number) => { this.sleeps.push(ms); this.t += ms; }; now = () => this.t; }

function fakePage(script: Script, clock: Clock) {
  let url = 'about:blank';
  const gotos: string[] = [];
  let closed = false;
  const view = () => (url.includes('/search?') ? script.show(url, clock) : { status: 200, title: 'Auchan', state: { session: { isLoggedIn: script.loggedIn ? script.loggedIn() : true } } });
  const page: PageLike = {
    async goto(u) { gotos.push(u); url = u; const s = view().status; return { status: () => s }; },
    async evaluate(fn: any) { const st: any = view().state; return String(fn).includes('isLoggedIn') ? st?.session?.isLoggedIn === true : st; },
    async title() { return view().title; },
    url: () => url,
    async close() { closed = true; },
  };
  return { page, gotos, isClosed: () => closed };
}

const run = async (script: Script, terms: string[], o: { captchaWaitMs?: number; loginWaitMs?: number } = {}) => {
  const clock = new Clock();
  const fp = fakePage(script, clock);
  const statuses: SearchStatus[] = [];
  const s = createBrowserSearch({ openPage: async () => fp.page, onStatus: (x) => statuses.push(x), sleep: clock.sleep, now: clock.now, pollMs: 100, ...o });
  const results = await s.search(terms);
  await s.close();
  return { results, statuses, clock, fp };
};

test('searches each term, with a pause between navigations and status updates', async () => {
  const r = await run({ show: () => ({ status: 200, title: 'Wyszukaj wyniki', state: stateOf(3) }) }, ['parówki', 'mleko 2%']);
  assert.deepEqual(r.results.map((x) => [x.term, x.status]), [['parówki', 'found'], ['mleko 2%', 'found']]);
  assert.ok(r.results[0].state);
  assert.ok(r.fp.gotos.includes('https://zakupy.auchan.pl/search?q=par%C3%B3wki'));
  assert.ok(r.fp.gotos.includes('https://zakupy.auchan.pl/search?q=mleko%202%25'));
  assert.deepEqual(r.clock.sleeps.filter((x) => x >= 5000), [5000, 5000]); // 3 navigations: home + 2 searches
  assert.deepEqual(r.statuses.filter((s) => s.kind === 'searching'), [
    { kind: 'searching', term: 'parówki', index: 1, total: 2 },
    { kind: 'searching', term: 'mleko 2%', index: 2, total: 2 },
  ]);
  assert.equal(r.fp.isClosed(), true);
});

test('a result page without products is none', async () => {
  const r = await run({ show: () => ({ status: 200, title: 't', state: stateOf(0) }) }, ['xyz']);
  assert.equal(r.results[0].status, 'none');
});

test('waits for login, then searches', async () => {
  let polls = 0;
  const r = await run({ loggedIn: () => ++polls > 3, show: () => ({ status: 200, title: 't', state: stateOf(1) }) }, ['a']);
  assert.ok(r.statuses.some((s) => s.kind === 'login'));
  assert.equal(r.results[0].status, 'found');
});

test('login that never happens stops everything', async () => {
  const r = await run({ loggedIn: () => false, show: () => assert.fail('must not search') }, ['a', 'b'], { loginWaitMs: 1000 });
  assert.deepEqual(r.results.map((x) => x.status), ['stopped', 'stopped']);
});

test('a captcha is waited out, then the search succeeds', async () => {
  const r = await run({
    show: (_u, c) => (c.t < 20_000 ? { status: 405, title: CAPTCHA, state: undefined } : { status: 405, title: 'Wyszukaj', state: stateOf(2) }),
  }, ['a']);
  assert.deepEqual(r.statuses.filter((s) => s.kind === 'captcha'), [{ kind: 'captcha', term: 'a' }]);
  assert.equal(r.results[0].status, 'found');
});

test('a captcha timeout stops this term and the rest', async () => {
  const r = await run({ show: () => ({ status: 405, title: CAPTCHA, state: undefined }) }, ['a', 'b', 'c'], { captchaWaitMs: 1000 });
  assert.deepEqual(r.results.map((x) => x.status), ['stopped', 'stopped', 'stopped']);
  assert.equal(r.fp.gotos.filter((g) => g.includes('/search?')).length, 1);
});

test('HTTP 403 stops the rest without retry', async () => {
  const r = await run({ show: (u) => (u.endsWith('q=b') ? { status: 403, title: 'Forbidden', state: undefined } : { status: 200, title: 't', state: stateOf(1) }) }, ['a', 'b', 'c']);
  assert.deepEqual(r.results.map((x) => x.status), ['found', 'stopped', 'stopped']);
  assert.equal(r.fp.gotos.filter((g) => g.includes('/search?')).length, 2);
});

test('an unexpected page without state stops the rest', async () => {
  const r = await run({ show: () => ({ status: 200, title: 'Something else', state: undefined }) }, ['a', 'b']);
  assert.deepEqual(r.results.map((x) => x.status), ['stopped', 'stopped']);
});

test('at most 10 terms are searched', async () => {
  const terms = Array.from({ length: 13 }, (_, i) => `t${i}`);
  const r = await run({ show: () => ({ status: 200, title: 't', state: stateOf(1) }) }, terms);
  assert.equal(r.results.length, 10);
  assert.equal(r.fp.gotos.filter((g) => g.includes('/search?')).length, 10);
});

test('the default pace is 5 seconds', async () => {
  const r = await run({ show: () => ({ status: 200, title: 't', state: stateOf(1) }) }, ['a', 'b']);
  assert.ok(r.clock.sleeps.includes(5000));
});

const REASON_403 = 'Auchan odmówił dostępu (403) — przerywam bez ponawiania.';

function statusPage(statusFor: (url: string) => number, loggedIn = false) {
  const gotos: string[] = [];
  const page: PageLike = {
    async goto(u) { gotos.push(u); const s = statusFor(u); return { status: () => s }; },
    async evaluate(fn: any) { return (loggedIn ? (String(fn).includes('isLoggedIn') ? true : stateOf(1)) : false) as never; },
    async title() { return 'Auchan'; },
    url: () => 'about:blank',
    async close() {},
  };
  return { page, gotos };
}

for (const code of [403, 429, 500]) {
  test(`${code} on the home page stops everything at once: no login wait, no search`, async () => {
    const clock = new Clock();
    const fp = statusPage(() => code);
    const statuses: SearchStatus[] = [];
    const s = createBrowserSearch({ openPage: async () => fp.page, onStatus: (x) => statuses.push(x), sleep: clock.sleep, now: clock.now, pollMs: 100 });
    const results = await s.search(['a', 'b']);
    assert.deepEqual(results.map((x) => x.status), ['stopped', 'stopped']);
    assert.deepEqual(fp.gotos, ['https://zakupy.auchan.pl/']);
    assert.ok(!statuses.some((x) => x.kind === 'login'));
    assert.equal(clock.sleeps.length, 0);
    const stop = statuses.find((x) => x.kind === 'stopped');
    assert.ok(stop && stop.kind === 'stopped');
    if (code === 403) assert.equal(stop.reason, REASON_403);
    else assert.match(stop.reason, new RegExp(`\\(${code}\\)`));
  });
}

test('403 on a search page stops the remaining terms with the reason', async () => {
  const clock = new Clock();
  const fp = statusPage((u) => (u.includes('q=b') ? 403 : 200), true);
  const statuses: SearchStatus[] = [];
  const s = createBrowserSearch({ openPage: async () => fp.page, onStatus: (x) => statuses.push(x), sleep: clock.sleep, now: clock.now, pollMs: 100, loginWaitMs: 0 });
  const results = await s.search(['a', 'b', 'c']);
  assert.equal(results[1].status, 'stopped');
  assert.equal(results[2].status, 'stopped');
  assert.equal(results[0].status, 'found');
  assert.ok(statuses.some((x) => x.kind === 'stopped' && x.reason === REASON_403));
});
