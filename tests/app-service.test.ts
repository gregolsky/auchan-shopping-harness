import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/app/service.ts';
import type { AppEvent } from '../src/app/service.ts';
import type { Spawn } from '../src/app/claude.ts';
import { saveTrip } from '../src/app/trip.ts';
import { openStore, type Store } from '../src/store.ts';
import { Blocked, LoginRequired, RateLimited, Refused, type Worker } from '../src/worker.ts';
import type { CartAccess } from '../src/http-worker.ts';
import type { Product, PriceObservation } from '../src/types.ts';
import { fakeCart, type FakeCart } from './helpers/fake-cart.ts';
import type { PageLike } from '../src/search-browser.ts';

const SEARCH_STATE = JSON.parse(readFileSync(new URL('./fixtures/search-state.json', import.meta.url), 'utf8'));
const REGION = '00000000-0000-4000-8000-000000000010';
const EMPTY_SEARCH = { session: { isLoggedIn: true }, data: { products: { productEntities: {} } } };

/** A browser page that never touches a browser: logged in, and each search term answered from a table. */
function fakeSearchPage(shows: Record<string, unknown> = { 'parówki': SEARCH_STATE }, o: { status?: number; log?: string[] } = {}): PageLike {
  let url = 'about:blank';
  const view = (): any => (url.includes('/search?q=') ? (shows[decodeURIComponent(url.split('q=')[1]!)] ?? EMPTY_SEARCH) : { session: { isLoggedIn: true } });
  return {
    async goto(u) { url = u; o.log?.push(u); return { status: () => o.status ?? 200 }; },
    evaluate: (async (fn: any) => (String(fn).includes('isLoggedIn') ? view().session?.isLoggedIn === true : view())) as PageLike['evaluate'],
    async title() { return 'Auchan'; },
    url: () => url,
    async close() { o.log?.push('closed'); },
  };
}

const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002', C = '00000000-0000-4000-8000-000000000003';
const mk = (id: string, name: string, brand = 'M'): Product => ({
  productId: id, retailerProductId: `r-${id}`, name, brand, categoryPath: ['X'], unitLabel: 'kg', size: '1 l', inCatalogue: true,
});
const price = (id: string, grosze: number): PriceObservation => ({
  productId: id, seenAt: new Date().toISOString(), regionId: 'r1', source: 'promotion',
  originalGrosze: null, currentGrosze: grosze, unitCurrentGrosze: grosze, offerText: null, requiredQuantity: null,
});

type Reply = object | null;
function setup(opts: { claude?: { parse?: Reply; choose?: Reply; adhoc?: Reply }; cart?: CartAccess & Partial<FakeCart>; seedHigh?: boolean; emit?: (e: AppEvent) => void; page?: () => PageLike; region?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'svc-'));
  const lockFile = join(dir, 'fill.lock');
  const tripFile = join(dir, 'trip.json');
  const store = openStore(':memory:');
  store.savePromotions({
    regionId: 'r1',
    products: [mk(A, 'Mleko 2%'), mk(B, 'Chleb'), mk(C, 'Mleko 3%')],
    prices: [price(A, 199), price(B, 250), price(C, 210)],
  });
  if (opts.region !== false) store.saveOrder({ order: { orderId: 'o1', deliveredAt: '2026-11-01T10:00:00Z', totalGrosze: 100, regionId: REGION }, lines: [], products: [], prices: [] });
  const events: AppEvent[] = [];
  const finished: { status: string }[] = [];
  const spawned: string[] = [];
  const spawn: Spawn = async (_c, _a, input) => {
    const task = input.includes('Task: turn the note') ? 'parse' : input.includes('Task: use the user input') ? 'choose' : 'adhoc';
    spawned.push(task);
    const reply = opts.claude?.[task] ?? null;
    if (reply === null) return { code: null, stdout: '', timedOut: false, missing: true };
    return { code: 0, stdout: JSON.stringify({ structured_output: reply }), timedOut: false, missing: false };
  };
  const cart = opts.cart ?? fakeCart({});
  const worker = {
    async getJson() { return {}; }, async graphql() { return {}; }, async pageState() { return {}; }, async pageLinks() { return []; },
    async close() {}, async waitForLogin() { return true; },
    readCart: () => cart.readCart(), applyQuantities: (c) => cart.applyQuantities(c),
  } as Worker & CartAccess;
  const shared = (): Store => ({ ...store, close() {} });
  const make = () => createService({
    openStore: shared, spawn, tripFile, now: () => new Date('2026-11-15T10:00:00Z'), emit: (e) => { opts.emit?.(e); events.push(e); },
    fillDeps: { lockFile, openWorker: async () => worker, openStore: () => ({ ...store, close() {}, finishFill: (id: number, r: any) => (finished.push(r), store.finishFill(id, r)) }) },
    syncDeps: { openStore: shared, openWorker: async () => worker, paceMs: 0 },
    openSearchPage: async () => (opts.page ?? (() => fakeSearchPage()))(),
    searchTuning: { paceMs: 0, sleep: async () => {} },
  });
  return { svc: make(), make, store, events, finished, spawned, lockFile, tripFile, cart };
}

const done = (events: AppEvent[]) => new Promise<void>((resolve) => {
  const poll = () => (events.some((e) => e.type === 'done') ? resolve() : setImmediate(poll));
  poll();
});

test('blacklist edits in the app invalidate the draft and affect the next plan', async () => {
  const { svc, store, make } = setup();
  const first = await svc.note({ note: 'chleb', includeUsual: false });
  assert.equal(first.lines[0].productId, B);
  assert.deepEqual(svc.searchProducts('chle').map((p) => p.productId), [B]);
  assert.equal(svc.blockProduct(B), true);
  assert.equal(svc.state().trip.lines.length, 0, 'old choices must not remain approvable');
  assert.deepEqual(make().blockedProducts().some((p) => p.productId === B), true);
  const blocked = await svc.note({ note: 'chleb', includeUsual: false });
  assert.deepEqual(blocked.unmatched, []);
  assert.match(blocked.messages.join(' '), /zablokowan.*chleb/i);
  assert.equal(svc.unblockProduct(B), true);
  assert.equal((await svc.note({ note: 'chleb', includeUsual: false })).lines[0].productId, B);
  store.close();
});

