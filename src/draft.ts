import { matchesTerm, rankCandidates } from './candidates.ts';
import type { Candidate, Confidence } from './candidates.ts';
import { lineCost, parseOffer } from './pricing.ts';
import { capQuantity, isUsual, lastBoughtText, stockUp } from './rules.ts';
import { normaliseTerm } from './store.ts';
import { isBlockedProduct, type BlockedProduct } from './blacklist.ts';
import type { IntentRule, ProductFacts } from './store.ts';

export interface DraftInput {
  items: { term: string; quantity: number }[];
  includeUsual: boolean;
  budgetGrosze?: number;
  /** What the Auchan search found per normalised term, in Auchan's order (store.searchResults()). */
  searched?: Record<string, string[]>;
}

export interface DraftLine {
  term: string | null;
  productId: string;
  name: string;
  quantity: number;
  lineCostGrosze: number;
  reason: string;
  guess: boolean;
  capped: boolean;
  lastBought: string | null;
  confidence: Confidence;
  /** Why a medium or low line is doubtful; "" for high. */
  confidenceReason: string;
  imageUrl?: string | null;
  imageAlt?: string | null;
  alternatives: { productId: string; name: string; lineCostGrosze: number; confidence: Confidence; imageUrl?: string | null; imageAlt?: string | null }[];
}

export interface Draft {
  items: DraftLine[];
  stockUps: DraftLine[];
  promotions: DraftLine[];
  addOns: DraftLine[];
  unmatched: string[];
  blocked?: string[];
  totalGrosze: number;
  overBudgetGrosze: number | null;
}

/** Facts with a price and a place in the catalogue, the only products that can be put in a basket. */
type Buyable = ProductFacts & { latestPriceGrosze: number };
const buyable = <T extends ProductFacts>(f: T): f is T & { latestPriceGrosze: number } => f.inCatalogue && f.latestPriceGrosze !== null;

const CONF_RANK = { high: 0, medium: 1, low: 2 };

/** An offer counts only once the quantity reaches what it requires. */
function costAt(f: Buyable, quantity: number): number {
  const reached = f.requiredQuantity === null || quantity >= f.requiredQuantity;
  return lineCost(f.latestPriceGrosze, reached ? parseOffer(f.offerText) : null, quantity);
}

function basisReason(c: Candidate, term: string): string {
  switch (c.basis) {
    case 'preferred': return `your usual choice for ${term}`;
    case 'accepted': return `you chose this for ${term} before`;
    case 'history': return `bought ${c.timesBought} ${c.timesBought === 1 ? 'time' : 'times'}`;
    default: return 'guess: best unit price, not bought before';
  }
}

/** The stock-up saving a line would get at the stock-up quantity, which may not be the line's own. */
function savingNote(f: ProductFacts): string {
  const s = stockUp(f);
  return s ? `; ${s.savingPercent}% below its usual unit price at quantity ${s.quantity}` : '';
}

function line(f: Buyable, p: { term: string | null; quantity: number; reason: string; guess?: boolean; capped?: boolean; alternatives?: DraftLine['alternatives']; confidence?: Confidence; confidenceReason?: string }, now: Date): DraftLine {
  return {
    term: p.term, productId: f.productId, name: f.name, quantity: p.quantity, lineCostGrosze: costAt(f, p.quantity),
    reason: p.reason, guess: p.guess ?? false, capped: p.capped ?? false, lastBought: lastBoughtText(f, now),
    confidence: p.confidence ?? 'high', confidenceReason: p.confidenceReason ?? '', alternatives: p.alternatives ?? [],
    imageUrl: f.imageUrl, imageAlt: f.imageAlt,
  };
}

const brandAllowed = (r: IntentRule, f: ProductFacts) => !r.brand || normaliseTerm(f.brand) === normaliseTerm(r.brand);

/** The preferred product of a rule that replaced this one, if that rule allows it and it can be bought. */
function learnedSwap(f: ProductFacts, rules: IntentRule[], byId: Map<string, ProductFacts>): { rule: IntentRule; to: Buyable } | null {
  for (const rule of rules) {
    if (rule.preferredProductId === f.productId || !rule.replacedProductIds.includes(f.productId)) continue;
    const to = byId.get(rule.preferredProductId ?? '');
    if (to && buyable(to) && brandAllowed(rule, to)) return { rule, to };
  }
  return null;
}

/** A rule's fixed brand covers a product proposed under its term or matching it. */
const wrongBrand = (f: ProductFacts, rules: IntentRule[]) =>
  rules.some((r) => !brandAllowed(r, f) && (r.replacedProductIds.includes(f.productId) || matchesTerm(r.term, f)));

