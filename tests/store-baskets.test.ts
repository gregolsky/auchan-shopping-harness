import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, type Store } from '../src/store.ts';
import type { Product, PriceObservation } from '../src/types.ts';

const mk = (id: string, inCatalogue = true): Product => ({
  productId: id, retailerProductId: `r-${id}`, name: `Produkt ${id}`, brand: 'M', categoryPath: ['X'], unitLabel: 'kg', size: '1 l', inCatalogue,
});
const price = (id: string, grosze: number): PriceObservation => ({
  productId: id, seenAt: '2026-10-30T10:00:00.000Z', regionId: 'r1', source: 'promotion',
  originalGrosze: null, currentGrosze: grosze, unitCurrentGrosze: grosze, offerText: null, requiredQuantity: null,
});

function withStore(fn: (s: Store, path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'baskets-'));
  const path = join(dir, 'h.db');
  const s = openStore(path);
  s.savePromotions({
    regionId: 'r1',
    products: [mk('a'), mk('b'), mk('gone', false), mk('noprice')],
    prices: [price('a', 199), price('b', 250), price('gone', 100)],
  });
  try { fn(s, path); } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('approveBasket stores lines with the current price and returns the total', () => {
  withStore((s) => {
    const r = s.approveBasket([{ term: 'mleko', productId: 'a', quantity: 1.5 }, { term: null, productId: 'b', quantity: 2 }], ['ser']);
    assert.equal(r.totalGrosze, Math.round(199 * 1.5 + 500));
    const b = s.latestApprovedBasket()!;
    assert.equal(b.basketId, r.basketId);
    assert.deepEqual(b.unmatched, ['ser']);
    assert.deepEqual(b.lines, [
      { term: 'mleko', productId: 'a', name: 'Produkt a', quantity: 1.5, approvedPriceGrosze: 199 },
      { term: null, productId: 'b', name: 'Produkt b', quantity: 2, approvedPriceGrosze: 250 },
    ]);
  });
});

test('approveBasket rejects an unknown product or one out of the catalogue, and stores nothing', () => {
  withStore((s, path) => {
    for (const id of ['nope', 'gone', 'noprice']) {
      assert.throws(() => s.approveBasket([{ term: null, productId: 'a', quantity: 1 }, { term: null, productId: id, quantity: 1 }], []), new RegExp(id));
    }
    assert.equal(s.latestApprovedBasket(), null);
    const db = new DatabaseSync(path, { readOnly: true });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM baskets').get() as any).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM basket_lines').get() as any).n, 0);
    db.close();
  });
});

test('latestApprovedBasket returns the newest basket and null after 24 hours', () => {
  withStore((s) => {
    const t = new Date('2026-11-01T10:00:00.000Z');
    s.approveBasket([{ term: null, productId: 'a', quantity: 1 }], [], t);
    const second = s.approveBasket([{ term: null, productId: 'b', quantity: 1 }], [], new Date(t.getTime() + 1000));
    assert.equal(s.latestApprovedBasket(new Date(t.getTime() + 3_600_000))?.basketId, second.basketId);
    assert.ok(s.latestApprovedBasket(new Date(t.getTime() + 1000 + 24 * 3_600_000)));
    assert.equal(s.latestApprovedBasket(new Date(t.getTime() + 1001 + 24 * 3_600_000)), null);
  });
});

test('fill runs record status and counts', () => {
  withStore((s, path) => {
    const { basketId } = s.approveBasket([{ term: null, productId: 'a', quantity: 1 }], []);
    const run = s.startFill(basketId);
    s.finishFill(run, { status: 'ok', sent: 3, missing: 1, checkBeforePaying: 2 });
    const db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare('SELECT * FROM fill_runs WHERE id = ?').get(run) as any;
    db.close();
    assert.equal(row.basket_id, basketId);
    assert.deepEqual([row.status, row.sent, row.missing, row.check_before_paying], ['ok', 3, 1, 2]);
    assert.ok(row.finished_at);
  });
});