test('blacklist edits wait when another fill holds the cart lock', () => {
  const { svc, lockFile } = setup();
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  assert.equal(svc.blockProduct(B), false);
  assert.equal(svc.blockedProducts().some((p) => p.productId === B), false);
});

test('Claude cannot relabel a blocked product as something to add by hand', async () => {
  const { svc } = setup({ claude: { parse: { ops: [{ op: 'add', term: 'chleb', quantity: 1 }, { op: 'unmatched', term: 'chleb', hint: 'Dodaj ręcznie' }] } } });
  svc.blockProduct(B);
  const trip = await svc.note({ note: 'chleb', includeUsual: false });
  assert.deepEqual(trip.unmatched, []);
  assert.match(trip.messages.join(' '), /zablokowane produkty: chleb/i);
});

const parseMilk = { ops: [{ op: 'add', term: 'mleko', quantity: 2, note: 'tłuste' }, { op: 'add', term: 'chleb', quantity: 1 }] };

test('note in claude mode drafts the parsed terms and holds Claude\'s choose proposal', async () => {
  const keyOf = 't:mleko';
  const { svc, store } = setup({ claude: { parse: parseMilk, choose: { ops: [{ op: 'choose', lineKey: keyOf, productId: C }, { op: 'say', text: 'Wybrałem 3%.' }, { op: 'bogus' }] } } });
  const t = await svc.note({ note: 'mleko x2, chleb', includeUsual: false });
  assert.equal(t.mode, 'claude');
  assert.deepEqual(t.lines.map((l) => l.lineKey).sort(), ['t:chleb', 't:mleko']);
  assert.equal(t.lines.find((l) => l.lineKey === keyOf)!.note, 'tłuste');
  assert.equal(t.lines.find((l) => l.lineKey === keyOf)!.productId, A, 'nothing changes until applied');
  assert.equal(t.proposal?.source, 'claude');
  assert.deepEqual(t.proposal?.ops.map((o) => o.op), ['choose']);
  assert.ok(t.messages.includes('Wybrałem 3%.'));
  assert.ok(t.messages.includes('pominięto 1 nieprawidłowych zmian'));
  assert.equal(t.step, 'doprecyzowanie');
  assert.deepEqual(store.corrections(), []);
});

test('claude ask ops are applied at once; no proposal and no question means zatwierdzenie', async () => {
  const withAsk = setup({ claude: { parse: parseMilk, choose: { ops: [{ op: 'ask', lineKey: 't:mleko', question: 'Które mleko?', options: [A, C] }] } } });
  const t = await withAsk.svc.note({ note: 'mleko, chleb', includeUsual: false });
  assert.equal(t.lines.find((l) => l.lineKey === 't:mleko')!.question?.text, 'Które mleko?');
  assert.equal(t.proposal, null);
  assert.equal(t.step, 'doprecyzowanie');
  const calm = setup({ claude: { parse: { ops: [{ op: 'add', term: 'chleb', quantity: 1 }] }, choose: { ops: [] } } });
  const c = await calm.svc.note({ note: 'chleb', includeUsual: false });
  assert.equal(c.lines[0].question, null);
  assert.equal(c.step, 'zatwierdzenie');
});

test('note in fallback mode asks every doubtful line', async () => {
  const { svc, spawned, tripFile } = setup();
  const t = await svc.note({ note: 'mleko x2\nchleb', includeUsual: false });
  assert.equal(t.mode, 'fallback');
  assert.deepEqual(spawned, ['parse']);
  assert.ok(t.messages.includes('Tryb bez Claude: pytam o każdą niepewną pozycję.'));
  const milk = t.lines.find((l) => l.lineKey === 't:mleko')!;
  assert.ok(milk.quantity >= 1);
  assert.ok(milk.question && milk.question.options.length >= 1 && milk.question.options.length <= 3);
  assert.ok(t.lines.every((l) => l.confidence === 'high' || l.question !== null));
  assert.equal(t.step, 'doprecyzowanie');
  assert.ok(existsSync(tripFile));
  assert.equal(statSync(tripFile).mode & 0o777, 0o600);
});

test('apply records corrections for changed choices and merges added terms; reject drops', async () => {
  const { svc, store, events } = setup({
    claude: {
      parse: { ops: [{ op: 'add', term: 'mleko', quantity: 1 }] },
      choose: { ops: [{ op: 'choose', lineKey: 't:mleko', productId: C }, { op: 'add', term: 'chleb', quantity: 1 }] },
    },
  });
  let t = await svc.note({ note: 'mleko', includeUsual: false });
  assert.equal(store.corrections().length, 0);
  const rejected = svc.reject(t.proposal!.id);
  assert.equal(rejected.proposal, null);
  t = await svc.ask('weź 3%');
  assert.equal(t.proposal, null, 'adhoc reply is empty without claude');
  // Re-create a proposal through a fresh trip.
  const again = await svc.note({ note: 'mleko', includeUsual: false });
  const before = events.length;
  const applied = svc.apply(again.proposal!.id);
  assert.ok(events.length > before);
  assert.equal(applied.lines.find((l) => l.lineKey === 't:mleko')!.productId, C);
  assert.ok(applied.lines.some((l) => l.lineKey === 't:chleb'));
  assert.equal(applied.proposal, null);
  assert.deepEqual(store.corrections().map((c) => [c.term, c.chosenProductId]), [['mleko', C]]);
  assert.equal(svc.apply('nope').lines.length, applied.lines.length);
});

