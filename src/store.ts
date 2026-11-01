import { DatabaseSync } from 'node:sqlite';
import type { Product, PriceObservation } from './types.ts';
import type { parseDecoratedOrder } from './parse.ts';
import { unitPriceGrosze } from './pricing.ts';

type ParsedOrder = Pick<ReturnType<typeof parseDecoratedOrder>, 'order' | 'lines' | 'products' | 'prices'>;
export type SyncKind = 'orders' | 'promotions';
export type SyncStatus = 'ok' | 'failed';

export interface PromotionsInput {
  regionId: string;
  products: Product[];
  prices: PriceObservation[];
}

export interface RecentOrder {
  orderId: string;
  deliveredAt: string;
  totalGrosze: number;
  lineCount: number;
}

export interface ProductHistoryRow {
  productId: string;
  name: string;
  brand: string;
  unitLabel: string | null;
  size: string | null;
  timesOrdered: number;
  lastOrderedAt: string | null;
  lastPriceGrosze: number | null;
}

export interface PromotionRow {
  productId: string;
  name: string;
  brand: string;
  unitLabel: string | null;
  size: string | null;
  seenAt: string;
  originalGrosze: number | null;
  currentGrosze: number;
  unitCurrentGrosze: number | null;
  offerText: string | null;
  requiredQuantity: number | null;
  boughtBefore: boolean;
}

export interface IntentRule {
  term: string;
  brand: string | null;
  preferredProductId: string | null;
  acceptedProductIds: string[];
}

export interface CorrectionRow {
  term: string;
  proposedProductId: string | null;
  chosenProductId: string | null;
  reason: string | null;
  createdAt: string;
}

/** Trim, collapse whitespace, lower case and strip diacritics (including the stroked l) so terms match however they were typed. */
export function normaliseTerm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l');
}

