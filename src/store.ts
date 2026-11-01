import { DatabaseSync } from 'node:sqlite';
import type { Product, PriceObservation } from './types.ts';
import type { parseDecoratedOrder } from './parse.ts';

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

export interface Store {
  saveOrder(parsed: ParsedOrder): void;
  hasOrder(orderId: string): boolean;
  /** Region of the most recently delivered stored order, or null if there are none. */
  latestOrderRegion(): string | null;
  savePromotions(parsed: PromotionsInput): void;
  recentOrders(limit: number): RecentOrder[];
  productHistory(query: string): ProductHistoryRow[];
  currentPromotions(opts: { boughtBefore?: boolean; limit: number }): PromotionRow[];
  startSync(kind: SyncKind): number;
  finishSync(id: number, status: SyncStatus): void;
  lastSyncStatus(kind: SyncKind): SyncStatus | null;
  /** True only if the latest run of this kind, finished or not, ended ok. A crashed run counts as not ok. */
  lastSyncClean(kind: SyncKind): boolean;
  /** ISO time of the latest successful sync of this kind, or null if none. */
  lastSyncFinishedAt(kind: SyncKind): string | null;
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

    close() {
      db.close();
    },
  };
}