test('ask returns a proposal and a say message', async () => {
  const { svc } = setup({
    claude: { parse: { ops: [{ op: 'add', term: 'mleko', quantity: 1 }] }, choose: { ops: [] }, adhoc: { ops: [{ op: 'setQuantity', lineKey: 't:mleko', quantity: 3 }, { op: 'say', text: 'Trzy sztuki.' }] } },
  });
  await svc.note({ note: 'mleko', includeUsual: false });
  const t = await svc.ask('daj trzy');
  assert.deepEqual(t.proposal?.ops, [{ op: 'setQuantity', lineKey: 't:mleko', quantity: 3 }]);
  assert.ok(t.messages.includes('Trzy sztuki.'));
  assert.equal(t.lines[0].quantity, 1);
  assert.equal(svc.apply(t.proposal!.id).lines[0].quantity, 3);
});

test('ask without claude says so', async () => {
  const { svc } = setup();
  const t = await svc.ask('cokolwiek');
  assert.ok(t.messages.some((m) => /Claude jest niedostępny/.test(m)));
});

test('answer clears the question, records the correction, and approve then succeeds', async () => {
  const { svc, store, events } = setup();
  const t = await svc.note({ note: 'mleko', includeUsual: false });
  assert.equal((await svc.approve()).started, false);
  const key = t.lines[0].lineKey;
  const after = svc.answer(key, C);
  assert.equal(after.lines[0].question, null);
  assert.equal(after.lines[0].productId, C);
  assert.equal(after.step, 'zatwierdzenie');
  assert.deepEqual(store.corrections().map((c) => c.chosenProductId), [C]);
  const r = await svc.approve();
  assert.equal(r.started, true);
  await done(events);
});

test('approve refuses with open questions, nothing included, and while the lock is held', async () => {
  const { svc, lockFile, events } = setup();
  const t = await svc.note({ note: 'mleko', includeUsual: false });
  const noQ = await svc.approve();
  assert.equal(noQ.started, false);
  assert.match(noQ.reason!, /pytania/);
  svc.answer(t.lines[0].lineKey, A);
  svc.line(t.lines[0].lineKey, { included: false });
  assert.match((await svc.approve()).reason!, /Nic nie jest zaznaczone/);
  svc.line(t.lines[0].lineKey, { included: true });
  writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  const held = await svc.approve();
  assert.equal(held.started, false);
  assert.match(held.reason!, /Inny fill już trwa/);
  assert.equal(events.some((e) => e.type === 'log'), false);
});

test('approve fills the fake cart and emits progress then report then done; a second approve is refused', async () => {
  const cart = fakeCart({});
  const { svc, make, events, cart: c, store } = setup({ cart });
  const t = await svc.note({ note: 'mleko x2\nchleb', includeUsual: false });
  for (const l of t.lines) svc.answer(l.lineKey, l.productId);
  const first = await svc.approve();
  assert.equal(first.started, true);
  assert.equal(svc.state().busy, 'fill');
  assert.equal(svc.state().trip.step, 'koszyk');
  const second = await svc.approve();
  assert.equal(second.started, false);
  assert.match(second.reason!, /trwa/);
  assert.match((await svc.sync()).reason!, /trwa/);
  await done(events);
  assert.deepEqual((c as FakeCart).quantities, Object.fromEntries(t.lines.map((l) => [l.productId, l.quantity])));
  const types = events.map((e) => e.type).filter((x) => x !== 'state' && x !== 'log' && x !== 'working');
  assert.deepEqual(types, ['progress', 'report', 'done']);
  const rep = events.find((e) => e.type === 'report') as { type: 'report'; report: any };
  assert.match(rep.report.text, /Zapłać na https:\/\/zakupy.auchan.pl\/checkout/);
  assert.equal(rep.report.added.length, 2);
  assert.deepEqual(rep.report.substitutes, {});
  assert.equal((events.find((e) => e.type === 'done') as any).code, 0);
  assert.equal(svc.state().trip.step, 'platnosc');
  assert.equal(make().state().trip.reportText, rep.report.text, 'the report survives a service restart');
  assert.equal(svc.state().busy, null);
  assert.ok(store.latestApprovedBasket());
});

test('a fill without a report goes back to zatwierdzenie with the failure in messages', async () => {
  const cart = fakeCart({});
  cart.applyQuantities = async () => { throw new Error('boom'); };
  const { svc, events } = setup({ cart });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  await svc.approve();
  await done(events);
  const s = svc.state();
  assert.equal(s.trip.step, 'zatwierdzenie');
  assert.match(s.trip.messages.at(-1)!, /Wypełnianie nie powiodło się: .*boom/);
  assert.equal((events.find((e) => e.type === 'done') as any).code, 1);
  assert.equal(events.some((e) => e.type === 'report'), false);
});

test('startup resumes the trip but not a fill', async () => {
  const { svc, make, tripFile } = setup();
  await svc.note({ note: 'chleb', includeUsual: false });
  const saved = svc.state().trip;
  assert.equal(make().state().trip.note, 'chleb');
  saveTrip(tripFile, { ...saved, step: 'koszyk' });
  const resumed = make().state().trip;
  assert.equal(resumed.step, 'zatwierdzenie');
  assert.equal(resumed.messages.at(-1), 'Wypełnianie przerwane — uruchom ponownie; doda tylko brakujące.');
  assert.equal(resumed.lines.length, saved.lines.length);
});

test('sync runs in the background and reports freshness', async () => {
  const { svc, events } = setup();
  assert.deepEqual(svc.state().freshness, { ordersAt: null, promotionsAt: null, ageHours: null });
  const r = await svc.sync();
  assert.equal(r.started, true);
  assert.equal(svc.state().busy, 'sync');
  assert.match((await svc.approve()).reason!, /trwa/);
  await done(events);
  assert.equal(svc.state().busy, null);
});

