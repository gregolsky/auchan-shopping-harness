import { rankCandidates } from './candidates.ts';
import type { Candidate } from './candidates.ts';
import { lineCost, parseOffer } from './pricing.ts';
import { capQuantity, isUsual, lastBoughtText, stockUp } from './rules.ts';
import { normaliseTerm } from './store.ts';
import type { IntentRule, ProductFacts } from './store.ts';

export interface DraftInput {
  items: { term: string; quantity: number }[];
  includeUsual: boolean;
  budgetGrosze?: number;
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
  alternatives: { productId: string; name: string; lineCostGrosze: number }[];
}

export interface Draft {
  items: DraftLine[];
  stockUps: DraftLine[];
  promotions: DraftLine[];
  addOns: DraftLine[];
  unmatched: string[];
  totalGrosze: number;
  overBudgetGrosze: number | null;
}

/** Facts with a price and a place in the catalogue, the only products that can be put in a basket. */
type Buyable = ProductFacts & { latestPriceGrosze: number };
const buyable = <T extends ProductFacts>(f: T): f is T & { latestPriceGrosze: number } => f.inCatalogue && f.latestPriceGrosze !== null;

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

function line(f: Buyable, p: { term: string | null; quantity: number; reason: string; guess?: boolean; capped?: boolean; alternatives?: DraftLine['alternatives'] }, now: Date): DraftLine {
  return {
    term: p.term, productId: f.productId, name: f.name, quantity: p.quantity, lineCostGrosze: costAt(f, p.quantity),
    reason: p.reason, guess: p.guess ?? false, capped: p.capped ?? false, lastBought: lastBoughtText(f, now),
    alternatives: p.alternatives ?? [],
  };
}

export function buildDraft(input: DraftInput, facts: ProductFacts[], rules: IntentRule[], now: Date): Draft {
  const ruleByTerm = new Map(rules.map((r) => [normaliseTerm(r.term), r]));
  const used = new Set<string>();
  const items: DraftLine[] = [];
  const unmatched: string[] = [];

  for (const { term, quantity } of input.items) {
    const ranked = rankCandidates(term, quantity, facts, ruleByTerm.get(normaliseTerm(term)) ?? null).filter((c) => !used.has(c.productId));
    const top = ranked[0];
    if (!top || !buyable(top)) { unmatched.push(term); continue; }
    const cap = capQuantity(top, quantity);
    let reason = basisReason(top, term);
    if (cap.capped) reason += `; capped at ${cap.quantity} because it is perishable`;
    const alternatives = ranked.slice(1, 4).filter(buyable).map((c) => ({ productId: c.productId, name: c.name, lineCostGrosze: costAt(c, quantity) }));
    used.add(top.productId);
    items.push(line(top, { term, quantity: cap.quantity, reason, guess: top.guess, capped: cap.capped, alternatives }, now));
  }

  if (input.includeUsual) {
    for (const f of facts) {
      if (!isUsual(f) || !buyable(f) || used.has(f.productId)) continue;
      const cap = capQuantity(f, Math.max(1, Math.ceil(f.usualQuantity ?? 1)));
      let reason = `bought in ${f.boughtInLatest10} of the latest 10 orders`;
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
  return { items, stockUps, promotions, addOns, unmatched, totalGrosze, overBudgetGrosze: over };
}
