import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type SearchDeps } from '../src/search-cli.ts';
import { openStore, type Store } from '../src/store.ts';
import type { SearchResult, SearchStatus } from '../src/search-browser.ts';
import { ProfileBusy } from '../src/worker.ts';
import { BUSY } from '../src/fill-cli.ts';

const state = JSON.parse(readFileSync(new URL('./fixtures/search-state.json', import.meta.url), 'utf8'));
const REGION = '00000000-0000-4000-8000-000000000010';

function setup(opts: { region?: string | null; results: (terms: string[], say: (s: SearchStatus) => void) => SearchResult[] }) {
  const dir = mkdtempSync(join(tmpdir(), 'search-cli-'));
  const store = openStore(join(dir, 'h.db'));
  if (opts.region !== null) {
    store.saveOrder({
      order: { orderId: 'o1', deliveredAt: '2026-11-01T10:00:00Z', totalGrosze: 100, regionId: opts.region ?? REGION },
      lines: [], products: [], prices: [],
    });
  }
  const searched: string[][] = [];
  const out: string[] = [];
  const err: string[] = [];
  let closed = 0;
  const deps: SearchDeps = {
    openStore: () => ({ ...store, close() {} }) as Store,
    createSearch: (onStatus) => ({
      async search(terms) { searched.push(terms); return opts.results(terms, onStatus); },
      async close() { closed++; },
    }),
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    lockFile: join(dir, 'fill.lock'),
  };
  return { deps, dir, store, out, err, searched, closed: () => closed, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('searches, saves, and prints Polish status and the planner top match', async () => {
  const t = setup({ results: (terms, say) => { say({ kind: 'captcha', term: terms[0] }); say({ kind: 'searching', term: terms[0], index: 1, total: 1 }); return [{ term: terms[0], status: 'found', state }]; } });
  try {
    const code = await main(['parówki'], t.deps);
    assert.equal(code, 0);
    const text = t.out.join('\n');
    assert.match(text, /Rozwiąż weryfikację w oknie przeglądarki/);
    assert.match(text, /Szukam: parówki \(1\/1\)/);
    assert.match(text, /parówki: znaleziono 4 produkty/);
    assert.match(text, /parówki: najlepsze dopasowanie: Parówki .* Testowo/);
    assert.equal(t.store.searchedRecently('parówki', new Date()), true);
    assert.equal(t.closed(), 1);
  } finally { t.done(); }
});

test('a term searched recently is skipped unless --force', async () => {
  const t = setup({ results: (terms) => terms.map((term) => ({ term, status: 'found' as const, state })) });
  try {
    await main(['parówki'], t.deps);
    t.out.length = 0;
    assert.equal(await main(['parówki'], t.deps), 0);
    assert.equal(t.searched.length, 1);
    assert.match(t.out.join('\n'), /szukano niedawno/);
    assert.match(t.out.join('\n'), /najlepsze dopasowanie/);
    await main(['parówki', '--force'], t.deps);
    assert.equal(t.searched.length, 2);
  } finally { t.done(); }
});

test('a stopped search says so and exits 1; nothing saved for it', async () => {
  const t = setup({ results: (terms) => terms.map((term) => ({ term, status: 'stopped' as const })) });
  try {
    assert.equal(await main(['a', 'b'], t.deps), 1);
    assert.match(t.out.concat(t.err).join('\n'), /a: zatrzymano/);
    assert.equal(t.store.searchedRecently('a', new Date()), false);
  } finally { t.done(); }
});

test('no results is reported', async () => {
  const t = setup({ results: (terms) => terms.map((term) => ({ term, status: 'none' as const })) });
  try {
    assert.equal(await main(['xyz'], t.deps), 0);
    assert.match(t.out.join('\n'), /xyz: nie znaleziono produktów/);
  } finally { t.done(); }
});

test('a page for another region is not saved', async () => {
  const t = setup({ region: 'other-region', results: (terms) => terms.map((term) => ({ term, status: 'found' as const, state })) });
  try {
    assert.equal(await main(['parówki'], t.deps), 1);
    assert.match(t.err.join('\n'), /region/);
    assert.equal(t.store.searchedRecently('parówki', new Date()), false);
  } finally { t.done(); }
});

test('without orders synced, refuses before opening a browser', async () => {
  const t = setup({ region: null, results: () => assert.fail('no browser') });
  try {
    assert.equal(await main(['a'], t.deps), 1);
    assert.match(t.err.join('\n'), /zamówienia/);
  } finally { t.done(); }
});

test('usage without terms; more than 10 terms are cut', async () => {
  const t = setup({ results: (terms) => terms.map((term) => ({ term, status: 'none' as const })) });
  try {
    assert.equal(await main([], t.deps), 2);
    assert.equal(await main(Array.from({ length: 12 }, (_, i) => `t${i}`), t.deps), 0);
    assert.equal(t.searched[0].length, 10);
    assert.match(t.err.join('\n'), /10/);
  } finally { t.done(); }
});

test('takes the fill lock for the run and releases it afterwards', async () => {
  let during = false;
  const t = setup({ results: (terms) => { during = existsSync(t.deps.lockFile!); return terms.map((term) => ({ term, status: 'none' as const })); } });
  try {
    assert.equal(await main(['xyz'], t.deps), 0);
    assert.equal(during, true);
    assert.equal(existsSync(t.deps.lockFile!), false);
  } finally { t.done(); }
});

test('refuses with the BUSY text when the fill lock is held, and leaves the lock alone', async () => {
  const t = setup({ results: () => assert.fail('no browser') });
  try {
    writeFileSync(t.deps.lockFile!, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
    assert.equal(await main(['a'], t.deps), 1);
    assert.deepEqual(t.err, [BUSY]);
    assert.equal(existsSync(t.deps.lockFile!), true);
  } finally { t.done(); }
});

test('a busy profile is explained in Polish, exits 1, closes the search and frees the lock', async () => {
  const t = setup({ results: () => { throw new ProfileBusy(); } });
  try {
    assert.equal(await main(['a'], t.deps), 1);
    assert.deepEqual(t.err, ['Zamknij inne okno przeglądarki z profilem zakupów i spróbuj ponownie.']);
    assert.equal(t.closed(), 1);
    assert.equal(existsSync(t.deps.lockFile!), false);
  } finally { t.done(); }
});

test('any other failure is a Polish message with exit 1, not a stack trace', async () => {
  const t = setup({ results: () => { throw new Error('boom'); } });
  try {
    assert.equal(await main(['a'], t.deps), 1);
    assert.match(t.err.join('\n'), /Wyszukiwanie nie powiodło się: boom/);
    assert.equal(existsSync(t.deps.lockFile!), false);
  } finally { t.done(); }
});
