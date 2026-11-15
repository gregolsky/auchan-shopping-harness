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
  /** Position (0 = first) in what the Auchan search found for the term; null when the search did not list it. */
  searchRank: number | null;
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
  // A stem under 4 letters ("mak" from "maka") would otherwise meet brand words such as "Makar", so it allows one extra letter only.
  const extra = w.length >= 4 && stem.length < 4 ? 1 : 2;
  return (h) => h.startsWith(stem) && h.length >= Math.min(w.length, 4) && h.length <= stem.length + extra;
}

const FLAVOUR_WORDS = new Set(['smaku', 'smak', 'aromat', 'aromatem', 'aromacie', 'smakowy', 'smakowe', 'smakowa', 'aromatyzowany', 'aromatyzowana', 'aromatyzowane']);
const PET_WORDS = new Set(['kota', 'kotow', 'kot', 'kotka', 'kotki', 'psa', 'psow', 'pies', 'psy', 'kociat', 'szczeniat', 'zwierzat', 'karma', 'przysmak', 'przysmaki']);
const CONNECTORS = new Set(['z', 'ze', 'w', 'we', 'i', 'oraz', 'na', 'po']);
const OF_CONNECTORS = new Set(['z', 'ze']);
/** A name that starts with one of these is the meat itself, so "Filet z piersi kurczaka" is not made from chicken breast. */
const CUT_WORDS = new Set(['filet', 'filety', 'poledwiczki', 'mieso', 'miesa']);
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * How sure we are that a product that matches the term is the thing meant. A flavour before the matched word or a pet
 * product is low (medium when the user chose the product); a term deep in the name, a mixture ("Marchew z groszkiem") or an unbought product is medium.
 */
export function matchConfidence(term: string, f: Pick<ProductFacts, 'name' | 'brand'>, boughtBefore: boolean, chosen = false): { confidence: Confidence; reason: string } {
  const termWords = normaliseTerm(term).split(' ').filter(Boolean);
  const nameWords = normaliseTerm(f.name).split(/[\s\-\/]+/).filter(Boolean);
  const first = termWords.length > 0 ? nameWords.findIndex(wordMatcher(termWords[0])) : -1;
  const last = termWords.length > 0 ? nameWords.findIndex(wordMatcher(termWords[termWords.length - 1])) : -1;

  if (first >= 0 && nameWords.slice(0, first).some((w) => FLAVOUR_WORDS.has(w))) return { confidence: chosen ? 'medium' : 'low', reason: 'term only in the flavour' };
  if (nameWords.some((w) => PET_WORDS.has(w) && !termWords.includes(w))) return { confidence: chosen ? 'medium' : 'low', reason: 'pet product' };
  // "Kiełbasa z piersi kurczaka": the term follows "z"/"ze" and the name does not start with it, so the product is made from it.
  // An irregular stem ("jabłko", "jabłek") misses the strict matcher, so a looser prefix is tried when it found nothing.
  const at = first >= 0 || termWords.length === 0 ? first : nameWords.findIndex((h) => h.startsWith(termWords[0].slice(0, Math.max(3, termWords[0].length - 2))));
  if (at >= 1 && OF_CONNECTORS.has(nameWords[at - 1]) && !termWords.some((t) => wordMatcher(t)(nameWords[0])) && !CUT_WORDS.has(nameWords[0])) {
    return { confidence: 'low', reason: 'product made from the term, not the term itself' };
  }
  if (first < 0 || first >= 2) return { confidence: 'medium', reason: 'term not at the start of the name' };
  const next = last >= 0 ? nameWords[last + 1] : undefined;
  if (next !== undefined && CONNECTORS.has(next) && last + 2 < nameWords.length && !termWords.includes(next)) {
    return { confidence: 'medium', reason: 'mixed with another ingredient' };
  }
  if (!boughtBefore) return { confidence: 'medium', reason: 'not bought before' };
  return { confidence: 'high', reason: '' };
}

/** quantity may depend on the product, as a perishable cap does; costs and unit prices use that quantity. */
export const SEARCH_REASON = 'z wyszukiwania Auchan';

/**
 * `searched` are the ids the Auchan search found for the term, in Auchan's order: they are candidates even when the name
 * does not match the term ("jajka" finds "Jaja ..."), rated medium unless the name match says better. The first hit leads among never-bought products.
 */
export function rankCandidates(term: string, quantity: number | ((f: ProductFacts) => number), facts: ProductFacts[], rule: IntentRule | null, searched: readonly string[] = []): Candidate[] {
  const searchRank = new Map<string, number>();
  searched.forEach((id, i) => { if (!searchRank.has(id)) searchRank.set(id, i); });
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
    const found = searchRank.get(f.productId) ?? null;
    if (!isPreferred && !isAccepted && !matched && found === null) continue;
    const basis = isPreferred ? 'preferred' : learned.has(f.productId) ? 'accepted' : f.timesBought > 0 ? 'history' : isAccepted ? 'accepted' : 'value';
    // An offer applies only once the quantity reaches what it requires.
    const q = quantityFor(f);
    const reached = f.requiredQuantity === null || q >= f.requiredQuantity;
    const cost = lineCost(f.latestPriceGrosze, reached ? parseOffer(f.offerText) : null, q);
    // A product the user chose through a rule, without the term matching it, is high: they chose it.
    const byName = matched ? matchConfidence(term, f, f.timesBought > 0 || isAccepted || learned.has(f.productId), isPreferred || isAccepted || learned.has(f.productId)) : null;
    const bySearch = found !== null ? { confidence: 'medium' as Confidence, reason: SEARCH_REASON } : null;
    const { confidence, reason } = isPreferred || isAccepted || learned.has(f.productId)
      ? (byName ?? { confidence: 'high' as const, reason: '' })
      : byName !== null && (bySearch === null || RANK[byName.confidence] <= RANK[bySearch.confidence]) ? byName : bySearch ?? { confidence: 'high' as const, reason: '' };
    out.push({
      ...f, lineCostGrosze: cost, unitPriceGrosze: unitPriceGrosze(cost, q, f.size), basis, guess: basis === 'value',
      confidence, confidenceReason: reason, searchRank: found,
    });
  }

  // Among products never bought, the one Auchan listed first leads.
  const lead = (c: Candidate) => (c.basis === 'value' && c.searchRank === 0 ? 0 : 1);
  return out.sort((a, b) =>
    group(a) - group(b)
    || lead(a) - lead(b)
    || RANK[a.confidence] - RANK[b.confidence]
    || (a.basis === 'history' ? b.timesBought - a.timesBought : 0)
    || (a.unitPriceGrosze === null ? 1 : 0) - (b.unitPriceGrosze === null ? 1 : 0)
    || (a.unitPriceGrosze ?? 0) - (b.unitPriceGrosze ?? 0)
    || a.name.localeCompare(b.name, 'pl'));
}
