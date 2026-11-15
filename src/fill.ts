import { MAX_BATCH, Rejected, type CartAccess, type CartChange, type LimitedItem } from './http-worker.ts';
import { compareCart, parseCart, planFill, type BasketLine, type FillReport } from './cart.ts';

export interface FillOptions {
  onProgress?(sent: number, total: number): void;
}

const isOutOfStock = (l: LimitedItem) => l.addedAmount === 0 || l.reason === 'OUT_OF_STOCK';

export async function fillCart(cart: CartAccess, basket: BasketLine[], o: FillOptions = {}): Promise<FillReport & { sent: number }> {
  const before = parseCart(await cart.readCart());
  const plan = planFill(basket, before.lines);
  const total = plan.send.length;
  const outOfStock = new Set<string>();
  let sent = 0;

  const send = async (changes: CartChange[]) => {
    for (const l of await cart.applyQuantities(changes)) if (isOutOfStock(l)) outOfStock.add(l.productId);
    sent += changes.length;
    o.onProgress?.(sent, total);
  };

  for (let i = 0; i < total; i += MAX_BATCH) {
    const chunk = plan.send.slice(i, i + MAX_BATCH);
    try {
      await send(chunk);
    } catch (e) {
      if (!(e instanceof Rejected) || chunk.length < 2) {
        if (e instanceof Rejected) continue; // a single rejected change is skipped
        throw e;
      }
      // Re-plan against a fresh cart so nothing the batch may have added is added twice.
      const ids = new Set(chunk.map((c) => c.productId));
      const fresh = parseCart(await cart.readCart());
      for (const change of planFill(basket.filter((b) => ids.has(b.productId)), fresh.lines).send) {
        try {
          await send([change]);
        } catch (e2) {
          if (!(e2 instanceof Rejected)) throw e2;
        }
      }
    }
  }

  const after = parseCart(await cart.readCart());
  return { ...compareCart(basket, before.lines, after, [...outOfStock]), sent };
}