export function buildDraft(input: DraftInput, facts: ProductFacts[], rules: IntentRule[], now: Date, blocked?: readonly BlockedProduct[]): Draft {
  const allFacts = facts;
  facts = facts.filter((f) => !isBlockedProduct(f, blocked));
  const ruleByTerm = new Map(rules.map((r) => [normaliseTerm(r.term), r]));
  const byId = new Map(facts.map((f) => [f.productId, f]));
  const used = new Set<string>();
  const items: DraftLine[] = [];
  const unmatched: string[] = [];
  const blockedTerms: string[] = [];

  for (const { term, quantity } of input.items) {
    const capped = (f: ProductFacts) => capQuantity(f, quantity).quantity;
    const ranked = rankCandidates(term, capped, facts, ruleByTerm.get(normaliseTerm(term)) ?? null, input.searched?.[normaliseTerm(term)] ?? []).filter((c) => !used.has(c.productId));
    const top = ranked[0];
    if (!top || !buyable(top)) {
      (allFacts.some((f) => isBlockedProduct(f, blocked) && matchesTerm(term, f)) ? blockedTerms : unmatched).push(term);
      continue;
    }
    const cap = capQuantity(top, quantity);
    let reason = basisReason(top, term) + savingNote(top);
    if (cap.capped) reason += `; capped at ${cap.quantity} because it is perishable`;
    const alternatives = ranked.slice(1, 4).filter(buyable).sort((a, b) => CONF_RANK[a.confidence] - CONF_RANK[b.confidence]).map((c) => ({ productId: c.productId, name: c.name, lineCostGrosze: costAt(c, capped(c)), confidence: c.confidence, imageUrl: c.imageUrl, imageAlt: c.imageAlt }));
    used.add(top.productId);
    items.push(line(top, { term, quantity: cap.quantity, reason, guess: top.guess, capped: cap.capped, alternatives, confidence: top.confidence, confidenceReason: top.confidenceReason }, now));
  }

  // A wrong-brand product or one replaced by a live preferred product stays out of every group.
  const swaps = new Map<string, { rule: IntentRule; to: Buyable }>();
  for (const f of facts) {
    if (used.has(f.productId) || input.items.some((i) => matchesTerm(i.term, f))) continue;
    const swap = learnedSwap(f, rules, byId);
    if (swap) swaps.set(f.productId, swap);
    if (swap || wrongBrand(f, rules)) used.add(f.productId);
  }

  if (input.includeUsual) {
    for (const f of facts) {
      const swap = swaps.get(f.productId);
      if (swap && isUsual(f) && buyable(f) && !used.has(swap.to.productId)) {
        const wanted = Math.max(1, Math.ceil(f.usualQuantity ?? 1));
        const cap = capQuantity(swap.to, wanted);
        let reason = `your usual choice for ${swap.rule.term}` + savingNote(swap.to);
        if (cap.capped) reason += `; capped at ${cap.quantity} because it is perishable`;
        used.add(swap.to.productId);
        items.push(line(swap.to, { term: swap.rule.term, quantity: cap.quantity, reason, capped: cap.capped }, now));
        continue;
      }
      if (!isUsual(f) || !buyable(f) || used.has(f.productId)) continue;
      if (input.items.some((i) => matchesTerm(i.term, f))) continue;
      const wanted = Math.max(1, Math.ceil(f.usualQuantity ?? 1));
      const cap = capQuantity(f, wanted);
      let reason = `bought in ${f.boughtInLatest10} of the latest 10 orders` + savingNote(f);
      if (cap.capped) reason += `; capped at ${cap.quantity} because it is perishable`;
      used.add(f.productId);
      items.push(line(f, { term: null, quantity: cap.quantity, reason, capped: cap.capped }, now));
    }
  }

  const stockUps: DraftLine[] = facts
    .filter((f): f is Buyable => buyable(f) && !used.has(f.productId) && (isUsual(f) || (input.includeUsual && f.timesBought >= 1)))
    .flatMap((f) => {
      const s = stockUp(f);
      return s ? [{ s, f }] : [];
    })
    .sort((a, b) => b.s.savingPercent - a.s.savingPercent || a.f.name.localeCompare(b.f.name, 'pl'))
    .slice(0, 5)
    .map(({ s, f }) => line(f, { term: null, quantity: s.quantity, reason: `${s.savingPercent}% below its usual unit price` }, now));
  stockUps.forEach((l) => used.add(l.productId));

  const promotions = facts
    .filter((f): f is Buyable => buyable(f) && f.offerText !== null && f.timesBought >= 1 && !used.has(f.productId))
    .filter((f) => !capQuantity(f, f.requiredQuantity ?? 1).capped)
    .map((f) => {
      const quantity = f.requiredQuantity ?? 1;
      const offer = parseOffer(f.offerText);
      const saving = offer && offer.kind !== 'percent' ? f.latestPriceGrosze * quantity - lineCost(f.latestPriceGrosze, offer, quantity) : -1;
      return { f, quantity, saving };
    })
    .sort((a, b) => b.saving - a.saving || a.f.name.localeCompare(b.f.name, 'pl'))
    .slice(0, 10)
    .map(({ f, quantity }) => line(f, { term: null, quantity, reason: `on offer: ${f.offerText}` }, now));
  promotions.forEach((l) => used.add(l.productId));

  const addOns = facts
    .filter((f): f is Buyable => buyable(f) && f.timesBought >= 3 && !isUsual(f) && !used.has(f.productId))
    .sort((a, b) => (a.lastBoughtAt ?? '').localeCompare(b.lastBoughtAt ?? '') || a.name.localeCompare(b.name, 'pl'))
    .slice(0, 5)
    .map((f) => line(f, { term: null, quantity: Math.max(1, Math.ceil(f.usualQuantity ?? 1)), reason: `bought ${f.timesBought} times` }, now));

  const totalGrosze = items.reduce((s, l) => s + l.lineCostGrosze, 0);
  const over = input.budgetGrosze !== undefined && totalGrosze > input.budgetGrosze ? totalGrosze - input.budgetGrosze : null;
  return { items, stockUps, promotions, addOns, unmatched, blocked: blockedTerms, totalGrosze, overBudgetGrosze: over };
}
