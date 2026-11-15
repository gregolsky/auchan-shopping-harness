import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from './store.ts';
import { browserLogin, LoginRequired, Blocked, Refused, ProfileBusy, RateLimited, type Worker } from './worker.ts';
import { createHttpWorker } from './http-worker.ts';
import { cleanText, ShapeError } from './parse.ts';
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

/** Order history and the session live here: owner only, whichever command creates it first. */
export function ensureStateDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  chmodSync(dirname(file), 0o700);
}

export const liveDeps: Deps = {
  async openWorker() {
    ensureStateDir(SESSION_PATH);
    return createHttpWorker({ sessionFile: SESSION_PATH, login: () => browserLogin(SESSION_PATH) });
  },
  openStore() {
    ensureStateDir(DB_PATH);
    // Create and restrict the file before opening it, so a failed chmod leaves no open handle behind. SQLite reads an empty file as an empty database.
    if (!existsSync(DB_PATH)) writeFileSync(DB_PATH, '', { mode: 0o600 });
    chmodSync(DB_PATH, 0o600);
    return openStore(DB_PATH);
  },
};

/** The one line printed for a failure. Fixed text for the known cases so no response content can leak. */
export function describeFailure(err: unknown, action: 'sync' | 'fill' = 'sync'): string {
  return cleanText(describe(err, action));
}

function describe(err: unknown, action: 'sync' | 'fill'): string {
  if (err instanceof LoginRequired) return NOT_LOGGED_IN;
  if (err instanceof RateLimited) {
    const wait = err.retrySeconds === undefined ? 'later' : `in ${Math.max(1, Math.ceil(err.retrySeconds / 60))} min`;
    return `Auchan asked us to slow down, so the ${action} stopped. Saved data is kept; run it again ${wait}.`;
  }
  if (err instanceof Refused) return `Auchan odrzucił zmianę koszyka (${err.productName}); zatrzymano. Część produktów mogła już trafić do koszyka — sprawdź koszyk, usuń ten produkt z listy i uruchom ponownie.`;
  if (err instanceof Blocked) return 'Auchan refused the request. Do not rerun; the request format may need review.';
  if (err instanceof ProfileBusy) return 'Browser profile is busy: close the other browser first.';
  if (err instanceof ShapeError) return `Unexpected response shape: ${err.message}`;
  return `${action === 'sync' ? 'Sync' : 'Fill'} failed: ${err instanceof Error ? err.message : String(err)}`;
}

/** Auchan's login does not survive a browser restart, so it must happen in this window. Undefined if the user gave up. */
export async function withLogin<T>(worker: Worker, work: () => Promise<T>, message: string = LOG_IN, say: (line: string) => void = (l) => console.error(l)): Promise<T | undefined> {
  try {
    return await work();
  } catch (err) {
    if (!(err instanceof LoginRequired)) throw err;
    say(message);
    if (!(await worker.waitForLogin())) return undefined;
    return await work();
  }
}

export async function runSync(
  which: string | undefined, worker: Worker, store: Store, paceMs: number,
  log: (line: string) => void = (l) => console.log(l), err: (line: string) => void = (l) => console.error(l),
): Promise<number> {
  if (which !== 'promotions') {
    const r = await syncOrders(worker, store, { paceMs });
    log(
      `orders: imported ${r.imported}, skipped ${r.skipped}, oldest seen ${cleanText(r.oldestSeen ?? 'none')}; ` +
        `zero-quantity lines ${r.skippedZero}, substitutes ${r.substitutes}, missings ${r.missings}, returns ${r.returns}`,
    );
  }
  if (which !== 'orders') {
    // The session's own region cannot check itself: the expected one comes from a real delivery.
    const expectedRegionId = store.latestOrderRegion();
    if (expectedRegionId === null) {
      err(NO_REGION);
      return 1;
    }
    const r = await syncPromotions(worker, store, { paceMs, expectedRegionId });
    log(`promotions: ${r.products} products from ${r.pages} pages`);
    if (r.capped.length) log(`capped (may be incomplete): ${r.capped.join(', ')}`);
    if (r.skipped.length) log(`skipped: ${r.skipped.join(', ')}`);
  }
  return 0;
}

type Out = { log(line: string): void; err(line: string): void };

async function runSyncJob(which: string | undefined, deps: Deps, out: Out): Promise<number> {
  const paceMs = deps.paceMs ?? PACE_MS;
  let store: Store | undefined;
  let worker: Worker | undefined;
  try {
    if (which !== 'check') store = deps.openStore(); // check must not even create the database
    worker = await deps.openWorker();
    const open = worker;
    const work = async (): Promise<number> => {
      if (store) return runSync(which, open, store, paceMs, out.log, out.err);
      const { orders } = await checkOrders(open, { paceMs });
      out.log(`ok: ${orders} orders on the page${orders === 0 ? ', so no order was checked' : ''}`);
      return 0;
    };
    return (await withLogin(open, work, LOG_IN, out.err)) ?? 1;
  } catch (err) {
    out.err(describeFailure(err));
    return 1;
  } finally {
    await worker?.close();
    store?.close();
  }
}

/** Orders then promotions, reporting through one logger (the app shows both kinds of line the same way). */
export function syncAll(deps: Deps, log: (line: string) => void): Promise<number> {
  return runSyncJob(undefined, deps, { log, err: log });
}

export async function main(args: string[], deps: Deps = liveDeps): Promise<number> {
  const which = args[0];
  if (which !== undefined && which !== 'orders' && which !== 'promotions' && which !== 'check') {
    console.error('usage: npm run sync [orders|promotions|check]');
    return 2;
  }
  return runSyncJob(which, deps, { log: (l) => console.log(l), err: (l) => console.error(l) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
