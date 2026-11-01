import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from './store.ts';
import { browserLogin, LoginRequired, Blocked, ProfileBusy, RateLimited, type Worker } from './worker.ts';
import { createHttpWorker } from './http-worker.ts';
import { ShapeError } from './parse.ts';
import { checkOrders, syncOrders } from './sync-orders.ts';
import { syncPromotions } from './sync-promotions.ts';
import { DB_PATH, SESSION_PATH } from './dbpath.ts';

const PACE_MS = 1500;
const LOG_IN = 'Log in in the browser window and leave it open; the sync continues on its own';
const NOT_LOGGED_IN = 'Auchan still reports no login: log in and rerun';
const NO_REGION = 'Sync orders first: promotions need your delivery region';

export interface Deps {
  openWorker(): Promise<Worker>;
  openStore(): Store;
  paceMs?: number;
}

const liveDeps: Deps = {
  async openWorker() {
    mkdirSync(dirname(SESSION_PATH), { recursive: true });
    return createHttpWorker({ sessionFile: SESSION_PATH, login: () => browserLogin(SESSION_PATH) });
  },
  openStore() {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    return openStore(DB_PATH);
  },
};

/** The one line printed for a failure. Fixed text for the known cases so no response content can leak. */
export function describeFailure(err: unknown): string {
  if (err instanceof LoginRequired) return NOT_LOGGED_IN;
  if (err instanceof RateLimited) {
    const wait = err.retrySeconds === undefined ? 'later' : `in ${Math.max(1, Math.ceil(err.retrySeconds / 60))} min`;
    return `Auchan asked us to slow down, so the sync stopped. Saved data is kept; run it again ${wait}.`;
  }
  if (err instanceof Blocked) return 'Auchan refused the request. Do not rerun; the request format may need review.';
  if (err instanceof ProfileBusy) return 'Browser profile is busy: close the other browser first.';
  if (err instanceof ShapeError) return `Unexpected response shape: ${err.message}`;
  return `Sync failed: ${err instanceof Error ? err.message : String(err)}`;
}

async function runSync(which: string | undefined, worker: Worker, store: Store, paceMs: number): Promise<number> {
  if (which !== 'promotions') {
    const r = await syncOrders(worker, store, { paceMs });
    console.log(
      `orders: imported ${r.imported}, skipped ${r.skipped}, oldest seen ${r.oldestSeen ?? 'none'}; ` +
        `zero-quantity lines ${r.skippedZero}, substitutes ${r.substitutes}, missings ${r.missings}, returns ${r.returns}`,
    );
  }
  if (which !== 'orders') {
    // The session's own region cannot check itself: the expected one comes from a real delivery.
    const expectedRegionId = store.latestOrderRegion();
    if (expectedRegionId === null) {
      console.error(NO_REGION);
      return 1;
    }
    const r = await syncPromotions(worker, store, { paceMs, expectedRegionId });
    console.log(`promotions: ${r.products} products from ${r.pages} pages`);
    if (r.capped.length) console.log(`capped (may be incomplete): ${r.capped.join(', ')}`);
    if (r.skipped.length) console.log(`skipped: ${r.skipped.join(', ')}`);
  }
  return 0;
}

export async function main(args: string[], deps: Deps = liveDeps): Promise<number> {
  const which = args[0];
  if (which !== undefined && which !== 'orders' && which !== 'promotions' && which !== 'check') {
    console.error('usage: npm run sync [orders|promotions|check]');
    return 2;
  }
  const paceMs = deps.paceMs ?? PACE_MS;
  let store: Store | undefined;
  let worker: Worker | undefined;
  try {
    if (which !== 'check') store = deps.openStore(); // check must not even create the database
    worker = await deps.openWorker();
    const open = worker;
    const work = async (): Promise<number> => {
      if (store) return runSync(which, open, store, paceMs);
      const { orders } = await checkOrders(open, { paceMs });
      console.log(`ok: ${orders} orders on the page${orders === 0 ? ', so no order was checked' : ''}`);
      return 0;
    };
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof LoginRequired)) throw err;
      // Auchan's login does not survive a browser restart, so it must happen in this window.
      console.error(LOG_IN);
      if (!(await open.waitForLogin())) return 1;
      return await work();
    }
  } catch (err) {
    console.error(describeFailure(err));
    return 1;
  } finally {
    await worker?.close();
    store?.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
