import type { DatabaseSync } from 'node:sqlite';
import type { BasketLine } from './types.ts';

export const BASKET_SCHEMA = `
CREATE TABLE IF NOT EXISTS baskets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approved_at TEXT NOT NULL,
  unmatched TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS basket_lines (
  basket_id INTEGER NOT NULL REFERENCES baskets(id),
  term TEXT,
  product_id TEXT NOT NULL REFERENCES products(product_id),
  quantity REAL NOT NULL,
  approved_price_grosze INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fill_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  basket_id INTEGER NOT NULL REFERENCES baskets(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT CHECK (status IN ('ok','failed')),
  sent INTEGER,
  missing INTEGER,
  check_before_paying INTEGER
);
`;

const MAX_AGE_MS = 24 * 3_600_000;

export function basketMethods(db: DatabaseSync) {
  const product = db.prepare(`
    SELECT p.name, p.in_catalogue,
      (SELECT current_grosze FROM price_history h WHERE h.product_id = p.product_id ORDER BY h.seen_at DESC, h.rowid DESC LIMIT 1) AS price
    FROM products p WHERE p.product_id = ?`);
  const insBasket = db.prepare('INSERT INTO baskets (approved_at, unmatched) VALUES (?, ?)');
  const insLine = db.prepare('INSERT INTO basket_lines (basket_id, term, product_id, quantity, approved_price_grosze) VALUES (?, ?, ?, ?, ?)');

  return {
    approveBasket(lines: { term: string | null; productId: string; quantity: number }[], unmatched: string[], now: Date = new Date()): { basketId: number; totalGrosze: number } {
      const seen = new Set<string>();
      for (const l of lines) {
        if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 20) throw new Error(`Quantity must be a whole number from 1 to 20: ${l.productId}`);
        if (seen.has(l.productId)) throw new Error(`Duplicate product in basket: ${l.productId}`);
        seen.add(l.productId);
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        const basketId = Number(insBasket.run(now.toISOString(), JSON.stringify(unmatched)).lastInsertRowid);
        let total = 0;
        for (const l of lines) {
          const p = product.get(l.productId) as { in_catalogue: number; price: number | null } | undefined;
          if (!p || p.in_catalogue !== 1 || p.price === null) throw new Error(`Unknown or unavailable product: ${l.productId}`);
          insLine.run(basketId, l.term, l.productId, l.quantity, p.price);
          total += p.price * l.quantity;
        }
        db.exec('COMMIT');
        return { basketId, totalGrosze: Math.round(total) };
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },

    latestApprovedBasket(now: Date = new Date()): { basketId: number; approvedAt: string; lines: BasketLine[]; unmatched: string[] } | null {
      const b = db.prepare('SELECT id, approved_at, unmatched FROM baskets ORDER BY id DESC LIMIT 1').get() as
        { id: number; approved_at: string; unmatched: string } | undefined;
      if (!b || now.getTime() - Date.parse(b.approved_at) > MAX_AGE_MS) return null;
      const rows = db.prepare(`
        SELECT l.term, l.product_id, p.name, l.quantity, l.approved_price_grosze
        FROM basket_lines l JOIN products p ON p.product_id = l.product_id WHERE l.basket_id = ? ORDER BY l.rowid`).all(b.id) as any[];
      return {
        basketId: b.id, approvedAt: b.approved_at, unmatched: JSON.parse(b.unmatched),
        lines: rows.map((r) => ({ term: r.term, productId: r.product_id, name: r.name, quantity: r.quantity, approvedPriceGrosze: r.approved_price_grosze })),
      };
    },

    startFill(basketId: number): number {
      return Number(db.prepare('INSERT INTO fill_runs (basket_id, started_at) VALUES (?, ?)').run(basketId, new Date().toISOString()).lastInsertRowid);
    },

    finishFill(runId: number, r: { status: 'ok' | 'failed'; sent: number; missing: number; checkBeforePaying: number }): void {
      db.prepare('UPDATE fill_runs SET finished_at = ?, status = ?, sent = ?, missing = ?, check_before_paying = ? WHERE id = ?')
        .run(new Date().toISOString(), r.status, r.sent, r.missing, r.checkBeforePaying, runId);
    },
  };
}
