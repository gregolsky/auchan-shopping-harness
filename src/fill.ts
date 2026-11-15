import { MAX_BATCH, Rejected, UUID, type CartAccess, type CartChange, type LimitedItem } from './http-worker.ts';
import { compareCart, parseCart, planFill, type BasketLine, type FillReport } from './cart.ts';

export interface FillOptions {
  onProgress?(sent: number, total: number): void;
}

const sendable = (c: CartChange): boolean => UUID.test(c.productId) && Number.isFinite(c.quantity) && c.quantity > 0 && c.quantity <= 100;
const isOutOfStock = (l: LimitedItem) => l.addedAmount === 0 || l.reason === 'OUT_OF_STOCK';

export async function fillCart(cart: CartAccess, basket: BasketLine[], o: FillOptions = {}): Promise<FillReport & { sent: number }> {
  const before = parseCart(await cart.readCart());
  const plan = planFill(basket, before.lines);
  // Changes applyQuantities would refuse are skipped up front, so they cannot stop the fill partway; they end in `missing`.
  plan.send = plan.send.filter(sendable);
  const total = plan.send.length;
  const outOfStock = new Set<string>();
  let sent = 0;
  let processed = 0;

  const tick = (n: number) => {
    processed += n;
    o.onProgress?.(processed, total);
  };
  const send = async (changes: CartChange[]) => {
    const limited = await cart.applyQuantities(changes);
    const none = new Set(limited.filter((l) => l.addedAmount === 0).map((l) => l.productId));
    for (const l of limited) if (isOutOfStock(l)) outOfStock.add(l.productId);
    sent += changes.filter((c) => !none.has(c.productId)).length;
    tick(changes.length);
  };

  for (let i = 0; i < total; i += MAX_BATCH) {
    const chunk = plan.send.slice(i, i + MAX_BATCH);
    try {
      await send(chunk);
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      if (chunk.length === 1) {
        tick(1); // a single rejected change is skipped
        continue;
      }
      // Re-plan against a fresh cart so nothing the batch may have added is added twice.
      const settled = processed + chunk.length;
      const ids = new Set(chunk.map((c) => c.productId));
      const fresh = parseCart(await cart.readCart());
      for (const change of planFill(basket.filter((b) => ids.has(b.productId)), fresh.lines).send.filter(sendable)) {
        try {
          await send([change]);
        } catch (e2) {
          if (!(e2 instanceof Rejected)) throw e2;
          tick(1);
        }
      }
      if (processed < settled) tick(settled - processed); // products the fresh cart already had
    }
  }

  const after = parseCart(await cart.readCart());
  return { ...compareCart(basket, before.lines, after, [...outOfStock]), sent };
}
