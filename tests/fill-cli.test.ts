import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { main, formatReport, structuredReport, interruptHandler, type FillDeps } from '../src/fill-cli.ts';
import { openStore, type Store } from '../src/store.ts';
import { Blocked, LoginRequired, type Worker } from '../src/worker.ts';
import type { CartAccess } from '../src/http-worker.ts';
import type { Product, PriceObservation } from '../src/types.ts';
import { fakeCart, type FakeCart } from './helpers/fake-cart.ts';

const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002', C = '00000000-0000-4000-8000-000000000003';
const mk = (id: string, name: string): Product => ({
  productId: id, retailerProductId: `r-${id}`, name, brand: 'M', categoryPath: ['X'], unitLabel: 'kg', size: '1 l', inCatalogue: true,
});
const price = (id: string, grosze: number): PriceObservation => ({
  productId: id, seenAt: new Date().toISOString(), regionId: 'r1', source: 'promotion',
  originalGrosze: null, currentGrosze: grosze, unitCurrentGrosze: grosze, offerText: null, requiredQuantity: null,
});

function seed(s: Store, approve = true) {
  s.savePromotions({
    regionId: 'r1',
    products: [mk(A, 'Mleko 2%'), mk(B, 'Chleb'), mk(C, 'Mleko 3%')],
    prices: [price(A, 199), price(B, 250), price(C, 210)],
  });
  if (approve) s.approveBasket([{ term: 'mleko', productId: A, quantity: 2 }, { term: null, productId: B, quantity: 1 }], ['ser']);
}

