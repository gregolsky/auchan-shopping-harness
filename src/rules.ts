import { lineCost, parseOffer, unitPriceGrosze } from './pricing.ts';
import type { ProductFacts } from './store.ts';

const PERISHABLE = new Set([
  'Mleko, nabiał i jaja', 'Owoce, warzywa i zioła', 'Sery', 'Wędliny', 'Ryby i owoce morza', 'Mięso i drób',
  'Pieczywo i wyroby cukiernicze', 'Dania gotowe i wyroby garmażeryjne', 'Wypieki',
]);

/** Judged by the second-level category; an unknown category is treated as perishable. */
export function isPerishable(categoryPath: string[]): boolean {
  return categoryPath.length < 2 || PERISHABLE.has(categoryPath[1]);
}

export function capQuantity(facts: ProductFacts, wanted: number): { quantity: number; capped: boolean } {
  if (!isPerishable(facts.categoryPath)) return { quantity: wanted, capped: false };
  const cap = facts.usualQuantity === null ? 1 : Math.max(1, Math.ceil(facts.usualQuantity));
  const quantity = Math.min(wanted, cap);
  return { quantity, capped: quantity < wanted };
}

/**
 * For a quantity the user asked for: a note when it is above what they usually buy of a perishable product.
 * Their quantity is never cut; null when there is nothing to note or no usual quantity is known.
 */
export function perishableNote(facts: ProductFacts, wanted: number): string | null {
  if (facts.usualQuantity === null) return null;
  const cap = capQuantity(facts, wanted);
  return cap.capped ? `łatwo się psuje — zwykle kupujesz ${cap.quantity}` : null;
}

export function stockUp(facts: ProductFacts): { quantity: number; savingPercent: number } | null {
  if (isPerishable(facts.categoryPath) || facts.pricePoints < 3 || !facts.seenInLatestPromotions) return null;
  if (facts.latestPriceGrosze === null || facts.medianUnitPriceGrosze === null) return null;
  const quantity = facts.requiredQuantity ?? 2;
  const cost = lineCost(facts.latestPriceGrosze, parseOffer(facts.offerText), quantity);
  const unit = unitPriceGrosze(cost, quantity, facts.size);
  if (unit === null || unit * 100 > facts.medianUnitPriceGrosze * 80) return null;
  return { quantity, savingPercent: Math.round((1 - unit / facts.medianUnitPriceGrosze) * 100) };
}

export function isUsual(facts: ProductFacts): boolean {
  return facts.boughtInLatest10 >= 3;
}

export function lastBoughtText(facts: ProductFacts, now: Date): string | null {
  if (!facts.lastBoughtAt) return null;
  const ms = now.getTime() - new Date(facts.lastBoughtAt).getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  if (days === 0) return 'last bought today';
  if (days < 14) return `last bought ${days} ${days === 1 ? 'day' : 'days'} ago`;
  return `last bought ${Math.floor(days / 7)} weeks ago`;
}
