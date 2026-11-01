import { lineCost, parseOffer, unitPriceGrosze } from './pricing.ts';
import { normaliseTerm } from './store.ts';
import type { IntentRule, ProductFacts } from './store.ts';

export type Candidate = ProductFacts & {
  lineCostGrosze: number | null;
  unitPriceGrosze: number | null;
  basis: 'preferred' | 'accepted' | 'history' | 'value';
  guess: boolean;
};

/**
 * Every word of the term starts a word of the name or brand. A term of 4 or more letters drops one final vowel so
 * inflected forms meet ("mleka", "mleko"), and the ending is limited so "maka" misses "Makaron" and "ser" misses "Serwetki".
 */
export function matchesTerm(term: string, f: Pick<ProductFacts, 'name' | 'brand'>): boolean {
  const words = normaliseTerm(term).split(' ').filter(Boolean);
  const hayWords = `${normaliseTerm(f.name)} ${normaliseTerm(f.brand)}`.split(/[\s\-\/]+/);
  const matches = (w: string) => {
    const stem = w.length >= 4 ? w.replace(/[aeiouy]$/, '') : w;
    return hayWords.some((h) => h.startsWith(stem) && h.length >= Math.min(w.length, 4) && h.length <= stem.length + 2);
  };
  return words.length > 0 && words.every(matches);
}

export function rankCandidates(term: string, quantity: number, facts: ProductFacts[], rule: IntentRule | null): Candidate[] {
  const brand = rule?.brand ? normaliseTerm(rule.brand) : null;
  const accepted = new Set(rule?.acceptedProductIds ?? []);
  const learned = new Set(rule?.learnedProductIds ?? []);
  // Only a product chosen at least twice leads. One chosen once stays an alternative behind what was bought.
  const group = (c: Candidate) =>
    c.basis === 'preferred' ? 0 : learned.has(c.productId) ? 1 : c.basis === 'history' ? 2 : c.basis === 'accepted' ? 3 : 4;

  const out: Candidate[] = [];
  for (const f of facts) {
    if (!f.inCatalogue || f.latestPriceGrosze === null) continue;
    if (brand !== null && normaliseTerm(f.brand) !== brand) continue;
    const isPreferred = f.productId === rule?.preferredProductId;
    const isAccepted = accepted.has(f.productId);
    if (!isPreferred && !isAccepted && !matchesTerm(term, f)) continue;
    const basis = isPreferred ? 'preferred' : learned.has(f.productId) ? 'accepted' : f.timesBought > 0 ? 'history' : isAccepted ? 'accepted' : 'value';
    // An offer applies only once the quantity reaches what it requires.
    const reached = f.requiredQuantity === null || quantity >= f.requiredQuantity;
    const cost = lineCost(f.latestPriceGrosze, reached ? parseOffer(f.offerText) : null, quantity);
    out.push({
      ...f, lineCostGrosze: cost, unitPriceGrosze: unitPriceGrosze(cost, quantity, f.size), basis, guess: basis === 'value',
    });
  }

  return out.sort((a, b) =>
    group(a) - group(b)
    || (a.basis === 'history' ? b.timesBought - a.timesBought : 0)
    || (a.unitPriceGrosze === null ? 1 : 0) - (b.unitPriceGrosze === null ? 1 : 0)
    || (a.unitPriceGrosze ?? 0) - (b.unitPriceGrosze ?? 0)
    || a.name.localeCompare(b.name, 'pl'));
}
