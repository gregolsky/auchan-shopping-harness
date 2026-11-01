import { lineCost, parseOffer, unitPriceGrosze } from './pricing.ts';
import { normaliseTerm } from './store.ts';
import type { IntentRule, ProductFacts } from './store.ts';

export type Candidate = ProductFacts & {
  lineCostGrosze: number | null;
  unitPriceGrosze: number | null;
  basis: 'preferred' | 'accepted' | 'history' | 'value';
  guess: boolean;
};

const GROUP = { preferred: 0, accepted: 1, history: 2, value: 3 } as const;

export function rankCandidates(term: string, quantity: number, facts: ProductFacts[], rule: IntentRule | null): Candidate[] {
  const words = normaliseTerm(term).split(/\s+/).filter(Boolean);
  const brand = rule?.brand ? normaliseTerm(rule.brand) : null;
  const accepted = new Set(rule?.acceptedProductIds ?? []);

  const out: Candidate[] = [];
  for (const f of facts) {
    if (!f.inCatalogue || f.latestPriceGrosze === null) continue;
    if (brand !== null && normaliseTerm(f.brand) !== brand) continue;
    const isPreferred = f.productId === rule?.preferredProductId;
    const isAccepted = accepted.has(f.productId);
    if (!isPreferred && !isAccepted) {
      const hay = `${normaliseTerm(f.name)} ${normaliseTerm(f.brand)}`;
      if (!words.every((w) => hay.includes(w))) continue;
    }
    const basis = isPreferred ? 'preferred' : isAccepted ? 'accepted' : f.timesBought > 0 ? 'history' : 'value';
    // An offer applies only once the quantity reaches what it requires.
    const reached = f.requiredQuantity === null || quantity >= f.requiredQuantity;
    const cost = lineCost(f.latestPriceGrosze, reached ? parseOffer(f.offerText) : null, quantity);
    out.push({
      ...f, lineCostGrosze: cost, unitPriceGrosze: unitPriceGrosze(cost, quantity, f.size), basis, guess: basis === 'value',
    });
  }

  return out.sort((a, b) =>
    GROUP[a.basis] - GROUP[b.basis]
    || (a.basis === 'history' ? b.timesBought - a.timesBought : 0)
    || (a.unitPriceGrosze === null ? 1 : 0) - (b.unitPriceGrosze === null ? 1 : 0)
    || (a.unitPriceGrosze ?? 0) - (b.unitPriceGrosze ?? 0)
    || a.name.localeCompare(b.name, 'pl'));
}
