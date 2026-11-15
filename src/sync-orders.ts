import { parseCompletedOrdersPage, parseDecoratedOrder, ShapeError } from './parse.ts';
import type { Store } from './store.ts';
import { Rejected } from './http-worker.ts';
import { GET_COMPLETED_ORDERS_QUERY, type Worker } from './worker.ts';

const PAGE_SIZE = 20;
const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SyncOrdersOptions {
  paceMs: number;
  sleep?: (ms: number) => Promise<void>;
}

function readPage(raw: unknown): ReturnType<typeof parseCompletedOrdersPage> {
  try {
    return parseCompletedOrdersPage(raw);
  } catch (e) {
    if (e instanceof ShapeError) throw new ShapeError('completed orders page has an unexpected shape');
    throw e;
  }
}

function readOrder(json: unknown, id: string): ReturnType<typeof parseDecoratedOrder> {
  try {
    const parsed = parseDecoratedOrder(json);
    if (parsed.order.orderId !== id) throw new ShapeError('order id mismatch');
    return parsed;
  } catch (e) {
    if (e instanceof ShapeError) throw new ShapeError(`order ${id} has an unexpected shape`);
    throw e;
  }
}

const orderPath = (id: string) => `/api/order/v6/orders/${encodeURIComponent(id)}/decorated`;

/** Read-only probe of the request format: one page, one order, nothing stored. */
export async function checkOrders(
  worker: Pick<Worker, 'graphql' | 'getJson'>,
  opts: SyncOrdersOptions,
): Promise<{ orders: number }> {
  const sleep = opts.sleep ?? defaultSleep;
  const { orderIds } = readPage(await worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, { first: PAGE_SIZE, after: null }));
  if (orderIds.length > 0) {
    await sleep(opts.paceMs);
    readOrder(await worker.getJson(orderPath(orderIds[0])), orderIds[0]);
  }
  return { orders: orderIds.length };
}

export interface SyncOrdersResult {
  imported: number;
  skipped: number;
  oldestSeen: string | null;
  skippedZero: number;
  substitutes: number;
  missings: number;
  returns: number;
}

export async function syncOrders(
  worker: Pick<Worker, 'graphql' | 'getJson'>,
  store: Store,
  opts: SyncOrdersOptions,
): Promise<SyncOrdersResult> {
  const sleep = opts.sleep ?? defaultSleep;
  // Early stop is only safe once a complete run has stored everything older.
  const canStopEarly = store.lastSyncClean('orders');
  const runId = store.startSync('orders');

  let imported = 0;
  let skipped = 0;
  let oldestSeen: string | null = null;
  let skippedZero = 0;
  let substitutes = 0;
  let missings = 0;
  let returns = 0;
  let first = true;
  // Every request after the first waits paceMs; none are retried.
  const pace = async () => {
    if (!first) await sleep(opts.paceMs);
    first = false;
  };

  try {
    let after: string | null = null;
    for (;;) {
      await pace();
      const pageInfo = readPage(await worker.graphql('GetCompletedOrders', GET_COMPLETED_ORDERS_QUERY, { first: PAGE_SIZE, after }));

      let pageAllStored = pageInfo.orderIds.length > 0;
      for (const id of pageInfo.orderIds) {
        if (store.orderStatus(id) === 'delivered') {
          skipped++;
          continue;
        }
        pageAllStored = false;
        await pace();
        const parsed = readOrder(await worker.getJson(orderPath(id)), id);
        store.saveOrder(parsed); // a placed order of the same id is replaced
        imported++;
        skippedZero += parsed.skippedZero;
        substitutes += parsed.substitutes;
        missings += parsed.missings;
        returns += parsed.returns;
        if (oldestSeen === null || parsed.order.deliveredAt < oldestSeen) oldestSeen = parsed.order.deliveredAt;
      }

      if (!pageInfo.hasNextPage) break;
      if (!pageInfo.endCursor) throw new ShapeError('completed orders page has a next page but no cursor');
      if (canStopEarly && pageAllStored) break;
      after = pageInfo.endCursor;
    }
  } catch (e) {
    store.finishSync(runId, 'failed');
    throw e;
  }
  store.finishSync(runId, 'ok');
  return { imported, skipped, oldestSeen, skippedZero, substitutes, missings, returns };
}

/**
 * Backfill: orders stored before images were read are fetched again, only those with a product that still has no image.
 * Only image columns are written; no order, line or price is added. Same pacing, no retries; a Blocked propagates and stops it.
 */
export async function syncOrderImages(
  worker: Pick<Worker, 'getJson'>,
  store: Store,
  opts: SyncOrdersOptions,
): Promise<{ fetched: number }> {
  const sleep = opts.sleep ?? defaultSleep;
  let fetched = 0;
  for (const id of store.ordersMissingImages()) {
    if (fetched > 0) await sleep(opts.paceMs);
    store.saveOrderImages(readOrder(await worker.getJson(orderPath(id)), id).products);
    fetched++;
  }
  return { fetched };
}

export interface SyncPlacedResult {
  imported: number;
  skipped: number;
}

/**
 * Orders the user placed after a fill are learned before delivery: each order id recorded on a fill run
 * (or the one given) that is not stored yet is read once and saved as 'placed'. An order that does not exist
 * (never paid), has an unexpected body or no lines is skipped silently; a Blocked propagates and stops the step.
 */
export async function syncPlaced(
  worker: Pick<Worker, 'getJson'>,
  store: Store,
  opts: SyncOrdersOptions & { orderId?: string },
): Promise<SyncPlacedResult> {
  const sleep = opts.sleep ?? defaultSleep;
  if (opts.orderId !== undefined && !/^\d{6,20}$/.test(opts.orderId)) throw new Error('order id must be 6 to 20 digits');
  const ids = opts.orderId !== undefined ? (store.hasOrder(opts.orderId) ? [] : [opts.orderId]) : store.fillOrderIdsNotInOrders();
  let imported = 0;
  let skipped = 0;
  let first = true;
  for (const id of ids) {
    if (!first) await sleep(opts.paceMs);
    first = false;
    let parsed: ReturnType<typeof parseDecoratedOrder>;
    try {
      parsed = readOrder(await worker.getJson(orderPath(id)), id);
    } catch (e) {
      if (e instanceof Rejected || e instanceof ShapeError) {
        skipped++;
        continue;
      }
      throw e;
    }
    if (parsed.lines.length === 0) {
      skipped++;
      continue;
    }
    store.saveOrder(parsed, 'placed');
    imported++;
  }
  return { imported, skipped };
}
