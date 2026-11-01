import { parsePromotionsState, ShapeError } from './parse.ts';
import type { Store } from './store.ts';
import { assertAllowed, type Worker } from './worker.ts';
import type { PriceObservation, Product } from './types.ts';

// A page that returns this many products may be cut off; we report it, not paginate.
const PAGE_CAP = 50;
// A ceiling on requests: a changed page must not send the sync through an unbounded list of links.
const MAX_CATEGORIES = 40;
const CATEGORY = /^\/promotions\/[^/?#]+\/\d+$/;

export interface SyncPromotionsOptions {
  paceMs: number;
  expectedRegionId: string;
  sleep?: (ms: number) => Promise<void>;
}

/** Category paths from /promotions links: one per pathname (first seen wins), `source=` tracking removed. */
export function discoverPromotionCategories(links: string[]): string[] {
  const found = new Map<string, string>();
  for (const link of links) {
    const q = link.indexOf('?');
    const pathname = q === -1 ? link : link.slice(0, q);
    if (!CATEGORY.test(pathname) || found.has(pathname)) continue;
    const query = q === -1 ? [] : link.slice(q + 1).split('&').filter((p) => p !== '' && !p.startsWith('source='));
    found.set(pathname, query.length ? `${pathname}?${query.join('&')}` : pathname);
  }
  return [...found.values()];
}

export async function syncPromotions(
  worker: Pick<Worker, 'pageState' | 'pageLinks'>,
  store: Store,
  opts: SyncPromotionsOptions,
): Promise<{ pages: number; products: number; capped: string[]; skipped: string[] }> {
  if (!opts.expectedRegionId) throw new Error('expected delivery region is empty; refusing to sync promotions');
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const seenAt = new Date().toISOString(); // one snapshot per sync
  const runId = store.startSync('promotions');

  let first = true;
  // Every navigation after the first waits paceMs; none are retried.
  const pace = async () => {
    if (!first) await sleep(opts.paceMs);
    first = false;
  };

  const products = new Map<string, Product>();
  const prices = new Map<string, PriceObservation>();
  const capped: string[] = [];
  const skipped: string[] = [];
  let pages = 0;

  const readPage = async (path: string) => {
    await pace();
    const state = await worker.pageState(path);
    let parsed: ReturnType<typeof parsePromotionsState>;
    try {
      parsed = parsePromotionsState(state, seenAt);
    } catch (e) {
      if (e instanceof ShapeError) throw new ShapeError(`promotions page ${path} has an unexpected shape`);
      throw e;
    }
    if (parsed.regionId !== opts.expectedRegionId) {
      throw new Error(`promotions page ${path} is for region ${parsed.regionId}, expected ${opts.expectedRegionId}`);
    }
    pages++;
    if (parsed.products.length >= PAGE_CAP) capped.push(path);
    for (const p of parsed.products) products.set(p.productId, p);
    for (const o of parsed.prices) prices.set(o.productId, o);
  };

  try {
    await readPage('/promotions');
    await pace();
    const links = await worker.pageLinks('/promotions', '/promotions/');
    const categories = discoverPromotionCategories(links);
    if (categories.length > MAX_CATEGORIES) {
      throw new ShapeError(`found ${categories.length} promotion categories, more than the limit of ${MAX_CATEGORIES}`);
    }
    const paths: string[] = [];
    for (const path of categories) {
      try {
        assertAllowed(path);
        paths.push(path);
      } catch {
        skipped.push(path);
      }
    }
    if (paths.length === 0) {
      throw new ShapeError('no promotion category pages found to visit; refusing to save a partial snapshot');
    }
    for (const path of paths) await readPage(path);
    if (products.size === 0) throw new ShapeError('promotion pages returned no products; refusing to save an empty snapshot');
    store.savePromotions({ regionId: opts.expectedRegionId, products: [...products.values()], prices: [...prices.values()] });
  } catch (e) {
    store.finishSync(runId, 'failed');
    throw e;
  }
  store.finishSync(runId, 'ok');
  return { pages, products: products.size, capped, skipped };
}
