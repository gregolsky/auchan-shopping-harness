import type { CartChange } from './http-worker.ts';
import { ShapeError } from './parse.ts';

export interface CartLine {
  productId: string;
  quantity: number;
  unitPriceGrosze: number | null;
  lineTotalGrosze: number | null;
}
export interface BasketLine {
  term: string | null;
  productId: string;
  name: string;
  quantity: number;
  approvedPriceGrosze: number;
}
export interface FillPlan {
  send: CartChange[];
  alreadyEnough: BasketLine[];
  extras: CartLine[];
}
export interface PriceNote {
  productId: string;
  name: string;
  approvedGrosze: number;
  nowGrosze: number;
  risePercent: number;
}
export interface FillReport {
  added: BasketLine[];
  alreadyEnough: BasketLine[];
  extras: CartLine[];
  missing: BasketLine[];
  outOfStock: BasketLine[];
  checkBeforePaying: PriceNote[];
  smallRises: PriceNote[];
  cartTotalGrosze: number | null;
}

const EPS = 1e-9;

function grosze(v: unknown): number | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const n = typeof v === 'number' ? v : parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function parseCart(json: unknown): { lines: CartLine[]; totalGrosze: number | null } {
  const root = json as any;
  if (root === null || typeof root !== 'object' || !Array.isArray(root.items)) throw new ShapeError('cart response has no items list');
  const lines = root.items.map((it: any): CartLine => {
    if (
      it === null || typeof it !== 'object' ||
      typeof it.productId !== 'string' || it.productId === '' ||
      typeof it.quantity !== 'number' || !Number.isFinite(it.quantity)
    ) {
      throw new ShapeError('cart item has no product id or quantity');
    }
    return {
      productId: it.productId,
      quantity: it.quantity,
      unitPriceGrosze: grosze(it.finalPrice?.amount),
      lineTotalGrosze: grosze(it.totalPrices?.finalPrice?.amount),
    };
  });
  return { lines, totalGrosze: grosze(root.totals?.itemPriceAfterPromos?.amount) };
}

function sumBy<T extends { productId: string }>(rows: T[], qty: (r: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.productId, (m.get(r.productId) ?? 0) + qty(r));
  return m;
}

/** Delta only: sends what is missing, never lowers or removes anything. */
export function planFill(basket: BasketLine[], cart: CartLine[]): FillPlan {
  const targets = sumBy(basket, (b) => b.quantity);
  const inCart = sumBy(cart, (c) => c.quantity);
  const send: CartChange[] = [];
  for (const [productId, target] of targets) {
    const diff = target - (inCart.get(productId) ?? 0);
    if (diff > EPS) send.push({ productId, quantity: diff });
  }
  const sending = new Set(send.map((s) => s.productId));
  return {
    send,
    alreadyEnough: basket.filter((b) => !sending.has(b.productId)),
    extras: cart.filter((c) => !targets.has(c.productId)),
  };
}

export function compareCart(
  basket: BasketLine[],
  before: CartLine[],
  after: { lines: CartLine[]; totalGrosze: number | null },
  outOfStock: string[] = [],
): FillReport {
  const plan = planFill(basket, before);
  const targets = sumBy(basket, (b) => b.quantity);
  const now = sumBy(after.lines, (c) => c.quantity);
  const short = (b: BasketLine) => (now.get(b.productId) ?? 0) < (targets.get(b.productId) ?? 0) - EPS;
  const skipped = new Set(outOfStock);
  const enough = new Set(plan.alreadyEnough);

  const afterPrice = new Map<string, number>();
  for (const l of after.lines) if (l.unitPriceGrosze !== null) afterPrice.set(l.productId, l.unitPriceGrosze);

  const checkBeforePaying: PriceNote[] = [];
  const smallRises: PriceNote[] = [];
  const seen = new Set<string>();
  for (const b of basket) {
    const nowGrosze = afterPrice.get(b.productId);
    if (nowGrosze === undefined || seen.has(b.productId) || b.approvedPriceGrosze <= 0) continue;
    seen.add(b.productId);
    const diff = nowGrosze - b.approvedPriceGrosze;
    if (diff <= 0) continue;
    const note: PriceNote = {
      productId: b.productId,
      name: b.name,
      approvedGrosze: b.approvedPriceGrosze,
      nowGrosze,
      risePercent: Math.round((diff / b.approvedPriceGrosze) * 100),
    };
    (diff * 10 > b.approvedPriceGrosze ? checkBeforePaying : smallRises).push(note);
  }

  return {
    added: basket.filter((b) => !enough.has(b) && !short(b)),
    alreadyEnough: plan.alreadyEnough,
    extras: after.lines.filter((c) => !targets.has(c.productId)),
    missing: basket.filter((b) => short(b) && !skipped.has(b.productId)),
    outOfStock: basket.filter((b) => short(b) && skipped.has(b.productId)),
    checkBeforePaying,
    smallRises,
    cartTotalGrosze: after.totalGrosze,
  };
}
