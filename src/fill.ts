import { MAX_BATCH, MAX_QUANTITY, Rejected, UUID, type CartAccess, type CartChange, type LimitedItem } from './http-worker.ts';
import { Refused } from './worker.ts';
import { compareCart, parseCart, planFill, type BasketLine, type FillReport, type LimitNote } from './cart.ts';

type ParsedCart = ReturnType<typeof parseCart>;

export interface FillOptions {
  onProgress?(sent: number, total: number): void;
  /** Called once with what is about to be sent, before the first POST. */
  onPlan?(plan: { count: number; totalGrosze: number }): void;
  /** A cart already read for planning, so the fill does not read it again. */
  start?: ParsedCart;
  /** The cart as it was before the whole run; a rerun after login compares against it. Defaults to the cart read here. */
  baseline?: ParsedCart;
  /** Products sent so far, kept across a rerun after login. */
  tally?: { sent: number };
}

const sendable = (c: CartChange): boolean => UUID.test(c.productId) && Number.isInteger(c.quantity) && c.quantity >= 1 && c.quantity <= MAX_QUANTITY;
/** Out of stock means nothing went in; a partial add or any other limit is reported as missing, with its numbers. */
const MAX_REJECTIONS = 3;
const isOutOfStock = (l: LimitedItem) => l.reason === 'OUT_OF_STOCK' && l.addedAmount === 0;

export async function fillCart(cart: CartAccess, basket: BasketLine[], o: FillOptions = {}): Promise<FillReport & { sent: number }> {
  const start = o.start ?? parseCart(await cart.readCart());
  const before = o.baseline ?? start;
  const tally = o.tally ?? { sent: 0 };
  const plan = planFill(basket, start.lines);
  // Changes applyQuantities would refuse are skipped up front, so they cannot stop the fill partway; they end in `missing`.
  plan.send = plan.send.filter(sendable);
  const total = plan.send.length;
  const price = new Map(basket.map((b) => [b.productId, b.approvedPriceGrosze]));
  o.onPlan?.({ count: total, totalGrosze: plan.send.reduce((s, c) => s + (price.get(c.productId) ?? 0) * c.quantity, 0) });
  const outOfStock = new Set<string>();
  const limits: Record<string, LimitNote> = {};
  let processed = 0;
  let rejections = 0;
  /** Counts a refusal; a single line refused, or the third refusal overall, means Auchan is saying no: stop. */
  const names = new Map(basket.map((b) => [b.productId, b.name]));
  const refused = (single: boolean, productId: string) => {
    rejections++;
    if (single || rejections >= MAX_REJECTIONS) throw new Refused(productId, names.get(productId) ?? '');
  };

  const tick = (n: number) => {
    processed += n;
    o.onProgress?.(processed, total);
  };
  const send = async (changes: CartChange[]) => {
    const limited = await cart.applyQuantities(changes);
    const none = new Set(limited.filter((l) => l.addedAmount === 0).map((l) => l.productId));
    for (const l of limited) {
      if (isOutOfStock(l)) outOfStock.add(l.productId);
      else limits[l.productId] = { reason: l.reason, added: l.addedAmount, requested: l.requestedAmount };
    }
    tally.sent += changes.filter((c) => !none.has(c.productId)).length;
    tick(changes.length);
  };

  for (let i = 0; i < total; i += MAX_BATCH) {
    const chunk = plan.send.slice(i, i + MAX_BATCH);
    try {
      await send(chunk);
    } catch (e) {
      if (!(e instanceof Rejected)) throw e;
      refused(chunk.length === 1, chunk[0].productId);
      // Re-plan against a fresh cart so nothing the batch may have added is added twice.
      const settled = processed + chunk.length;
      const ids = new Set(chunk.map((c) => c.productId));
      const fresh = parseCart(await cart.readCart());
      for (const change of planFill(basket.filter((b) => ids.has(b.productId)), fresh.lines).send.filter(sendable)) {
        try {
          await send([change]);
        } catch (e2) {
          if (!(e2 instanceof Rejected)) throw e2;
          refused(true, change.productId);
        }
      }
      if (processed < settled) tick(settled - processed); // products the fresh cart already had
    }
  }

  const after = parseCart(await cart.readCart());
  return { ...compareCart(basket, before.lines, after, [...outOfStock], limits), sent: tally.sent };
}