export interface ProductFacts {
  productId: string;
  name: string;
  brand: string;
  categoryPath: string[];
  size: string | null;
  timesBought: number;
  lastBoughtAt: string | null;
  /** Median line quantity over the orders containing the product. */
  usualQuantity: number | null;
  /** current_grosze of the newest price_history row. */
  latestPriceGrosze: number | null;
  /** Offer fields only from rows seen in the latest promotion sync. */
  offerText: string | null;
  requiredQuantity: number | null;
  /** Median price per kg or L over the product's order-sourced prices; null without a known size or such rows. */
  medianUnitPriceGrosze: number | null;
  pricePoints: number;
  inCatalogue: boolean;
  /** In how many of the latest 10 orders the product appears. */
  boughtInLatest10: number;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface Store {
  saveOrder(parsed: ParsedOrder): void;
  hasOrder(orderId: string): boolean;
  /** Region of the most recently delivered stored order, or null if there are none. */
  latestOrderRegion(): string | null;
  savePromotions(parsed: PromotionsInput): void;
  recentOrders(limit: number): RecentOrder[];
  productHistory(query: string): ProductHistoryRow[];
  currentPromotions(opts: { boughtBefore?: boolean; limit: number }): PromotionRow[];
  /** One row per product, for ranking. Reads each table once. */
  productFacts(opts?: { asOf?: string }): ProductFacts[];
  /** Product ids on one order, in line order. */
  orderProductIds(orderId: string): string[];
  startSync(kind: SyncKind): number;
  finishSync(id: number, status: SyncStatus): void;
  lastSyncStatus(kind: SyncKind): SyncStatus | null;
  /** True only if the latest run of this kind, finished or not, ended ok. A crashed run counts as not ok. */
  lastSyncClean(kind: SyncKind): boolean;
  /** ISO time of the latest successful sync of this kind, or null if none. */
  lastSyncFinishedAt(kind: SyncKind): string | null;
  /** Records a user correction; a chosen product also teaches the term's rule. Terms are normalised. */
  recordCorrection(c: { term: string; proposedProductId: string | null; chosenProductId: string | null; reason?: string }): void;
  intentRules(term?: string): IntentRule[];
  setBrandFixed(term: string, brand: string | null): void;
  /** Removes the learned rule for a term; the correction history stays. */
  deleteRule(term: string): void;
  corrections(term?: string): CorrectionRow[];
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  retailer_product_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  brand TEXT NOT NULL,
  category_path TEXT NOT NULL,
  unit_label TEXT,
  size TEXT,
  in_catalogue INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY,
  delivered_at TEXT NOT NULL,
  total_grosze INTEGER NOT NULL,
  region_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS order_lines (
  order_id TEXT NOT NULL REFERENCES orders(order_id) DEFERRABLE INITIALLY DEFERRED,
  product_id TEXT NOT NULL REFERENCES products(product_id),
  quantity REAL NOT NULL,
  price_per_item_grosze INTEGER NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
CREATE TABLE IF NOT EXISTS price_history (
  product_id TEXT NOT NULL REFERENCES products(product_id),
  seen_at TEXT NOT NULL,
  seen_day TEXT NOT NULL,
  region_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('order', 'promotion')),
  original_grosze INTEGER,
  current_grosze INTEGER NOT NULL,
  unit_current_grosze INTEGER,
  offer_text TEXT,
  required_quantity INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS price_history_observation
  ON price_history (product_id, region_id, source, seen_day, current_grosze, COALESCE(offer_text, ''));
CREATE INDEX IF NOT EXISTS price_history_source_seen ON price_history (source, seen_at);
CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('orders', 'promotions')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT CHECK (status IN ('ok', 'failed'))
);
CREATE TABLE IF NOT EXISTS intents (
  term TEXT PRIMARY KEY,
  brand TEXT
);
CREATE TABLE IF NOT EXISTS intent_products (
  term TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(product_id),
  times_chosen INTEGER NOT NULL,
  last_chosen_at TEXT NOT NULL,
  PRIMARY KEY (term, product_id)
);
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL,
  proposed_product_id TEXT,
  chosen_product_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL
);
`;

export function openStore(path: string, opts: { readOnly?: boolean } = {}): Store {
  const db = new DatabaseSync(path, { readOnly: opts.readOnly === true, timeout: 5000 });
  db.exec('PRAGMA foreign_keys = ON');
  if (!opts.readOnly) db.exec(SCHEMA);

  // A sparse source (an order line with no entity) must not wipe what a richer one stored.
  const upsertProduct = db.prepare(`
    INSERT INTO products (product_id, retailer_product_id, name, name_lower, brand, category_path, unit_label, size, in_catalogue)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id) DO UPDATE SET
      retailer_product_id = excluded.retailer_product_id, name = excluded.name, name_lower = excluded.name_lower,
      brand = COALESCE(NULLIF(excluded.brand, ''), products.brand),
      category_path = COALESCE(NULLIF(excluded.category_path, '[]'), products.category_path),
      unit_label = COALESCE(NULLIF(excluded.unit_label, ''), products.unit_label),
      size = COALESCE(NULLIF(excluded.size, ''), products.size),
      in_catalogue = excluded.in_catalogue`);
  // Same product/region/source/day/price/offer is one observation; re-seeing it refreshes seen_at
  // so "current promotions" can be defined as rows seen in the latest sync.
  const upsertPrice = db.prepare(`
    INSERT INTO price_history (product_id, seen_at, seen_day, region_id, source, original_grosze, current_grosze, unit_current_grosze, offer_text, required_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(product_id, region_id, source, seen_day, current_grosze, COALESCE(offer_text, '')) DO UPDATE SET
      seen_at = MAX(seen_at, excluded.seen_at), original_grosze = excluded.original_grosze,
      unit_current_grosze = excluded.unit_current_grosze, required_quantity = excluded.required_quantity`);
  const insertOrder = db.prepare('INSERT OR IGNORE INTO orders (order_id, delivered_at, total_grosze, region_id) VALUES (?, ?, ?, ?)');
  const insertLine = db.prepare(
    'INSERT OR REPLACE INTO order_lines (order_id, product_id, quantity, price_per_item_grosze) VALUES (?, ?, ?, ?)',
  );

  function writeProducts(products: Product[]) {
    for (const p of products) {
      upsertProduct.run(
        p.productId, p.retailerProductId, p.name, p.name.toLocaleLowerCase('pl'), p.brand,
        JSON.stringify(p.categoryPath), p.unitLabel, p.size, p.inCatalogue ? 1 : 0,
      );
    }
  }
  function writePrices(prices: PriceObservation[]) {
    for (const o of prices) {
      upsertPrice.run(
        o.productId, o.seenAt, o.seenAt.slice(0, 10), o.regionId, o.source, o.originalGrosze,
        o.currentGrosze, o.unitCurrentGrosze, o.offerText, o.requiredQuantity,
      );
    }
  }
  function transaction(fn: () => void) {
    db.exec('BEGIN');
    try {
      fn();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Strictly increasing, so "most recently chosen" never ties within one process.
  let lastStamp = 0;
  function stamp(): string {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  }

  return {
    saveOrder({ order, lines, products, prices }) {
      transaction(() => {
        writeProducts(products);
        writePrices(prices);
        for (const l of lines) insertLine.run(l.orderId, l.productId, l.quantity, l.pricePerItemGrosze);
        // Written last: an order row means everything above was stored.
        insertOrder.run(order.orderId, order.deliveredAt, order.totalGrosze, order.regionId);
      });
    },

    hasOrder(orderId) {
      return db.prepare('SELECT 1 FROM orders WHERE order_id = ?').get(orderId) !== undefined;
    },

    latestOrderRegion() {
      const r = db.prepare('SELECT region_id FROM orders ORDER BY delivered_at DESC, order_id DESC LIMIT 1').get() as
        | { region_id: string }
        | undefined;
      return r ? r.region_id : null;
    },

    savePromotions({ regionId, products, prices }) {
      const foreign = prices.find((o) => o.regionId !== regionId);
      if (foreign) throw new Error(`price for ${foreign.productId} has region ${foreign.regionId}, expected ${regionId}`);
      transaction(() => {
        writeProducts(products);
        writePrices(prices);
      });
    },

    recentOrders(limit) {
      const rows = db.prepare(`
        SELECT o.order_id, o.delivered_at, o.total_grosze,
               (SELECT COUNT(*) FROM order_lines l WHERE l.order_id = o.order_id) AS line_count
        FROM orders o ORDER BY o.delivered_at DESC, o.order_id DESC LIMIT ?`).all(limit) as any[];
      return rows.map((r) => ({
        orderId: r.order_id, deliveredAt: r.delivered_at, totalGrosze: r.total_grosze, lineCount: r.line_count,
      }));
    },

    productHistory(query) {
      // instr, not LIKE: no wildcard escaping, and name_lower is already lowercased for Polish.
      const rows = db.prepare(`
        SELECT p.product_id, p.name, p.brand, p.unit_label, p.size,
               COUNT(l.order_id) AS times_ordered,
               MAX(o.delivered_at) AS last_ordered_at,
               (SELECT l2.price_per_item_grosze FROM order_lines l2 JOIN orders o2 ON o2.order_id = l2.order_id
                 WHERE l2.product_id = p.product_id ORDER BY o2.delivered_at DESC LIMIT 1) AS last_price
        FROM products p
        LEFT JOIN order_lines l ON l.product_id = p.product_id
        LEFT JOIN orders o ON o.order_id = l.order_id
        WHERE instr(p.name_lower, ?) > 0
        GROUP BY p.product_id
        ORDER BY times_ordered DESC, p.name_lower`).all(query.toLocaleLowerCase('pl')) as any[];
      return rows.map((r) => ({
        productId: r.product_id, name: r.name, brand: r.brand, unitLabel: r.unit_label, size: r.size,
        timesOrdered: r.times_ordered, lastOrderedAt: r.last_ordered_at, lastPriceGrosze: r.last_price,
      }));
    },

    currentPromotions({ boughtBefore, limit }) {
      const rows = db.prepare(`
        SELECT p.product_id, p.name, p.brand, p.unit_label, p.size, h.seen_at, h.original_grosze, h.current_grosze,
               h.unit_current_grosze, h.offer_text, h.required_quantity,
               EXISTS (SELECT 1 FROM order_lines l WHERE l.product_id = p.product_id) AS bought
        FROM price_history h JOIN products p ON p.product_id = h.product_id
        WHERE h.source = 'promotion'
          AND h.seen_at = (SELECT MAX(seen_at) FROM price_history WHERE source = 'promotion')
          AND (? = 0 OR EXISTS (SELECT 1 FROM order_lines l WHERE l.product_id = p.product_id))
        ORDER BY bought DESC, p.name_lower LIMIT ?`).all(boughtBefore ? 1 : 0, limit) as any[];
      return rows.map((r) => ({
        productId: r.product_id, name: r.name, brand: r.brand, unitLabel: r.unit_label, size: r.size, seenAt: r.seen_at,
        originalGrosze: r.original_grosze, currentGrosze: r.current_grosze, unitCurrentGrosze: r.unit_current_grosze,
        offerText: r.offer_text, requiredQuantity: r.required_quantity, boughtBefore: r.bought === 1,
      }));
    },

    orderProductIds(orderId) {
      return (db.prepare('SELECT product_id FROM order_lines WHERE order_id = ? ORDER BY rowid').all(orderId) as { product_id: string }[])
        .map((r) => r.product_id);
    },

    productFacts(opts) {
      // asOf: only orders delivered strictly before it, and prices seen strictly before it; no offers, as promotion
      // syncs are not dated per order. In-catalogue stays as it is today (a known limit for replays).
      const asOf = opts?.asOf ?? null;
      const products = db.prepare('SELECT product_id, name, brand, category_path, size, in_catalogue FROM products').all() as any[];
      const lines = db.prepare(`
        SELECT l.product_id, l.quantity, o.delivered_at FROM order_lines l JOIN orders o ON o.order_id = l.order_id
        WHERE ?1 IS NULL OR o.delivered_at < ?1`).all(asOf) as any[];
      const in10 = db.prepare(`
        SELECT l.product_id, COUNT(*) AS n FROM order_lines l
        WHERE l.order_id IN (SELECT order_id FROM orders WHERE ?1 IS NULL OR delivered_at < ?1 ORDER BY delivered_at DESC, order_id DESC LIMIT 10)
        GROUP BY l.product_id`).all(asOf) as any[];
      const prices = db.prepare(
        'SELECT product_id, seen_at, source, current_grosze FROM price_history WHERE ?1 IS NULL OR seen_at < ?1 ORDER BY seen_at, rowid',
      ).all(asOf) as any[];
      const offers = db.prepare(`
        SELECT product_id, offer_text, required_quantity, current_grosze FROM price_history
        WHERE source = 'promotion' AND seen_at = (SELECT MAX(seen_at) FROM price_history WHERE source = 'promotion')
        ORDER BY rowid`).all() as any[];
      if (asOf !== null) offers.length = 0;

      const qty = new Map<string, number[]>();
      const last = new Map<string, string>();
      for (const l of lines) {
        (qty.get(l.product_id) ?? qty.set(l.product_id, []).get(l.product_id)!).push(l.quantity);
        if ((last.get(l.product_id) ?? '') < l.delivered_at) last.set(l.product_id, l.delivered_at);
      }
      const latestPrice = new Map<string, number>(); // rows are in seen_at order, so the last one wins
      const orderPrices = new Map<string, number[]>();
      for (const r of prices) {
        latestPrice.set(r.product_id, r.current_grosze);
        if (r.source === 'order') (orderPrices.get(r.product_id) ?? orderPrices.set(r.product_id, []).get(r.product_id)!).push(r.current_grosze);
      }
      const offer = new Map<string, { offerText: string | null; requiredQuantity: number | null }>();
      for (const r of offers) {
        if (r.offer_text !== null || !offer.has(r.product_id)) offer.set(r.product_id, { offerText: r.offer_text, requiredQuantity: r.required_quantity });
      }
      const recent = new Map<string, number>(in10.map((r) => [r.product_id, r.n]));

      return products.map((p) => {
        const q = qty.get(p.product_id) ?? [];
        const op = orderPrices.get(p.product_id) ?? [];
        const units = op.map((g) => unitPriceGrosze(g, 1, p.size)).filter((u): u is number => u !== null);
        const med = median(units);
        return {
          productId: p.product_id, name: p.name, brand: p.brand, categoryPath: JSON.parse(p.category_path), size: p.size,
          timesBought: q.length, lastBoughtAt: last.get(p.product_id) ?? null, usualQuantity: median(q),
          latestPriceGrosze: latestPrice.get(p.product_id) ?? null,
          offerText: offer.get(p.product_id)?.offerText ?? null, requiredQuantity: offer.get(p.product_id)?.requiredQuantity ?? null,
          medianUnitPriceGrosze: med === null ? null : Math.round(med), pricePoints: units.length,
          inCatalogue: p.in_catalogue === 1, boughtInLatest10: recent.get(p.product_id) ?? 0,
        };
      });
    },

    startSync(kind) {
      const r = db.prepare('INSERT INTO sync_runs (kind, started_at) VALUES (?, ?)').run(kind, new Date().toISOString());
      return Number(r.lastInsertRowid);
    },

    finishSync(id, status) {
      db.prepare('UPDATE sync_runs SET finished_at = ?, status = ? WHERE id = ?').run(new Date().toISOString(), status, id);
    },

    lastSyncStatus(kind) {
      const r = db.prepare('SELECT status FROM sync_runs WHERE kind = ? AND status IS NOT NULL ORDER BY id DESC LIMIT 1').get(kind) as
        | { status: SyncStatus }
        | undefined;
      return r ? r.status : null;
    },

    lastSyncClean(kind) {
      const r = db.prepare('SELECT status FROM sync_runs WHERE kind = ? ORDER BY id DESC LIMIT 1').get(kind) as
        | { status: SyncStatus | null }
        | undefined;
      return r?.status === 'ok';
    },

    lastSyncFinishedAt(kind) {
      const r = db.prepare("SELECT finished_at FROM sync_runs WHERE kind = ? AND status = 'ok' ORDER BY id DESC LIMIT 1").get(kind) as
        | { finished_at: string }
        | undefined;
      return r ? r.finished_at : null;
    },

    recordCorrection({ term, proposedProductId, chosenProductId, reason }) {
      const key = normaliseTerm(term);
      const now = stamp();
      transaction(() => {
        db.prepare(
          'INSERT INTO corrections (term, proposed_product_id, chosen_product_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(key, proposedProductId, chosenProductId, reason ?? null, now);
        if (chosenProductId === null) return;
        db.prepare('INSERT OR IGNORE INTO intents (term, brand) VALUES (?, NULL)').run(key);
        db.prepare(`
          INSERT INTO intent_products (term, product_id, times_chosen, last_chosen_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(term, product_id) DO UPDATE SET times_chosen = times_chosen + 1, last_chosen_at = excluded.last_chosen_at`)
          .run(key, chosenProductId, now);
      });
    },

    intentRules(term) {
      const rows = (term === undefined
        ? db.prepare('SELECT term, brand FROM intents ORDER BY term').all()
        : db.prepare('SELECT term, brand FROM intents WHERE term = ?').all(normaliseTerm(term))) as { term: string; brand: string | null }[];
      const products = db.prepare(
        'SELECT product_id, times_chosen FROM intent_products WHERE term = ? ORDER BY times_chosen DESC, last_chosen_at DESC',
      );
      const preferred = db.prepare(
        'SELECT product_id FROM intent_products WHERE term = ? AND times_chosen >= 2 ORDER BY last_chosen_at DESC LIMIT 1',
      );
      return rows.map((r) => ({
        term: r.term,
        brand: r.brand,
        preferredProductId: (preferred.get(r.term) as { product_id: string } | undefined)?.product_id ?? null,
        acceptedProductIds: (products.all(r.term) as { product_id: string }[]).map((p) => p.product_id),
      }));
    },

    setBrandFixed(term, brand) {
      db.prepare('INSERT INTO intents (term, brand) VALUES (?, ?) ON CONFLICT(term) DO UPDATE SET brand = excluded.brand')
        .run(normaliseTerm(term), brand);
    },

    deleteRule(term) {
      const key = normaliseTerm(term);
      transaction(() => {
        db.prepare('DELETE FROM intent_products WHERE term = ?').run(key);
        db.prepare('DELETE FROM intents WHERE term = ?').run(key);
      });
    },

    corrections(term) {
      const rows = (term === undefined
        ? db.prepare('SELECT * FROM corrections ORDER BY id').all()
        : db.prepare('SELECT * FROM corrections WHERE term = ? ORDER BY id').all(normaliseTerm(term))) as any[];
      return rows.map((r) => ({
        term: r.term, proposedProductId: r.proposed_product_id, chosenProductId: r.chosen_product_id,
        reason: r.reason, createdAt: r.created_at,
      }));
    },

    close() {
      db.close();
    },
  };
}
