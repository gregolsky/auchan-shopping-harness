// A whole app for browser tests: the real server, service and page, with scripted Claude, a fake Auchan worker and an
// in-memory cart. Nothing here reaches Auchan, Anthropic or the user's .state.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { chromium, type Browser } from 'playwright-core';
import { createAppServer, createBroadcaster, listenAlso } from '../src/app/server.ts';
import { createService } from '../src/app/service.ts';
import type { Spawn } from '../src/app/claude.ts';
import { openStore } from '../src/store.ts';
import type { Product, PriceObservation } from '../src/types.ts';
import type { Worker } from '../src/worker.ts';
import type { CartAccess } from '../src/http-worker.ts';
import { fakeCart, type FakeCart } from '../tests/helpers/fake-cart.ts';

export const TOKEN = 'e'.repeat(32);
export const PHONE_HOST = '127.0.0.2'; // a second loopback address stands in for the Wi-Fi one

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const P = { milk2: id(1), milk3: id(2), milkLaciate: id(3), breadWheat: id(4), breadRye: id(5), butter: id(6), yogurt: id(7) };
const DAIRY = ['Artykuły spożywcze', 'Mleko, nabiał i jaja', 'Mleko'];
const BREAD = ['Artykuły spożywcze', 'Pieczywo i wyroby cukiernicze', 'Chleb'];
const product = (productId: string, name: string, categoryPath: string[]): Product => ({
  productId, retailerProductId: `r${productId.slice(-4)}`, name, brand: 'Auchan', categoryPath, unitLabel: 'szt.', size: '1 szt.', inCatalogue: true,
});
const PRODUCTS = [
  product(P.milk2, 'Mleko UHT 2% Auchan 1 l', DAIRY),
  product(P.milk3, 'Mleko UHT 3,2% Auchan 1 l', DAIRY),
  product(P.milkLaciate, 'Mleko UHT 3,2% Łaciate 1 l', DAIRY),
  product(P.breadWheat, 'Chleb pszenny krojony 500 g', BREAD),
  product(P.breadRye, 'Chleb żytni razowy 500 g', BREAD),
  product(P.butter, 'Masło ekstra 82% Auchan 200 g', DAIRY),
  product(P.yogurt, 'Jogurt naturalny Auchan 400 g', DAIRY),
];
const GROSZE: Record<string, number> = { [P.milk2]: 299, [P.milk3]: 329, [P.milkLaciate]: 419, [P.breadWheat]: 549, [P.breadRye]: 699, [P.butter]: 799, [P.yogurt]: 349 };

/** What scripted Claude answers for each of its three tasks; null makes it "not installed" (the app's fallback mode). */
export interface ClaudeScript { parse: object | null; choose: object | null; adhoc: object | null }
export const DEFAULT_CLAUDE: ClaudeScript = {
  parse: { ops: [{ op: 'add', term: 'mleko', quantity: 2 }, { op: 'add', term: 'chleb', quantity: 1 }, { op: 'add', term: 'masło', quantity: 1 }] },
  choose: { ops: [{ op: 'ask', lineKey: 't:chleb', question: 'Który chleb wybrać?', options: [P.breadWheat, P.breadRye] }] },
  adhoc: { ops: [{ op: 'add', term: 'jogurt', quantity: 2 }] },
};

export interface App { url: string; phoneUrl: string; cart: FakeCart; close(): Promise<void> }

export async function startApp(claude: ClaudeScript = DEFAULT_CLAUDE): Promise<App> {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-app-'));
  const store = openStore(join(dir, 'harness.db'));
  const now = new Date().toISOString();
  const price = (productId: string): PriceObservation => ({
    productId, seenAt: now, regionId: 'r1', source: 'promotion', originalGrosze: null, currentGrosze: GROSZE[productId]!, unitCurrentGrosze: GROSZE[productId]!, offerText: null, requiredQuantity: null,
  });
  store.savePromotions({ regionId: 'r1', products: PRODUCTS, prices: PRODUCTS.map((p) => price(p.productId)) });
  store.saveOrder({ order: { orderId: '1000000000001', deliveredAt: now, totalGrosze: 100, regionId: '00000000-0000-4000-8000-000000000010' }, lines: [], products: [], prices: [] });

  const spawn: Spawn = async (_cmd, _args, input) => {
    const task = input.includes('Task: turn the note') ? 'parse' : input.includes('Task: use the user input') ? 'choose' : 'adhoc';
    const reply = claude[task];
    if (reply === null) return { code: null, stdout: '', timedOut: false, missing: true };
    return { code: 0, stdout: JSON.stringify({ structured_output: reply }), timedOut: false, missing: false };
  };
  const cart = fakeCart({});
  const worker = {
    async getJson() { return {}; }, async graphql() { return {}; }, async pageState() { return {}; }, async pageLinks() { return []; },
    async close() {}, async waitForLogin() { return true; },
    readCart: () => cart.readCart(), applyQuantities: (c) => cart.applyQuantities(c),
  } as Worker & CartAccess;
  const shared = () => ({ ...store, close() {} });
  const broadcaster = createBroadcaster();
  const service = createService({
    openStore: shared, spawn, tripFile: join(dir, 'trip.json'), now: () => new Date(), emit: broadcaster.emit,
    fillDeps: { lockFile: join(dir, 'fill.lock'), openWorker: async () => worker, openStore: shared },
    syncDeps: { openStore: shared, openWorker: async () => worker, paceMs: 0 },
    openSearchPage: async () => { throw new Error('the browser tests never search Auchan'); },
    searchTuning: { paceMs: 0, sleep: async () => {} },
  });
  const publicDir = new URL('../public', import.meta.url).pathname;
  const server = createAppServer({ service, token: TOKEN, publicDir, broadcaster, lanHosts: [PHONE_HOST] });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const phone: http.Server = await listenAlso(server, port, PHONE_HOST);
  return {
    url: `http://127.0.0.1:${port}/?t=${TOKEN}`,
    phoneUrl: `http://${PHONE_HOST}:${port}/?t=${TOKEN}`,
    cart,
    async close() {
      service.shutdown();
      for (const s of [phone, server]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const launch = (): Promise<Browser> => chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/usr/sbin/chromium' });
