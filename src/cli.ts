import { chmodSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, type Store } from './store.ts';
import { browserLogin, LoginRequired, Blocked, Refused, ProfileBusy, RateLimited, type Worker } from './worker.ts';
import { createHttpWorker } from './http-worker.ts';
import { cleanText, ShapeError } from './parse.ts';
import { logDetail } from './errors.ts';
import { checkOrders, syncOrderImages, syncOrders, syncPlaced } from './sync-orders.ts';
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
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // chmod follows a symlink; a linked state directory is left as its owner arranged it.
  if (!lstatSync(dir).isSymbolicLink()) chmodSync(dir, 0o700);
}

/** The database file exists and is owner-only before SQLite opens it. A symlink at the path is refused: opening it would write wherever it points. */
export function ensureDbFile(file: string): void {
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (st?.isSymbolicLink()) throw new Error('The database path is a symbolic link; remove it and run again.');
  if (st) {
    chmodSync(file, 0o600);
    return;
  }
  // Created whole beside the path and renamed in, so nothing is ever written through a link planted in between. SQLite reads an empty file as an empty database.
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, '', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

export const liveDeps: Deps = {
  async openWorker() {
    ensureStateDir(SESSION_PATH);
    return createHttpWorker({ sessionFile: SESSION_PATH, login: () => browserLogin(SESSION_PATH) });
  },
  openStore() {
    ensureStateDir(DB_PATH);
    ensureDbFile(DB_PATH); // before opening, so a failure leaves no open handle behind
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
  logDetail(action === 'sync' ? 'Sync' : 'Fill', err);
  return `${action === 'sync' ? 'Sync' : 'Fill'} failed unexpectedly. Details are on stderr.`;
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

/** What a sync found, as data: a caller with an emit hook words it itself instead of printing the CLI's lines. */
export type SyncEvent =
  | { kind: 'orders'; imported: number; skipped: number }
  | { kind: 'placed'; imported: number }
  | { kind: 'promotions'; products: number; pages: number; capped: string[]; skipped: string[] }
  | { kind: 'noRegion' }
  | { kind: 'login' }
  | { kind: 'failed'; error: unknown };

export async function runSync(
  which: string | undefined, worker: Worker, store: Store, paceMs: number,
  log: (line: string) => void = (l) => console.log(l), err: (line: string) => void = (l) => console.error(l),
  polish = false, placedId?: string, emit?: (e: SyncEvent) => void,
): Promise<number> {
  if (which === 'placed') {
    const r = await syncPlaced(worker, store, { paceMs, orderId: placedId });
    log(`placed: ${r.imported} imported, ${r.skipped} skipped`);
    return 0;
  }
  if (which === 'images') {
    const r = await syncOrderImages(worker, store, { paceMs });
    log(`images: ${r.fetched} orders re-read`);
    return 0;
  }
  if (which !== 'promotions') {
    const r = await syncOrders(worker, store, { paceMs });
    if (emit) emit({ kind: 'orders', imported: r.imported, skipped: r.skipped });
    else log(
      `orders: imported ${r.imported}, skipped ${r.skipped}, oldest seen ${cleanText(r.oldestSeen ?? 'none')}; ` +
        `zero-quantity lines ${r.skippedZero}, substitutes ${r.substitutes}, missings ${r.missings}, returns ${r.returns}`,
    );
    const p = await syncPlaced(worker, store, { paceMs });
    if (emit) emit({ kind: 'placed', imported: p.imported });
    else log(polish ? `zamówienia złożone (przed dostawą): ${p.imported}` : `placed orders (before delivery): ${p.imported}`);
  }
  if (which !== 'orders') {
    // The session's own region cannot check itself: the expected one comes from a real delivery.
    const expectedRegionId = store.latestOrderRegion();
    if (expectedRegionId === null) {
      if (emit) emit({ kind: 'noRegion' });
      else err(NO_REGION);
      return 1;
    }
    const r = await syncPromotions(worker, store, { paceMs, expectedRegionId });
    if (emit) emit({ kind: 'promotions', products: r.products, pages: r.pages, capped: r.capped, skipped: r.skipped });
    else {
      log(`promotions: ${r.products} products from ${r.pages} pages`);
      if (r.capped.length) log(`capped (may be incomplete): ${r.capped.join(', ')}`);
      if (r.skipped.length) log(`skipped: ${r.skipped.join(', ')}`);
    }
  }
  return 0;
}

type Out = { log(line: string): void; err(line: string): void; polish?: boolean; emit?: (e: SyncEvent) => void };

async function runSyncJob(which: string | undefined, deps: Deps, out: Out, placedId?: string): Promise<number> {
  const paceMs = deps.paceMs ?? PACE_MS;
  let store: Store | undefined;
  let worker: Worker | undefined;
  try {
    if (which !== 'check') store = deps.openStore(); // check must not even create the database
    worker = await deps.openWorker();
    const open = worker;
    const work = async (): Promise<number> => {
      if (store) return runSync(which, open, store, paceMs, out.log, out.err, out.polish, placedId, out.emit);
      const { orders } = await checkOrders(open, { paceMs });
      out.log(`ok: ${orders} orders on the page${orders === 0 ? ', so no order was checked' : ''}`);
      return 0;
    };
    return (await withLogin(open, work, LOG_IN, out.emit ? () => out.emit!({ kind: 'login' }) : out.err)) ?? 1;
  } catch (err) {
    if (out.emit) out.emit({ kind: 'failed', error: err });
    else out.err(describeFailure(err));
    return 1;
  } finally {
    await worker?.close();
    store?.close();
  }
}

/** Orders then promotions, reporting through one logger (the app shows both kinds of line the same way). */
export function syncAll(deps: Deps, log: (line: string) => void, emit?: (e: SyncEvent) => void): Promise<number> {
  return runSyncJob(undefined, deps, { log, err: log, polish: true, emit });
}

export async function main(args: string[], deps: Deps = liveDeps): Promise<number> {
  const which = args[0];
  const placedOk = which === 'placed' && args.length === 2 && /^\d{6,20}$/.test(args[1]);
  if ((which !== undefined && which !== 'orders' && which !== 'promotions' && which !== 'images' && which !== 'check' && which !== 'placed') || (which === 'placed' && !placedOk)) {
    console.error('usage: npm run sync [orders|promotions|images|check|placed <orderId>]');
    return 2;
  }
  return runSyncJob(which, deps, { log: (l) => console.log(l), err: (l) => console.error(l) }, placedOk ? args[1] : undefined);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
