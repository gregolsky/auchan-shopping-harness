import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/app/service.ts';
import type { AppEvent } from '../src/app/service.ts';
import type { Spawn } from '../src/app/claude.ts';
import { saveTrip } from '../src/app/trip.ts';
import { openStore, type Store } from '../src/store.ts';
import type { Worker } from '../src/worker.ts';
import type { CartAccess } from '../src/http-worker.ts';
import type { Product, PriceObservation } from '../src/types.ts';
import { fakeCart, type FakeCart } from './helpers/fake-cart.ts';

const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002', C = '00000000-0000-4000-8000-000000000003';
const mk = (id: string, name: string, brand = 'M'): Product => ({
  productId: id, retailerProductId: `r-${id}`, name, brand, categoryPath: ['X'], unitLabel: 'kg', size: '1 l', inCatalogue: true,
});
const price = (id: string, grosze: number): PriceObservation => ({
  productId: id, seenAt: new Date().toISOString(), regionId: 'r1', source: 'promotion',
  originalGrosze: null, currentGrosze: grosze, unitCurrentGrosze: grosze, offerText: null, requiredQuantity: null,
});

type Reply = object | null;
function setup(opts: { claude?: { parse?: Reply; choose?: Reply; adhoc?: Reply }; cart?: CartAccess & Partial<FakeCart>; seedHigh?: boolean; emit?: (e: AppEvent) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'svc-'));
  const lockFile = join(dir, 'fill.lock');
  const tripFile = join(dir, 'trip.json');
  const store = openStore(':memory:');
  store.savePromotions({
    regionId: 'r1',
    products: [mk(A, 'Mleko 2%'), mk(B, 'Chleb'), mk(C, 'Mleko 3%')],
    prices: [price(A, 199), price(B, 250), price(C, 210)],
  });
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
  const types = events.map((e) => e.type).filter((x) => x !== 'state' && x !== 'log');
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