test('rules lists, deletes a rule and clears a brand', async () => {
  const { svc, store } = setup();
  store.recordCorrection({ term: 'mleko', proposedProductId: A, chosenProductId: C });
  store.setBrandFixed('mleko', 'M');
  assert.equal(svc.rules().length, 1);
  assert.equal(svc.rules()[0].brand, 'M');
  svc.clearBrand('mleko');
  assert.equal(svc.rules()[0].brand, null);
  svc.deleteRule('mleko');
  assert.deepEqual(svc.rules(), []);
});

test('reset clears the trip file', async () => {
  const { svc, tripFile } = setup();
  await svc.note({ note: 'chleb', includeUsual: false });
  assert.ok(existsSync(tripFile));
  const t = svc.reset();
  assert.equal(t.lines.length, 0);
  assert.equal(t.step, 'dane');
  assert.equal(existsSync(tripFile), false);
  assert.equal(svc.state().trip.note, '');
});

test('line changes quantity and removes', async () => {
  const { svc } = setup({ claude: { parse: { ops: [{ op: 'add', term: 'chleb', quantity: 1 }] }, choose: { ops: [] } } });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  const k = t.lines[0].lineKey;
  assert.equal(svc.line(k, { quantity: 4 }).lines[0].quantity, 4);
  assert.equal(svc.line(k, { quantity: 50 }).lines[0].quantity, 4);
  assert.equal(svc.line(k, { remove: true }).lines.length, 0);
});


/** A cart whose adds wait until released, so a test can act while a fill runs. */
function slowCart() {
  const cart = fakeCart({});
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (started = r));
  const real = cart.applyQuantities;
  cart.applyQuantities = async (c) => { started(); await gate; return real(c); };
  return { cart, release, reached };
}

async function runningFill(extra: Parameters<typeof setup>[0] = {}) {
  const slow = slowCart();
  const s = setup({ ...extra, cart: slow.cart });
  const t = await s.svc.note({ note: 'chleb', includeUsual: false });
  s.svc.answer(t.lines[0].lineKey, B);
  assert.equal((await s.svc.approve()).started, true);
  await slow.reached;
  return { ...s, ...slow, key: t.lines[0].lineKey };
}

test('while a fill runs the trip is frozen and nothing is recorded', async () => {
  const { svc, store, events, release, key } = await runningFill({ claude: { parse: { ops: [{ op: 'add', term: 'chleb', quantity: 1 }] }, choose: { ops: [] }, adhoc: { ops: [{ op: 'remove', lineKey: 't:chleb' }] } } });
  const before = svc.state().trip;
  const n = await svc.note({ note: 'mleko', includeUsual: false });
  assert.equal(n.note, 'chleb');
  assert.ok(n.messages.includes('Trwa dodawanie do koszyka — poczekaj na koniec.'));
  assert.equal(n.lines.length, before.lines.length);
  await svc.ask('usuń');
  svc.apply('x'); svc.reject('x'); svc.line(key, { remove: true });
  assert.equal(svc.answer(key, C).lines[0].productId, B);
  assert.equal(svc.state().trip.lines.length, 1);
  assert.equal(svc.blockProduct(A), false);
  assert.deepEqual(store.corrections().filter((c) => c.chosenProductId === C), []);
  release();
  await done(events);
  assert.equal(svc.state().trip.step, 'platnosc');
});

