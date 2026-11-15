import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { main, formatReport, type FillDeps } from '../src/fill-cli.ts';
import { openStore, type Store } from '../src/store.ts';
import { Blocked, LoginRequired, type Worker } from '../src/worker.ts';
import type { CartAccess } from '../src/http-worker.ts';
import type { Product, PriceObservation } from '../src/types.ts';
import { fakeCart, type FakeCart } from './helpers/fake-cart.ts';

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
    products: [mk('a', 'Mleko 2%'), mk('b', 'Chleb'), mk('c', 'Mleko 3%')],
    prices: [price('a', 199), price('b', 250), price('c', 210)],
  });
  if (approve) s.approveBasket([{ term: 'mleko', productId: 'a', quantity: 2 }, { term: null, productId: 'b', quantity: 1 }], ['ser']);
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
  store.approveBasket([{ term: null, productId: 'a', quantity: 1 }], [], new Date(Date.now() - 25 * 3600_000));
  quiet(t, log);
  assert.equal(await main([], deps), 1);
  assert.equal(log.opened, 0);
});

test('fill prints progress and the report, and records a fill run', async (t) => {
  const cart = fakeCart({ b: 1 }, { outOfStock: ['a'] });
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
  assert.deepEqual(cart.quantities, { a: 2, b: 1 });
  assert.match(log.out.join('\n'), /Dodano produktów: 2\nRazem w koszyku: 3,00 zł/);
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
  assert.deepEqual(cart.quantities, { a: 2, b: 1 });
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
  assert.match(bad.log.err.join('\n'), /Fill failed: boom/);
  assert.match(bad.log.err.join('\n'), /bezpieczne/);
  assert.equal(bad.log.closed, 1);
});

test('formatReport puts check-before-paying first and never contains a cookie or token', () => {
  const line = { term: null, productId: 'a', name: 'Mleko', quantity: 2, approvedPriceGrosze: 199 };
  const text = formatReport({
    added: [line], alreadyEnough: [], extras: [], missing: [{ ...line, productId: 'm', name: 'Masło' }], outOfStock: [{ ...line, productId: 'o', name: 'Ser' }],
    checkBeforePaying: [{ productId: 'a', name: 'Mleko', approvedGrosze: 199, nowGrosze: 259, risePercent: 30.1 }],
    smallRises: [], cartTotalGrosze: 1259, sent: 1,
  }, ['jajka'], { m: ['Masło B', 'Masło C', 'Masło D'] });
  const lines = text.split('\n');
  assert.equal(lines[0], 'Sprawdź przed zapłatą:');
  assert.ok(text.indexOf('Brak w sklepie') < text.indexOf('Nie dodano'));
  assert.match(text, /Masło x 2 \(zamiast tego: Masło B; Masło C\)/);
  assert.match(text, /Razem w koszyku: 12,59 zł/);
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
  writeFileSync(busy.lockFile, String(process.pid));
  quiet(t, busy.log);
  assert.equal(await main([], busy.deps), 1);
  assert.equal(busy.log.opened, 0);
  assert.equal(existsSync(busy.lockFile), true); // not ours to remove
  assert.match(busy.log.err[0], /Inny fill/);

  const stale = setup(fakeCart({}));
  writeFileSync(stale.lockFile, '999999999');
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