function setup(cart: CartAccess & Partial<FakeCart>, opts: { seed?: boolean; worker?: Partial<Worker> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fill-'));
  const lockFile = join(dir, 'fill.lock');
  const log = { out: [] as string[], err: [] as string[], opened: 0, closed: 0, lockDuring: [] as boolean[], waited: 0, finished: [] as object[] };
  const store = openStore(':memory:');
  if (opts.seed !== false) seed(store);
  const worker = {
    async getJson() { return {}; }, async graphql() { return {}; }, async pageState() { return {}; }, async pageLinks() { return []; },
    async close() { log.closed++; },
    async waitForLogin() { log.waited++; return true; },
    ...opts.worker,
    readCart: async () => (log.lockDuring.push(existsSync(lockFile)), cart.readCart()),
    applyQuantities: (c) => cart.applyQuantities(c),
  } as Worker & CartAccess;
  const deps: FillDeps = {
    lockFile,
    openWorker: async () => (log.opened++, worker),
    openStore: () => ({ ...store, close() {}, finishFill: (id: number, r: any) => (log.finished.push(r), store.finishFill(id, r)) }),
  };
  return { log, deps, store, lockFile };
}

function quiet(t: { mock: { method: Function } }, log: { out: string[]; err: string[] }) {
  t.mock.method(console, 'log', (s: string) => void log.out.push(s));
  t.mock.method(console, 'error', (s: string) => void log.err.push(s));
}

test('fill refuses with no approved basket', async (t) => {
  const { log, deps, lockFile } = setup(fakeCart({}), { seed: false });
  quiet(t, log);
  assert.equal(await main([], deps), 1);
  assert.equal(log.opened, 0);
  assert.match(log.err[0], /zatwierdzonego koszyka/);
  assert.equal(existsSync(lockFile), false);
});

test('fill refuses a basket older than 24 hours', async (t) => {
  const { log, deps, store } = setup(fakeCart({}), { seed: false });
  seed(store, false);
  store.approveBasket([{ term: null, productId: A, quantity: 1 }], [], new Date(Date.now() - 25 * 3600_000));
  quiet(t, log);
  assert.equal(await main([], deps), 1);
  assert.equal(log.opened, 0);
});

test('fill prints progress and the report, and records a fill run', async (t) => {
  const cart = fakeCart({ [B]: 1 }, { outOfStock: [A] });
  const { log, deps } = setup(cart);
  quiet(t, log);
  assert.equal(await main([], deps), 0);
  const text = log.out.join('\n');
  assert.match(text, /Dodawanie do koszyka: 1\/1/);
  assert.match(text, /Brak w sklepie:\n  - Mleko 2% x 2 \(zamiast tego: Mleko 3%\)/);
  assert.match(text, /Dodaj sam na Auchan:\n  - ser/);
  assert.match(text, /Było już w koszyku:\n  - Chleb x 1/);
  assert.match(text, /Dodano produktów: 0/);
  assert.ok(text.endsWith('Zapłać na https://zakupy.auchan.pl/checkout'));
  assert.equal(log.closed, 1);
  assert.deepEqual(log.finished, [{ status: 'ok', sent: 0, missing: 1, checkBeforePaying: 0 }]);
});

test('fill adds what is missing and counts it from the final cart', async (t) => {
  const cart = fakeCart({});
  const { log, deps } = setup(cart);
  quiet(t, log);
  assert.equal(await main([], deps), 0);
  assert.deepEqual(cart.quantities, { [A]: 2, [B]: 1 });
  assert.match(log.out.join('\n'), /Dodano produktów: 2\nRazem w koszyku: 3,00 zł/);
});

test('fill reports products blocked after an older basket was approved', async (t) => {
  const cart = fakeCart({});
  const { log, deps, store } = setup(cart);
  store.blockProduct(B);
  quiet(t, log);
  assert.equal(await main([], deps), 0);
  assert.deepEqual(cart.quantities, { [A]: 2 });
  assert.match(log.out.join('\n'), /Pominięto zablokowane produkty:[\s\S]*Chleb/);
});

test('a blocked product already in the cart is listed first under the pre-payment checks and never removed', async (t) => {
  const cart = fakeCart({ [C]: 1 });
  const { log, deps, store } = setup(cart);
  store.blockProduct(C);
  quiet(t, log);
  assert.equal(await main([], deps), 0);
  assert.match(log.out.join('\n'), /Sprawdź przed zapłatą:\n  - Mleko 3% — zablokowany produkt w koszyku, usuń go na Auchan\n/);
  assert.equal(cart.quantities[C], 1);
  assert.equal(cart.applyCalls.flat().some((c) => c.productId === C), false);
});

test('formatReport lists blocked cart products before price warnings', () => {
  const report: any = { added: [], alreadyEnough: [], extras: [], missing: [], outOfStock: [], smallRises: [], cartTotalGrosze: 100, sent: 0,
    checkBeforePaying: [{ productId: A, name: 'Mleko', approvedGrosze: 100, nowGrosze: 200, risePercent: 100 }] };
  const text = formatReport(report, [], {}, {}, ['Chleb']);
  assert.match(text, /Sprawdź przed zapłatą:\n  - Chleb — zablokowany produkt w koszyku, usuń go na Auchan\n  - Mleko:/);
});

test('structured payment report carries product ids, quantities, prices and categories as fields', () => {
  const line = { term: 'mleko', productId: A, name: 'Mleko', quantity: 2, approvedPriceGrosze: 199 };
  const report: any = { added: [line], alreadyEnough: [], extras: [{ productId: B, quantity: 1, unitPriceGrosze: 350, lineTotalGrosze: 350 }], missing: [], outOfStock: [],
    checkBeforePaying: [{ productId: A, name: 'Mleko', approvedGrosze: 199, nowGrosze: 259, risePercent: 30.1 }], smallRises: [], cartTotalGrosze: 869, sent: 1, limits: {} };
  const data = structuredReport(report, ['chleb'], {}, { [B]: 'Ser' }, [{ productId: B, name: 'Ser' }], [], { [A]: ['Artykuły spożywcze', 'Mleko, nabiał i jaja'] });
  const warning = data.sections.find((s) => s.title === 'Sprawdź przed zapłatą')!;
  const price = warning.items.find((r) => r.productId === A)!;
  assert.equal(price.quantity, 2);
  assert.equal(price.approvedGrosze, 199);
  assert.equal(price.nowGrosze, 259);
  assert.deepEqual(price.categoryPath, ['Artykuły spożywcze', 'Mleko, nabiał i jaja']);
  assert.equal(warning.items.find((r) => r.productId === B)?.note, 'Zablokowany produkt w koszyku — usuń go na Auchan.');
  const extra = data.sections.find((s) => s.title === 'Było już w koszyku')!.items[0];
  assert.equal(extra.quantity, 1);
  assert.equal(extra.unitPriceGrosze, 350);
  assert.equal(extra.priceSource, 'cart');
  assert.deepEqual(data.summary, { addedCount: 1, cartTotalGrosze: 869 });
});

test('fill resumes after login', async (t) => {
  const cart = fakeCart({});
  let first = true;
  const real = cart.readCart;
  cart.readCart = async () => {
    if (first) { first = false; throw new LoginRequired(); }
    return real();
  };
  const { log, deps } = setup(cart);
  quiet(t, log);
  assert.equal(await main([], deps), 0);
  assert.equal(log.waited, 1);
  assert.deepEqual(cart.quantities, { [A]: 2, [B]: 1 });
});

test('the lock file exists during the fill and is gone afterwards, also after a failure', async (t) => {
  const ok = setup(fakeCart({}));
  quiet(t, ok.log);
  await main([], ok.deps);
  assert.ok(ok.log.lockDuring.length > 0 && ok.log.lockDuring.every(Boolean));
  assert.equal(existsSync(ok.lockFile), false);

  const cart = fakeCart({});
  cart.applyQuantities = async () => { throw new Error('boom'); };
  const bad = setup(cart);
  quiet(t, bad.log);
  assert.equal(await main([], bad.deps), 1);
  assert.ok(bad.log.lockDuring.every(Boolean));
  assert.equal(existsSync(bad.lockFile), false);
  assert.match(bad.log.err.join('\n'), /Fill failed unexpectedly\./);
  assert.match(bad.log.err.join('\n'), /bezpieczne/);
  assert.equal(bad.log.closed, 1);
});

test('formatReport puts check-before-paying first and never contains a cookie or token', () => {
  const line = { term: null, productId: A, name: 'Mleko', quantity: 2, approvedPriceGrosze: 199 };
  const text = formatReport({
    added: [line], alreadyEnough: [], extras: [], missing: [{ ...line, productId: 'm', name: 'Masło' }], outOfStock: [{ ...line, productId: 'o', name: 'Ser' }],
    limits: { m: { reason: 'MAX_QUANTITY', added: 1, requested: 3 } },
    checkBeforePaying: [{ productId: A, name: 'Mleko', approvedGrosze: 199, nowGrosze: 259, risePercent: 30.1 }],
    smallRises: [], cartTotalGrosze: 1259, sent: 1,
  }, ['jajka'], { m: ['Masło B', 'Masło C', 'Masło D'] });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Sprawdź przed zapłatą:');
  assert.ok(text.indexOf('Brak w sklepie') < text.indexOf('Nie dodano'));
  assert.match(text, /Masło x 2 — dodano 1 z 3 \(powód: MAX_QUANTITY\) \(zamiast tego: Masło B; Masło C\)/);
  assert.match(text, /Razem w koszyku: 12,59 zł/);
  assert.match(text, /Mleko: 1,99 zł -> 2,59 zł \(\+30,1%\)/);
  assert.equal(lines.at(-1), 'Zapłać na https://zakupy.auchan.pl/checkout');
  assert.doesNotMatch(text, /cookie|token|session/i);
});

test('a 403 never invites a rerun', async (t) => {
  const cart = fakeCart({});
  cart.applyQuantities = async () => { throw new Blocked('403'); };
  const { log, deps } = setup(cart);
  quiet(t, log);
  assert.equal(await main([], deps), 1);
  assert.match(log.err.join('\n'), /Do not rerun/);
  assert.doesNotMatch(log.err.join('\n'), /bezpieczne/);
});

test('a second fill is refused while a live pid holds the lock, a stale lock is replaced', async (t) => {
  const busy = setup(fakeCart({}));
  writeFileSync(busy.lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  quiet(t, busy.log);
  assert.equal(await main([], busy.deps), 1);
  assert.equal(busy.log.opened, 0);
  assert.equal(existsSync(busy.lockFile), true); // not ours to remove
  assert.match(busy.log.err[0], /Inny fill/);
  assert.match(busy.log.err[0], /\.state\/fill\.lock/);
  assert.match(busy.log.err[0], /usuń/);

  const stale = setup(fakeCart({}));
  writeFileSync(stale.lockFile, JSON.stringify({ pid: 999999999, startedAt: Date.now() }));
  quiet(t, stale.log);
  assert.equal(await main([], stale.deps), 0);
  assert.equal(existsSync(stale.lockFile), false);
});

test('the lock is removed even when close throws', async (t) => {
  const s = setup(fakeCart({}), { worker: { close: async () => { throw new Error('close failed'); } } });
  quiet(t, s.log);
  await main([], s.deps).catch(() => {});
  assert.equal(existsSync(s.lockFile), false);
});

test('two fills started together never double the quantities: one refuses', async (t) => {
  const cart = fakeCart({});
  const one = setup(cart);
  const two = setup(cart);
  two.deps.lockFile = one.lockFile;
  quiet(t, one.log);
  quiet(t, two.log);
  const codes = await Promise.all([main([], one.deps), main([], two.deps)]);
  assert.deepEqual([...codes].sort(), [0, 1]);
  assert.deepEqual(cart.quantities, { [A]: 2, [B]: 1 });
  assert.equal(one.log.opened + two.log.opened, 1);
  assert.equal(existsSync(one.lockFile), false);
});

test('giving up on login warns that some products may already be in the cart, and exits 1', async (t) => {
  const cart = fakeCart({});
  cart.readCart = async () => { throw new LoginRequired(); };
  const { log, deps } = setup(cart, { worker: { waitForLogin: async () => false } });
  quiet(t, log);
  assert.equal(await main([], deps), 1);
  assert.ok(log.err.includes('Nie zalogowano: wypełnianie przerwane. Część produktów mogła już trafić do koszyka; ponowne uruchomienie doda tylko to, czego brakuje.'));
  assert.deepEqual(log.finished, [{ status: 'failed', sent: 0, missing: 0, checkBeforePaying: 0 }]);
});

test('a login needed on the second batch restarts from a fresh read and adds nothing twice', async (t) => {
  const ids = Array.from({ length: 15 }, (_, i) => `00000000-0000-4000-8000-${(100 + i).toString(16).padStart(12, '0')}`);
  const cart = fakeCart({});
  const s = setup(cart, { seed: false });
  s.store.savePromotions({
    regionId: 'r1',
    products: ids.map((id, i) => mk(id, `P${i}`)),
    prices: ids.map((id) => price(id, 100)),
  });
  s.store.approveBasket(ids.map((id, i) => ({ term: null, productId: id, quantity: i + 1 })), []);
  const real = cart.applyQuantities;
  let calls = 0;
  cart.applyQuantities = async (c) => {
    if (++calls === 2) throw new LoginRequired();
    return real(c);
  };
  quiet(t, s.log);
  assert.equal(await main([], s.deps), 0);
  assert.equal(s.log.waited, 1);
  assert.deepEqual(cart.quantities, Object.fromEntries(ids.map((id, i) => [id, i + 1])));
  const text = s.log.out.join('\n');
  assert.match(text, /Dodano produktów: 15/);
  assert.doesNotMatch(text, /Było już w koszyku/);
  assert.deepEqual(s.log.finished, [{ status: 'ok', sent: 15, missing: 0, checkBeforePaying: 0 }]);
});

test('the plan total is printed once, before the first apply', async (t) => {
  const cart = fakeCart({});
  const { log, deps } = setup(cart);
  const real = cart.applyQuantities;
  cart.applyQuantities = async (c) => (log.out.push('APPLY'), real(c));
  quiet(t, log);
  assert.equal(await main([], deps), 0);
  assert.equal(log.out.indexOf('Do dodania: 2 produktów, ok. 6,48 zł'), 0);
  assert.equal(log.out.filter((l) => l.startsWith('Do dodania')).length, 1);
  assert.ok(log.out.indexOf('APPLY') > 0);
});

test('the interrupt handler removes the lock we own, marks the run failed and exits 130', () => {
  const dir = mkdtempSync(join(tmpdir(), 'int-'));
  const lockFile = join(dir, 'fill.lock');
  writeFileSync(lockFile, 'mine');
  const calls: string[] = [];
  const handler = interruptHandler({ lockFile, token: 'mine', owns: () => true, markFailed: () => calls.push('failed') }, (c) => calls.push(`exit ${c}`));
  handler();
  assert.equal(existsSync(lockFile), false);
  assert.deepEqual(calls, ['failed', 'exit 130']);
});

test('the interrupt handler leaves a lock we do not own alone, and still exits 130 even if marking fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'int-'));
  const lockFile = join(dir, 'fill.lock');
  writeFileSync(lockFile, '{}');
  const calls: string[] = [];
  interruptHandler({ lockFile, token: '{}', owns: () => false, markFailed: () => { throw new Error('db closed'); } }, (c) => calls.push(`exit ${c}`))();
  assert.equal(existsSync(lockFile), true);
  assert.deepEqual(calls, ['exit 130']);
});

test('a fill installs SIGINT, SIGTERM and SIGHUP handlers and removes them afterwards', async (t) => {
  const { log, deps } = setup(fakeCart({}));
  quiet(t, log);
  const during: number[] = [];
  const before = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => process.listenerCount(s));
  const orig = deps.openWorker;
  deps.openWorker = async () => {
    during.push(...(['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => process.listenerCount(s)));
    return orig();
  };
  assert.equal(await main([], deps), 0);
  assert.deepEqual(during, before.map((n) => n + 1));
  assert.deepEqual((['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((s) => process.listenerCount(s)), before);
});

test('formatReport strips terminal and bidi control characters from every untrusted text', () => {
  const dirty = (n: string) => `${n}\u001b]52;c;ZXZpbA==\u0007\u202e`;
  const line = (id: string, name: string) => ({ term: null, productId: id, name, quantity: 1, approvedPriceGrosze: 100 });
  const text = formatReport({
    added: [], alreadyEnough: [line('e', dirty('Jaja'))], extras: [], missing: [line('m', dirty('Masło'))], outOfStock: [line('o', dirty('Ser'))],
    limits: { m: { reason: dirty('MAX'), added: 1, requested: 3 } },
    checkBeforePaying: [{ productId: 'c', name: dirty('Mleko'), approvedGrosze: 100, nowGrosze: 200, risePercent: 100 }],
    smallRises: [], cartTotalGrosze: 100, sent: 0,
  }, [dirty('ser żółty')], { m: [dirty('Masło B')] }, {});
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  for (const w of ['Jaja', 'Masło', 'Ser', 'Mleko', 'MAX', 'ser żółty', 'Masło B']) assert.ok(text.includes(w), w);
});

test('a single refused line stops the fill, names the product and records how many were sent', async (t) => {
  const cart = fakeCart({}, { reject: [B] });
  const { log, deps } = setup(cart);
  quiet(t, log);
  assert.equal(await main([], deps), 1);
  const err = log.err.join('\n');
  assert.match(err, /Auchan odrzucił zmianę koszyka \(Chleb\); zatrzymano\./);
  assert.match(err, /sprawdź koszyk, usuń ten produkt z listy i uruchom ponownie/);
  assert.doesNotMatch(err, /Ponowne uruchomienie jest bezpieczne/);
  assert.equal(log.finished.length, 1);
  assert.deepEqual(log.finished[0], { status: 'failed', sent: 1, missing: 0, checkBeforePaying: 0 });
});

test('the interrupt handler does not remove a lock someone else took over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'int-'));
  const lockFile = join(dir, 'fill.lock');
  writeFileSync(lockFile, 'theirs');
  interruptHandler({ lockFile, token: 'mine', owns: () => true, markFailed() {} }, () => {})();
  assert.equal(existsSync(lockFile), true);
});

test('a fill leaves a lock that another process took over in the meantime', async (t) => {
  const { log, deps, lockFile } = setup(fakeCart({}));
  quiet(t, log);
  const orig = deps.openWorker;
  deps.openWorker = async () => (writeFileSync(lockFile, 'theirs'), orig());
  assert.equal(await main([], deps), 0);
  assert.equal(readFileSync(lockFile, 'utf8'), 'theirs');
});

test('a fill records the cart order id on its run', async (t) => {
  const cart = fakeCart({});
  const read = cart.readCart.bind(cart);
  cart.readCart = async () => ({ ...(await read() as object), defaultCheckoutGroup: { orderId: '1000000000123' } });
  const { log, deps, store } = setup(cart);
  quiet(t, log);
  assert.equal(await main([], deps), 0);
  assert.deepEqual(store.fillOrderIdsNotInOrders(), ['1000000000123']);
});

test('structured report rows are clamped: names to 200, plan quantities to 20, cart quantities to 1000, control characters removed', () => {
  const line = { term: 'x', productId: A, name: `Mleko\u0007${'a'.repeat(300)}`, quantity: 50, approvedPriceGrosze: 199 };
  const report: any = { added: [], alreadyEnough: [line], extras: [{ productId: B, quantity: 5000, unitPriceGrosze: 350, lineTotalGrosze: 350 }], missing: [], outOfStock: [],
    checkBeforePaying: [], smallRises: [], cartTotalGrosze: 869, sent: 1, limits: {} };
  const deep = Array.from({ length: 12 }, (_, i) => `Poziom\u0007${i}${'k'.repeat(150)}`);
  const data = structuredReport(report, ['n'.repeat(300)], {}, { [B]: `Ser\u001b[31m${'b'.repeat(300)}` }, [], [], { [A]: deep, [B]: deep });
  const rows = data.sections.flatMap((s) => s.items);
  for (const row of rows) {
    assert.ok(row.name.length <= 200);
    assert.doesNotMatch(row.name, /[\u0000-\u001f]/);
    assert.ok((row.quantity ?? 0) <= 1000);
    if (row.categoryPath) { assert.equal(row.categoryPath.length, 8); assert.ok(row.categoryPath.every((p) => p.length <= 120 && !/[\u0000-\u001f]/.test(p))); }
  }
  assert.equal(rows.find((r) => r.productId === A)!.quantity, 20);
  assert.equal(rows.find((r) => r.productId === B)!.quantity, 1000);
});
