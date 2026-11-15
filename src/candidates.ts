import { lineCost, parseOffer, unitPriceGrosze } from './pricing.ts';
import { normaliseTerm } from './store.ts';
import type { IntentRule, ProductFacts } from './store.ts';

export type Candidate = ProductFacts & {
  lineCostGrosze: number | null;
  unitPriceGrosze: number | null;
  basis: 'preferred' | 'accepted' | 'history' | 'value';
  guess: boolean;
  confidence: Confidence;
  /** Short English reason for a medium or low rating; "" for high. */
  confidenceReason: string;
};

export type Confidence = 'high' | 'medium' | 'low';

/**
 * Every word of the term starts a word of the name or brand. A term of 4 or more letters drops one final vowel so
 * inflected forms meet ("mleka", "mleko"), and the ending is limited so "maka" misses "Makaron" and "ser" misses "Serwetki".
 */
export function matchesTerm(term: string, f: Pick<ProductFacts, 'name' | 'brand'>): boolean {
  const words = normaliseTerm(term).split(' ').filter(Boolean);
  const hayWords = `${normaliseTerm(f.name)} ${normaliseTerm(f.brand)}`.split(/[\s\-\/]+/);
  return words.length > 0 && words.every((w) => hayWords.some(wordMatcher(w)));
}

/** Whether a normalised name word meets a normalised term word under the stem rule above. */
function wordMatcher(w: string): (h: string) => boolean {
  const stem = w.length >= 4 ? w.replace(/[aeiouy]$/, '') : w;
  return (h) => h.startsWith(stem) && h.length >= Math.min(w.length, 4) && h.length <= stem.length + 2;
}

const FLAVOUR_WORDS = new Set(['smaku', 'smak', 'aromat', 'aromatem', 'aromacie']);
const PET_WORDS = new Set(['kota', 'kotow', 'psa', 'psow', 'kociat', 'szczeniat', 'karma', 'przysmak', 'przysmaki']);
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * How sure we are that a product that matches the term is the thing meant. A flavour before the matched word or a pet
 * product is low; a term deep in the name, a mixture ("Marchew z groszkiem") or an unbought product is medium.
 */
export function matchConfidence(term: string, f: Pick<ProductFacts, 'name' | 'brand'>, boughtBefore: boolean): { confidence: Confidence; reason: string } {
  const termWords = normaliseTerm(term).split(' ').filter(Boolean);
  const nameWords = normaliseTerm(f.name).split(/[\s\-\/]+/).filter(Boolean);
  const first = termWords.length > 0 ? nameWords.findIndex(wordMatcher(termWords[0])) : -1;
  const last = termWords.length > 0 ? nameWords.findIndex(wordMatcher(termWords[termWords.length - 1])) : -1;

  if (first >= 0 && nameWords.slice(0, first).some((w) => FLAVOUR_WORDS.has(w))) return { confidence: 'low', reason: 'term only in the flavour' };
  if (nameWords.some((w) => PET_WORDS.has(w) && !termWords.includes(w))) return { confidence: 'low', reason: 'pet product' };
  if (first < 0 || first >= 2) return { confidence: 'medium', reason: 'term not at the start of the name' };
  const next = last >= 0 ? nameWords[last + 1] : undefined;
  if ((next === 'z' || next === 'ze') && last + 2 < nameWords.length && !termWords.some((w) => w === 'z' || w === 'ze')) {
    return { confidence: 'medium', reason: 'mixed with another ingredient' };
  }
  if (!boughtBefore) return { confidence: 'medium', reason: 'not bought before' };
  return { confidence: 'high', reason: '' };
}

/** quantity may depend on the product, as a perishable cap does; costs and unit prices use that quantity. */
export function rankCandidates(term: string, quantity: number | ((f: ProductFacts) => number), facts: ProductFacts[], rule: IntentRule | null): Candidate[] {
  const brand = rule?.brand ? normaliseTerm(rule.brand) : null;
  const quantityFor = typeof quantity === 'function' ? quantity : () => quantity;
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
    const matched = matchesTerm(term, f);
    if (!isPreferred && !isAccepted && !matched) continue;
    const basis = isPreferred ? 'preferred' : learned.has(f.productId) ? 'accepted' : f.timesBought > 0 ? 'history' : isAccepted ? 'accepted' : 'value';
    // An offer applies only once the quantity reaches what it requires.
    const q = quantityFor(f);
    const reached = f.requiredQuantity === null || q >= f.requiredQuantity;
    const cost = lineCost(f.latestPriceGrosze, reached ? parseOffer(f.offerText) : null, q);
    // A product the user chose through a rule, without the term matching it, is high: they chose it.
    const { confidence, reason } = matched ? matchConfidence(term, f, f.timesBought > 0 || isAccepted || learned.has(f.productId)) : { confidence: 'high' as const, reason: '' };
    out.push({
      ...f, lineCostGrosze: cost, unitPriceGrosze: unitPriceGrosze(cost, q, f.size), basis, guess: basis === 'value',
      confidence, confidenceReason: reason,
    });
  }

  return out.sort((a, b) =>
    group(a) - group(b)
    || RANK[a.confidence] - RANK[b.confidence]
    || (a.basis === 'history' ? b.timesBought - a.timesBought : 0)
    || (a.unitPriceGrosze === null ? 1 : 0) - (b.unitPriceGrosze === null ? 1 : 0)
    || (a.unitPriceGrosze ?? 0) - (b.unitPriceGrosze ?? 0)
    || a.name.localeCompare(b.name, 'pl'));
}