test('a failing listener never becomes an unhandled rejection and busy is cleared', async () => {
  const rejections: unknown[] = [];
  const onRej = (e: unknown) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  const errors: string[] = [];
  const orig = console.error;
  console.error = (m: string) => void errors.push(String(m));
  try {
    let armed = false;
    const { svc, events } = setup({ emit: (e) => { if (armed && e.type !== 'state') throw new Error('listener'); } });
    const t = await svc.note({ note: 'chleb', includeUsual: false });
    svc.answer(t.lines[0].lineKey, B);
    armed = true;
    assert.equal((await svc.approve()).started, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(svc.state().busy, null);
    assert.equal(svc.state().trip.step, 'platnosc');
    void events;
    assert.deepEqual(rejections, []);
    assert.ok(errors.some((m) => /listener/.test(m)));
    const sync = await svc.sync();
    assert.equal(sync.started, true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(svc.state().busy, null);
    assert.deepEqual(rejections, []);
  } finally {
    console.error = orig;
    process.off('unhandledRejection', onRej);
  }
});

test('approve refuses while a proposal is pending', async () => {
  const { svc } = setup({ claude: { parse: { ops: [{ op: 'add', term: 'chleb', quantity: 1 }] }, choose: { ops: [{ op: 'setQuantity', lineKey: 't:chleb', quantity: 2 }] } } });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  const r = await svc.approve();
  assert.equal(r.started, false);
  assert.equal(r.reason, 'Najpierw zastosuj albo odrzuć propozycję zmian.');
});

test('shutdown marks a running fill failed and frees the lock', async () => {
  const { svc, finished, lockFile, release, events } = await runningFill();
  assert.ok(existsSync(lockFile));
  svc.shutdown();
  assert.deepEqual(finished.map((f) => f.status), ['failed']);
  assert.equal(existsSync(lockFile), false);
  release();
  await done(events);
  assert.equal(svc.state().trip.step, 'koszyk', 'a stopped run does not rewrite the trip');
});

test('removing a term line directly records a removal correction', async () => {
  const { svc, store } = setup({ claude: { parse: { ops: [{ op: 'add', term: 'chleb', quantity: 1 }] }, choose: { ops: [] } } });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.line(t.lines[0].lineKey, { remove: true });
  assert.deepEqual(store.corrections().map((c) => [c.term, c.chosenProductId]), [['chleb', null]]);
});

test('approve after platnosc is refused so the paid basket is not added again', async () => {
  const cart = fakeCart({});
  const { svc, events } = setup({ cart });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  assert.equal((await svc.approve()).started, true);
  await done(events);
  assert.equal(svc.state().trip.step, 'platnosc');
  const before = (cart as FakeCart).applyCalls.length;
  const again = await svc.approve();
  assert.equal(again.started, false);
  assert.equal(again.reason, 'Te zakupy są już w koszyku. Zacznij nowe zakupy, żeby dodać coś jeszcze.');
  assert.equal((cart as FakeCart).applyCalls.length, before);
});

test('approving a trip with a product blocked meanwhile is refused with its name', async () => {
  const { svc, store } = setup();
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  store.blockProduct(B);
  const r = await svc.approve();
  assert.equal(r.started, false);
  assert.match(r.reason!, /Produkt zablokowany: Chleb/);
});

test('the app report lists a blocked product already in the cart first, and leaves it there', async () => {
  const cart = fakeCart({ [C]: 1 });
  const { svc, events, store } = setup({ cart });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  store.blockProduct(C);
  await svc.approve();
  await done(events);
  const rep = events.find((e) => e.type === 'report') as { type: 'report'; report: any };
  assert.match(rep.report.text, /Sprawdź przed zapłatą:\n  - Mleko 3% — zablokowany produkt w koszyku, usuń go na Auchan/);
  assert.equal((cart as FakeCart).quantities[C], 1);
});

async function failingFill(error: Error, cartExtra: Partial<FakeCart> = {}) {
  const cart = fakeCart({});
  cart.applyQuantities = async () => { throw error; };
  const s = setup({ cart: Object.assign(cart, cartExtra) });
  const t = await s.svc.note({ note: 'chleb', includeUsual: false });
  s.svc.answer(t.lines[0].lineKey, B);
  assert.equal((await s.svc.approve()).started, true);
  await done(s.events);
  return s;
}

test('a blocked (403) fill keeps a flag that refuses approving again, and a new trip clears it', async () => {
  const { svc, make, tripFile } = await failingFill(new Blocked('HTTP 403'));
  const s = svc.state();
  assert.equal(s.trip.blocked, true);
  assert.equal(s.trip.step, 'zatwierdzenie');
  assert.equal(s.trip.messages.at(-1), 'Wypełnianie nie powiodło się: Auchan odrzucił zapytanie. Nie zatwierdzaj ponownie — sprawdź koszyk na Auchan i zacznij nowe zakupy.');
  const r = await svc.approve();
  assert.equal(r.started, false);
  assert.equal(r.reason, 'Auchan odrzucił zapytanie. Nie zatwierdzaj ponownie — sprawdź koszyk na Auchan i zacznij nowe zakupy.');
  assert.equal(make().state().trip.blocked, true, 'the flag survives a restart');
  assert.equal((await svc.note({ note: 'chleb', includeUsual: false })).blocked, true, 'a new draft does not lift it');
  assert.equal(svc.reset().blocked, undefined);
  assert.equal(existsSync(tripFile), false);
});

test('fill failures that the user meets are shown in Polish', async () => {
  const cases: [Error, RegExp, boolean | undefined][] = [
    [new Refused(B, 'Chleb'), /Auchan odrzucił zmianę koszyka \(Chleb\)/, undefined],
    [new RateLimited(429, 120), /zwolnienie tempa.*za 2 min/, undefined],
    [new LoginRequired(), /zaloguj się w oknie przeglądarki/, undefined],
  ];
  for (const [err, re, blocked] of cases) {
    const { svc } = await failingFill(err);
    const last = svc.state().trip.messages.at(-1)!;
    assert.match(last, re);
    assert.doesNotMatch(last, /Auchan refused|slow down|Log in|Fill failed/);
    assert.equal(svc.state().trip.blocked, blocked, err.name);
  }
});

test('the login prompt during a fill is Polish and is not part of the failure text', async () => {
  const cart = fakeCart({});
  let first = true;
  const real = cart.readCart;
  cart.readCart = async () => { if (first) { first = false; throw new LoginRequired(); } return real(); };
  cart.applyQuantities = async () => { throw new Error('boom'); };
  const { svc, events } = setup({ cart });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  await svc.approve();
  await done(events);
  const logs = events.flatMap((e) => (e.type === 'log' ? [e.text] : []));
  assert.ok(logs.includes('Zaloguj się w oknie przeglądarki i zostaw je otwarte — dodawanie ruszy samo.'));
  const last = svc.state().trip.messages.at(-1)!;
  assert.doesNotMatch(last, /Zaloguj/);
  assert.match(last, /boom/);
});

test('a product listed twice is refused with its name', async () => {
  const { svc } = setup();
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  const first = t.lines[0];
  // Force a second line with the same product by editing the saved trip.
  const dupe = { ...first, lineKey: 't:inny', term: 'inny' };
  const s = setup();
  const file = s.tripFile;
  saveTrip(file, { ...t, step: 'zatwierdzenie', proposal: null, lines: [{ ...first, question: null }, { ...dupe, question: null }] });
  const again = s.make();
  const r = await again.approve();
  assert.equal(r.started, false);
  assert.equal(r.reason, `Ten sam produkt jest na liście dwa razy: ${first.name}. Usuń jedną pozycję.`);
});

test('after payment the trip is frozen: line, answer, apply, ask and note are refused pointing to Nowe zakupy', async () => {
  const { svc, events, spawned } = setup({ claude: { adhoc: { ops: [{ op: 'say', text: 'x' }] } } });
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  await svc.approve();
  await done(events);
  assert.equal(svc.state().trip.step, 'platnosc');
  const key = t.lines[0].lineKey;
  const before = svc.state().trip.lines;
  const calls = spawned.length;
  svc.line(key, { quantity: 5 });
  svc.line(key, { remove: true });
  svc.answer(key, null);
  svc.apply('x');
  await svc.ask('zmień');
  const after = await svc.note({ note: 'mleko', includeUsual: false });
  assert.equal(after.step, 'platnosc');
  assert.deepEqual(svc.state().trip.lines, before);
  assert.equal(spawned.length, calls, 'Claude is not called');
  assert.equal(svc.state().trip.messages.at(-1), 'Te zakupy są już w koszyku. Kliknij „Nowe zakupy”, żeby zacząć od nowa.');
});

test('note emits working stages in order; ask emits its own text', async () => {
  const { svc, events } = setup({ claude: { parse: parseMilk, choose: { ops: [] }, adhoc: { ops: [] } } });
  await svc.note({ note: 'mleko, chleb', includeUsual: false });
  const working = () => events.flatMap((e) => (e.type === 'working' ? [[e.stage, e.text]] : []));
  assert.deepEqual(working(), [
    ['parse', 'Czytam listę (1/3)…'], ['draft', 'Dobieram produkty z historii i promocji (2/3)…'],
    ['choose', 'Claude sprawdza dopasowania (3/3)…'], ['done', 'Gotowe.'],
  ]);
  events.length = 0;
  await svc.ask('weź tańsze');
  assert.deepEqual(working(), [['choose', 'Claude przygotowuje propozycję…'], ['done', 'Gotowe.']]);
});

test('note in fallback mode skips the choose stage', async () => {
  const { svc, events } = setup();
  await svc.note({ note: 'chleb', includeUsual: false });
  assert.deepEqual(events.flatMap((e) => (e.type === 'working' ? [e.stage] : [])), ['parse', 'draft', 'done']);
});

const twoOps = { parse: parseMilk, choose: { ops: [{ op: 'choose', lineKey: 't:mleko', productId: C }, { op: 'setQuantity', lineKey: 't:chleb', quantity: 3 }] } };

test('proposalOp accepts one operation through the correction path and keeps the rest of the proposal', async () => {
  const { svc, store } = setup({ claude: twoOps });
  const t = await svc.note({ note: 'mleko, chleb', includeUsual: false });
  const id = t.proposal!.id;
  const r = svc.proposalOp(id, 0, true);
  assert.equal(r.lines.find((l) => l.lineKey === 't:mleko')!.productId, C);
  assert.equal(r.lines.find((l) => l.lineKey === 't:chleb')!.quantity, 1);
  assert.deepEqual(r.proposal?.ops, [{ op: 'setQuantity', lineKey: 't:chleb', quantity: 3 }]);
  assert.equal(r.proposal?.id, id);
  assert.deepEqual(store.corrections().map((c) => [c.term, c.chosenProductId]), [['mleko', C]]);
  assert.equal(r.step, 'doprecyzowanie');
});

test('proposalOp dropping the last operation clears the proposal and changes nothing else', async () => {
  const { svc, store } = setup({ claude: twoOps });
  const t = await svc.note({ note: 'mleko, chleb', includeUsual: false });
  svc.proposalOp(t.proposal!.id, 0, false);
  const r = svc.proposalOp(t.proposal!.id, 0, false);
  assert.equal(r.proposal, null);
  assert.equal(r.lines.find((l) => l.lineKey === 't:mleko')!.productId, A);
  assert.equal(r.lines.find((l) => l.lineKey === 't:chleb')!.quantity, 1);
  assert.deepEqual(store.corrections(), []);
  assert.equal(r.step, 'zatwierdzenie');
});

test('proposalOp accepting an add operation drafts the new term', async () => {
  const { svc } = setup({ claude: { parse: { ops: [{ op: 'add', term: 'mleko', quantity: 1 }] }, choose: { ops: [{ op: 'add', term: 'chleb', quantity: 2 }] } } });
  const t = await svc.note({ note: 'mleko', includeUsual: false });
  const r = svc.proposalOp(t.proposal!.id, 0, true);
  assert.equal(r.proposal, null);
  assert.ok(r.lines.some((l) => l.lineKey === 't:chleb'));
});

test('proposalOp ignores a wrong id or index', async () => {
  const { svc } = setup({ claude: twoOps });
  const t = await svc.note({ note: 'mleko, chleb', includeUsual: false });
  for (const args of [['nope', 0], [t.proposal!.id, 2], [t.proposal!.id, -1], [t.proposal!.id, 0.5]] as const) {
    assert.equal(svc.proposalOp(args[0], args[1], true).proposal?.ops.length, 2);
  }
  assert.equal(svc.state().trip.lines.find((l) => l.lineKey === 't:mleko')!.productId, A);
});

test('chooseProduct takes a candidate, records the correction and clears the question', async () => {
  const { svc, store } = setup();
  const t = await svc.note({ note: 'mleko', includeUsual: false });
  const key = t.lines[0].lineKey;
  assert.ok(t.lines[0].question);
  const r = svc.chooseProduct(key, C);
  assert.equal(r.lines[0].productId, C);
  assert.equal(r.lines[0].question, null);
  assert.equal(r.step, 'zatwierdzenie');
  assert.deepEqual(store.corrections().map((c) => c.chosenProductId), [C]);
  assert.equal(svc.chooseProduct(key, 'not-a-candidate').lines[0].productId, C);
  assert.equal(svc.chooseProduct('nope', A).lines.length, 1);
});

test('chooseProduct is refused once the cart is being filled or paid', async () => {
  const { svc, events } = setup();
  const t = await svc.note({ note: 'chleb', includeUsual: false });
  svc.answer(t.lines[0].lineKey, B);
  await svc.approve();
  await done(events);
  const before = svc.state().trip.lines;
  svc.chooseProduct(t.lines[0].lineKey, A);
  svc.proposalOp('x', 0, true);
  assert.deepEqual(svc.state().trip.lines, before);
});

test('dropUnmatched removes a term the user no longer wants listed', async () => {
  const { svc } = setup({ claude: { parse: { ops: [{ op: 'add', term: 'chleb', quantity: 1 }, { op: 'unmatched', term: 'kawior', hint: 'Dodaj ręcznie' }] }, choose: { ops: [] } } });
  const t = await svc.note({ note: 'chleb, kawior', includeUsual: false });
  assert.deepEqual(t.unmatched.map((u) => u.term), ['kawior']);
  assert.deepEqual(svc.dropUnmatched('kawior').unmatched, []);
});

test('note drops proposal ops that would change nothing and holds no proposal when none remain', async () => {
  const noop = { ops: [
    { op: 'choose', lineKey: 't:mleko', productId: A }, { op: 'setQuantity', lineKey: 't:mleko', quantity: 1 },
    { op: 'add', term: 'mleko', quantity: 1 },
  ] };
  const { svc } = setup({ claude: { parse: parseMilk, choose: noop } });
  const t = await svc.note({ note: 'mleko x2, chleb', includeUsual: false });
  assert.equal(t.proposal, null);
  assert.equal(t.step, 'zatwierdzenie');
});

test('note keeps only the real changes of a proposal', async () => {
  const mixed = { ops: [{ op: 'choose', lineKey: 't:mleko', productId: A }, { op: 'choose', lineKey: 't:mleko', productId: C }, { op: 'setQuantity', lineKey: 't:chleb', quantity: 1 }] };
  const { svc } = setup({ claude: { parse: parseMilk, choose: mixed } });
  const t = await svc.note({ note: 'mleko, chleb', includeUsual: false });
  assert.deepEqual(t.proposal?.ops, [{ op: 'choose', lineKey: 't:mleko', productId: C }]);
});

test('an unmatched op for a term that is already unmatched is dropped', async () => {
  const { svc } = setup({ claude: { parse: { ops: [{ op: 'add', term: 'zzz', quantity: 1 }, { op: 'add', term: 'chleb', quantity: 1 }] }, choose: { ops: [{ op: 'unmatched', term: 'zzz', hint: 'x' }] } } });
  const t = await svc.note({ note: 'zzz, chleb', includeUsual: false });
  assert.equal(t.proposal, null);
});

const searchEnd = (events: AppEvent[]) => new Promise<void>((resolve) => {
  const poll = () => (events.some((e) => e.type === 'search' && (e.status === 'done' || e.status === 'stopped')) ? resolve() : setImmediate(poll));
  poll();
});
const searchEvents = (events: AppEvent[]) => events.flatMap((e) => (e.type === 'search' ? [e] : []));

async function draftWithUnmatched(o: Parameters<typeof setup>[0] = {}) {
  const t = setup(o);
  await t.svc.note({ note: 'mleko\nparówki\nkawior', includeUsual: false });
  return t;
}

test('state lists the terms worth searching: unmatched ones and lines with no pick', async () => {
  const t = await draftWithUnmatched();
  assert.deepEqual(t.svc.state().search.terms, ['parówki', 'kawior']);
  assert.deepEqual(t.svc.state().search.recent, []);
});

test('searchAuchan runs in the background, saves what it finds and drafts only those terms', async () => {
  const log: string[] = [];
  const t = await draftWithUnmatched({ page: () => fakeSearchPage(undefined, { log }) });
  t.svc.line('t:mleko', { quantity: 5 });
  const before = t.svc.state().trip.lines.find((l) => l.lineKey === 't:mleko');
  const started = await t.svc.searchAuchan();
  assert.deepEqual(started, { started: true });
  assert.equal(t.svc.state().busy, 'search');
  await searchEnd(t.events);
  assert.equal(t.svc.state().busy, null);
  const trip = t.svc.state().trip;
  assert.deepEqual(trip.lines.find((l) => l.lineKey === 't:mleko'), before, 'the user\'s other line is untouched');
  assert.ok(trip.lines.some((l) => l.term === 'parówki'), 'found term drafted');
  assert.deepEqual(trip.unmatched.map((u) => u.term), ['kawior']);
  assert.equal(t.store.searchedRecently('parówki', new Date('2026-11-15T10:00:00Z')), true);
  assert.equal(t.store.searchedRecently('kawior', new Date('2026-11-15T10:00:00Z')), true, 'a search with no result is remembered too');
  assert.equal(t.store.searchedRecently('mleko', new Date('2026-11-15T10:00:00Z')), false);
  assert.equal(log.at(-1), 'closed');
  assert.match(trip.messages.at(-1)!, /1 z 2 haseł/);
});

test('search events report each status with the term, position and the result', async () => {
  const t = await draftWithUnmatched();
  await t.svc.searchAuchan();
  await searchEnd(t.events);
  const ev = searchEvents(t.events);
  assert.deepEqual(ev.filter((e) => e.status === 'searching').map((e) => [e.term, e.index, e.total]), [['parówki', 1, 2], ['kawior', 2, 2]]);
  assert.deepEqual(ev.at(-1), { type: 'search', status: 'done', found: 1, total: 2 });
  assert.deepEqual(t.svc.state().search.last, ev.at(-1));
});

test('login and captcha waits are announced', async () => {
  let logged = false, checks = 0;
  const page = fakeSearchPage();
  const slow: PageLike = {
    ...page,
    evaluate: (async (fn: any) => { if (String(fn).includes('isLoggedIn')) { checks++; return checks > 1; } return page.evaluate(fn); }) as PageLike['evaluate'],
  };
  const t = await draftWithUnmatched({ page: () => slow });
  await t.svc.searchAuchan(['parówki']);
  await searchEnd(t.events);
  assert.equal(searchEvents(t.events).some((e) => e.status === 'login'), true);
  logged = true; assert.ok(logged);
  let title = "Let's confirm you are human";
  const captcha: PageLike = { ...page, async title() { const x = title; title = 'Auchan'; return x; } };
  const t2 = await draftWithUnmatched({ page: () => captcha });
  await t2.svc.searchAuchan(['parówki']);
  await searchEnd(t2.events);
  assert.deepEqual(searchEvents(t2.events).find((e) => e.status === 'captcha'), { type: 'search', status: 'captcha', term: 'parówki' });
});

test('a 403 stops the search at once, with no retry, and says so', async () => {
  const log: string[] = [];
  const t = await draftWithUnmatched({ page: () => fakeSearchPage(undefined, { status: 403, log }) });
  await t.svc.searchAuchan();
  await searchEnd(t.events);
  assert.equal(searchEvents(t.events).at(-1)!.status, 'stopped');
  assert.equal(log.filter((u) => u.startsWith('http')).length, 1, 'one request (the home page), never repeated');
  assert.equal(log.filter((u) => u.includes('/search')).length, 0);
  assert.equal(t.svc.state().busy, null);
  assert.deepEqual(t.svc.state().trip.unmatched.map((u) => u.term), ['parówki', 'kawior']);
  assert.match(t.svc.state().trip.messages.at(-1)!, /zatrzymano/i);
});

test('terms searched in the last 7 days are skipped unless forced', async () => {
  const t = await draftWithUnmatched();
  await t.svc.searchAuchan();
  await searchEnd(t.events);
  t.events.length = 0;
  assert.deepEqual(t.svc.state().search.terms, []);
  assert.deepEqual(t.svc.state().search.recent, ['kawior']);
  const refused = await t.svc.searchAuchan(['kawior']);
  assert.equal(refused.started, false);
  assert.match(refused.reason!, /niedawno/);
  assert.deepEqual(await t.svc.searchAuchan(['kawior'], { force: true }), { started: true });
  await searchEnd(t.events);
  assert.equal(searchEvents(t.events).filter((e) => e.status === 'searching').length, 1);
});

test('at most 10 terms are searched', async () => {
  const log: string[] = [];
  const t = await draftWithUnmatched({ page: () => fakeSearchPage({}, { log }) });
  await t.svc.searchAuchan(Array.from({ length: 14 }, (_, i) => `rzecz${i}`));
  await searchEnd(t.events);
  assert.equal(log.filter((u) => u.includes('/search?q=')).length, 10);
});

test('search is refused while another operation runs, while the fill lock is held and with no synced orders', async () => {
  const t = await draftWithUnmatched();
  writeFileSync(t.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  assert.equal((await t.svc.searchAuchan()).started, false);
  rmSync(t.lockFile);
  const first = await t.svc.searchAuchan();
  assert.equal(first.started, true);
  assert.match((await t.svc.searchAuchan()).reason!, /trwa/i);
  assert.equal((await t.svc.sync()).started, false, 'sync waits too');
  assert.equal((await t.svc.approve()).started, false);
  await searchEnd(t.events);
  assert.equal(existsSync(t.lockFile), false, 'the lock is released afterwards');
  const none = await draftWithUnmatched({ region: false });
  const r = await none.svc.searchAuchan();
  assert.equal(r.started, false);
  assert.match(r.reason!, /zsynchronizuj/i);
});

test('the trip is frozen while searching', async () => {
  const t = await draftWithUnmatched();
  const before = t.svc.state().trip.lines.length;
  await t.svc.searchAuchan();
  const held = t.svc.line('t:mleko', { quantity: 9 });
  assert.equal(held.lines.find((l) => l.lineKey === 't:mleko')!.quantity, 1);
  assert.match(held.messages.at(-1)!, /szukanie/i);
  assert.equal(t.svc.reset().lines.length, before);
  await searchEnd(t.events);
});

test('after a search Claude is asked to choose for the re-drafted lines and the answer waits as a proposal', async () => {
  const parse = { ops: [{ op: 'add', term: 'mleko', quantity: 1 }, { op: 'add', term: 'parówki', quantity: 1 }] };
  const t = setup({ claude: { parse, choose: { ops: [] } } });
  await t.svc.note({ note: 'mleko\nparówki', includeUsual: false });
  t.spawned.length = 0;
  const t2 = t.svc;
  assert.deepEqual(t2.state().search.terms, ['parówki']);
  await t2.searchAuchan();
  await searchEnd(t.events);
  assert.deepEqual(t.spawned, ['choose']);
  assert.equal(t2.state().trip.mode, 'claude');
});

test('without Claude the re-drafted doubtful lines are asked about', async () => {
  const t = await draftWithUnmatched();
  await t.svc.searchAuchan(['parówki']);
  await searchEnd(t.events);
  const line = t.svc.state().trip.lines.find((l) => l.term === 'parówki')!;
  assert.ok(line.question !== null || line.confidence === 'high');
});

test('shutdown closes the browser and frees the lock', async () => {
  const log: string[] = [];
  let release!: () => void;
  const page = fakeSearchPage(undefined, { log });
  const gate = new Promise<void>((r) => { release = r; });
  const blocking: PageLike = { ...page, async goto(u) { await gate; return page.goto(u); }, async close() { log.push('closed'); release(); } };
  const t = await draftWithUnmatched({ page: () => blocking });
  await t.svc.searchAuchan();
  await new Promise((r) => setImmediate(r));
  t.svc.shutdown();
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(log.includes('closed'));
  assert.equal(existsSync(t.lockFile), false);
});

test('a new trip forgets the last search result', async () => {
  const t = await draftWithUnmatched();
  await t.svc.searchAuchan();
  await searchEnd(t.events);
  assert.equal(t.svc.state().search.last?.status, 'done');
  t.svc.reset();
  assert.equal(t.svc.state().search.last, null);
});
