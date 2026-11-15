import { Rejected, type CartAccess, type CartChange, type LimitedItem } from '../../src/http-worker.ts';

export interface FakeCart extends CartAccess {
  quantities: Record<string, number>;
  applyCalls: CartChange[][];
  readCalls: number;
}

/** In-memory cart; applying is additive, like the real site. Every product costs 1.00. */
export function fakeCart(
  initial: Record<string, number>,
  opts: { reject?: string[]; outOfStock?: string[]; loseResponseOnce?: boolean } = {},
): FakeCart {
  let lose = opts.loseResponseOnce ?? false;
  const cart: FakeCart = {
    quantities: { ...initial },
    applyCalls: [],
    readCalls: 0,
    async readCart() {
      cart.readCalls++;
      const items = Object.entries(cart.quantities).map(([productId, quantity]) => ({
        productId,
        quantity,
        finalPrice: { amount: '1.00' },
        totalPrices: { finalPrice: { amount: quantity.toFixed(2) } },
      }));
      const sum = items.reduce((s, i) => s + i.quantity, 0);
      return { items, totals: { itemPriceAfterPromos: { amount: sum.toFixed(2) } } };
    },
    async applyQuantities(changes) {
      cart.applyCalls.push(changes);
      if (changes.some((c) => opts.reject?.includes(c.productId))) throw new Rejected(400);
      const limited: LimitedItem[] = [];
      for (const c of changes) {
        if (opts.outOfStock?.includes(c.productId)) {
          limited.push({ productId: c.productId, reason: 'OUT_OF_STOCK', requestedAmount: c.quantity, addedAmount: 0 });
          continue;
        }
        cart.quantities[c.productId] = (cart.quantities[c.productId] ?? 0) + c.quantity;
      }
      if (lose) {
        lose = false;
        throw new Error('request timed out after 30 s');
      }
      return limited;
    },
  };
  return cart;
}
