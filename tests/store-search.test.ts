import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.ts';
import { parseSearchState } from '../src/parse.ts';

const state = JSON.parse(readFileSync(new URL('./fixtures/search-state.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-11-15T10:00:00Z');
const withDb = (fn: (path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), 'store-search-'));
  try { fn(join(dir, 'h.db')); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('saveSearchResults stores products, search prices and the run', () => {
  withDb((path) => {
    const s = openStore(path);
    const parsed = parseSearchState(state, 'parówki', NOW.toISOString());
    s.saveSearchResults('Parówki', parsed, NOW);
    const facts = s.productFacts();
    assert.equal(facts.length, 4);
    assert.equal(facts.filter((f) => f.inCatalogue).length, 3);
    assert.equal(facts.find((f) => f.name.includes('klasyczne'))!.latestPriceGrosze, 497);
    s.close();
    const db = new DatabaseSync(path);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE source = 'search'").get() as any).n, 4);
    assert.deepEqual({ ...(db.prepare('SELECT term, searched_at, found FROM search_runs').get() as object) }, { term: 'parowki', searched_at: NOW.toISOString(), found: 4 });
    db.close();
  });
});

test('a term searched within 7 days is recent, unless older; terms are normalised', () => {
  withDb((path) => {
    const s = openStore(path);
    assert.equal(s.searchedRecently('parówki', NOW), false);
    s.saveSearchResults('parówki', parseSearchState(state, 'parówki', NOW.toISOString()), NOW);
    assert.equal(s.searchedRecently('PAROWKI', new Date('2026-11-21T09:00:00Z')), true);
    assert.equal(s.searchedRecently('parówki', new Date('2026-11-22T11:00:00Z')), false);
    assert.equal(s.searchedRecently('mleko', NOW), false);
    s.close();
  });
});

test('a search with no results is still recorded; a bad region stores nothing', () => {
  withDb((path) => {
    const s = openStore(path);
    s.saveSearchResults('xyz', { regionId: 'r', products: [], prices: [] }, NOW);
    assert.equal(s.searchedRecently('xyz', NOW), true);
    const parsed = parseSearchState(state, 'p', NOW.toISOString());
    parsed.prices[1].regionId = 'other';
    assert.throws(() => s.saveSearchResults('p', parsed, NOW));
    assert.equal(s.searchedRecently('p', NOW), false);
    assert.equal(s.productFacts().length, 0);
    s.close();
  });
});

test('an old database gets search support and keeps its data', () => {
  withDb((path) => {
    openStore(path).close();
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE search_runs; DROP INDEX price_history_observation; DROP INDEX price_history_source_seen; DROP TABLE price_history');
    db.exec(`CREATE TABLE price_history (
      product_id TEXT NOT NULL REFERENCES products(product_id), seen_at TEXT NOT NULL, seen_day TEXT NOT NULL, region_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('order', 'promotion')), original_grosze INTEGER, current_grosze INTEGER NOT NULL,
      unit_current_grosze INTEGER, offer_text TEXT, required_quantity INTEGER)`);
    db.exec(`INSERT INTO products VALUES ('old','r','Stary','stary','B','[]',NULL,NULL,1,NULL,NULL)`);
    db.exec(`INSERT INTO price_history VALUES ('old','2026-10-01T00:00:00Z','2026-10-01','r','promotion',NULL,100,NULL,NULL,NULL)`);
    db.close();
    const s = openStore(path);
    s.saveSearchResults('parówki', parseSearchState(state, 'parówki', NOW.toISOString()), NOW);
    assert.equal(s.productFacts().length, 5);
    assert.equal(s.productFacts().find((f) => f.productId === 'old')!.latestPriceGrosze, 100);
    s.close();
    const chk = new DatabaseSync(path);
    assert.equal((chk.prepare('SELECT COUNT(*) AS n FROM price_history').get() as any).n, 5);
    assert.ok(chk.prepare("SELECT 1 FROM sqlite_master WHERE name = 'price_history_observation'").get());
    chk.close();
  });
});

test('a read-only handle on an old database without search_runs reports not searched', () => {
  withDb((path) => {
    openStore(path).close();
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE search_runs');
    db.close();
    const s = openStore(path, { readOnly: true });
    assert.equal(s.searchedRecently('x', NOW), false);
    s.close();
  });
});

test('a search refusal blocks searching for 24 hours, then expires', () => {
  withDb((path) => {
    const s = openStore(path);
    assert.equal(s.searchBlock(NOW), null);
    s.blockSearch(403, NOW);
    assert.deepEqual(s.searchBlock(new Date('2026-11-16T09:59:00Z')), { until: '2026-11-16T10:00:00.000Z', status: 403 });
    assert.equal(s.searchBlock(new Date('2026-11-16T10:00:00Z')), null);
    s.close();
    assert.deepEqual(openStore(path).searchBlock(new Date('2026-11-15T12:00:00Z')), { until: '2026-11-16T10:00:00.000Z', status: 403 }, 'it survives a restart');
  });
});

test('the search keeps the found product ids in Auchan\'s order per normalised term, and a newer search replaces them', () => {
  withDb((path) => {
    const s = openStore(path);
    assert.deepEqual(s.searchResults(), {});
    const parsed = parseSearchState(state, 'Parówki', NOW.toISOString());
    s.saveSearchResults('Parówki', parsed, NOW);
    assert.deepEqual(s.searchResults(), { parowki: parsed.products.map((p) => p.productId) });
    s.saveSearchResults('parówki', { regionId: parsed.regionId, products: [], prices: [] }, new Date('2026-11-16T10:00:00Z'));
    assert.deepEqual(s.searchResults(), {});
    s.close();
  });
});
