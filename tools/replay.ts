import { pathToFileURL } from 'node:url';
import { buildDraft } from '../src/draft.ts';
import type { Draft } from '../src/draft.ts';
import { DB_PATH } from '../src/dbpath.ts';
import { openStore } from '../src/store.ts';
import type { Store } from '../src/store.ts';

const MIN_PRIOR_ORDERS = 3;

/** A hit is a draft line whose product is on the target order. */
export function replayOrder(target: { productId: string }[], draft: Draft): { recall: number; precision: number } {
  const wanted = new Set(target.map((t) => t.productId));
  const hits = new Set(draft.items.map((i) => i.productId).filter((id) => wanted.has(id))).size;
  return {
    recall: wanted.size === 0 ? 0 : hits / wanted.size,
    precision: draft.items.length === 0 ? 0 : hits / draft.items.length,
  };
}

export interface ReplayRow {
  line: string;
  recall?: number;
  precision?: number;
  skipped?: true;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Replays each of the latest orders using only the orders before it: the usual list, no terms.
 * Known limit: in-catalogue is today's state, so products since removed from the catalogue cannot be proposed.
 */
export function replayLatest(store: Store, count: number, now: Date): ReplayRow[] {
  const all = store.recentOrders(1_000_000);
  return all.slice(0, count).map((o, i) => {
    const label = `order ${i + 1} (newest first)`;
    const prior = all.filter((p) => p.deliveredAt < o.deliveredAt).length;
    if (prior < MIN_PRIOR_ORDERS) return { line: `${label}: skipped, fewer than ${MIN_PRIOR_ORDERS} prior orders (${prior})`, skipped: true as const };
    const facts = store.productFacts({ asOf: o.deliveredAt });
    const draft = buildDraft({ items: [], includeUsual: true }, facts, [], now);
    const target = store.orderProductIds(o.orderId).map((productId) => ({ productId }));
    const r = replayOrder(target, draft);
    return {
      line: `${label}: ${target.length} bought, ${draft.items.length} proposed, recall ${pct(r.recall)}, precision ${pct(r.precision)}`,
      ...r,
    };
  });
}

function main(): void {
  const store = openStore(DB_PATH, { readOnly: true });
  try {
    const rows = replayLatest(store, 5, new Date());
    for (const r of rows) console.log(r.line);
    const done = rows.filter((r) => !r.skipped);
    if (done.length === 0) { console.log('average: nothing to replay'); return; }
    const avg = (k: 'recall' | 'precision') => done.reduce((s, r) => s + r[k]!, 0) / done.length;
    console.log(`average over ${done.length} orders: recall ${pct(avg('recall'))}, precision ${pct(avg('precision'))}`);
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
