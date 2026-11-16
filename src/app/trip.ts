import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Confidence } from '../candidates.ts';
import type { Draft, DraftLine } from '../draft.ts';
import type { PaymentReport, PaymentRow } from '../cart.ts';
import { validImageUrl } from '../parse.ts';
import { normaliseTerm } from '../store.ts';
import { validateOps } from './ops.ts';
import type { LineView, Op } from './ops.ts';

export type Step = 'dane' | 'szkic' | 'doprecyzowanie' | 'zatwierdzenie' | 'koszyk' | 'platnosc';
/** baseCostGrosze is the cost at baseQuantity; lineCostGrosze is derived from it so quantity changes never drift. */
export interface TripCandidate { productId: string; retailerProductId?: string; latestPriceSeenAt?: string; name: string; lineCostGrosze: number; confidence: Confidence; baseCostGrosze?: number; baseQuantity?: number; imageUrl?: string | null; imageAlt?: string | null; categoryPath?: string[] }
export interface TripLine {
  lineKey: string; term: string | null; note: string; productId: string; name: string; quantity: number;
  lineCostGrosze: number; reason: string; confidence: Confidence; confidenceReason: string;
  retailerProductId?: string; latestPriceSeenAt?: string;
  candidates: TripCandidate[]; proposedProductId: string; question: { text: string; options: string[] } | null;
  included: boolean; kind: 'item' | 'suggestion';
  /** A low match kept out of the basket until the user picks a product or skips it; it still blocks approval. */
  held?: boolean;
  imageUrl?: string | null; imageAlt?: string | null;
  categoryPath?: string[];
}
/** A term with no product yet; it keeps the parsed quantity (1..20) and note so a later search drafts it as asked. */
export interface UnmatchedTerm { term: string; hint: string; quantity?: number; note?: string }
export interface Proposal { id: string; ops: Op[]; dropped: number; source: 'claude' | 'fallback' }
export interface Trip {
  note: string; step: Step; mode: 'claude' | 'fallback'; lines: TripLine[]; unmatched: UnmatchedTerm[];
  messages: string[]; proposal: Proposal | null; updatedAt: string; reportText?: string | null; reportData?: PaymentReport | null;
  /** Auchan answered the fill with a block (403): approving again is refused until a new trip is started. */
  blocked?: boolean;
}
export interface Correction { term: string; proposedProductId: string | null; chosenProductId: string | null; reason?: string }

const MAX_QUANTITY = 20;

export function emptyTrip(now: Date): Trip {
  return { note: '', step: 'dane', mode: 'claude', lines: [], unmatched: [], messages: [], proposal: null, updatedAt: now.toISOString(), reportText: null, reportData: null };
}

export function lineKeyFor(term: string | null, productId: string): string {
  return term === null ? `p:${productId}` : `t:${normaliseTerm(term)}`;
}

function tripLine(d: DraftLine, kind: TripLine['kind'], notes: Record<string, string>): TripLine {
  const cand = (c: { productId: string; retailerProductId?: string; latestPriceSeenAt?: string; name: string; lineCostGrosze: number; confidence: Confidence; imageUrl?: string | null; imageAlt?: string | null; categoryPath?: string[] }): TripCandidate =>
    ({ ...c, baseCostGrosze: c.lineCostGrosze, baseQuantity: d.quantity });
  const own = cand(d);
  const others = d.alternatives.filter((a) => a.productId !== d.productId).map(cand);
  const line: TripLine = {
    lineKey: lineKeyFor(d.term, d.productId), term: d.term,
    note: d.term === null ? '' : (notes[d.term] ?? notes[normaliseTerm(d.term)] ?? ''),
    productId: d.productId, name: d.name, quantity: d.quantity, lineCostGrosze: d.lineCostGrosze, reason: d.reason,
    confidence: d.confidence, confidenceReason: d.confidenceReason, candidates: [own, ...others],
    proposedProductId: d.productId, question: null, included: kind === 'item', kind, imageUrl: d.imageUrl ?? null, imageAlt: d.imageAlt ?? null,
    ...(d.categoryPath ? { categoryPath: d.categoryPath } : {}),
    ...(d.retailerProductId ? { retailerProductId: d.retailerProductId } : {}),
    ...(d.latestPriceSeenAt ? { latestPriceSeenAt: d.latestPriceSeenAt } : {}),
  };
  // The planner can suggest more than the app allows; the line is cut to the limit and says so.
  if (d.quantity > MAX_QUANTITY) return { ...withQuantity(line, MAX_QUANTITY), reason: `${d.reason}; ilość ograniczona do ${MAX_QUANTITY}` };
  if (d.quantity < 1) return withQuantity(line, 1);
  return line;
}

const CONFIDENCE_ORDER: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** Candidate ids a question may offer, best first, at most 3. A low candidate is never offered, except the product the line currently holds. */
export function questionOptions(l: TripLine): string[] {
  return l.candidates
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.confidence !== 'low' || (c.productId === l.productId && l.held !== true))
    .sort((a, b) => CONFIDENCE_ORDER[a.c.confidence] - CONFIDENCE_ORDER[b.c.confidence] || a.i - b.i)
    .slice(0, 3)
    .map((x) => x.c.productId);
}

/** A low match is not put in the basket silently: the line waits, out of the basket, for a product or a skip. */
function holdLow(l: TripLine): TripLine {
  if (l.term === null || l.kind !== 'item' || l.confidence !== 'low') return l;
  const held = { ...l, included: false, held: true };
  return { ...held, question: { text: `Nie mam pewnego dopasowania dla „${l.term}”. Wybierz produkt albo zdecyduj, co z tą pozycją zrobić.`, options: questionOptions(held) } };
}

/** Adds lines for new keys only; an existing line (the user's choice, quantity, included flag) is kept untouched. */
export function tripFromDraft(trip: Trip, draft: Draft, notes: Record<string, string>, items: { term: string; quantity: number; note: string }[] = []): Trip {
  const have = new Set(trip.lines.map((l) => l.lineKey));
  const added: TripLine[] = [];
  const all: [DraftLine, TripLine['kind']][] = [
    ...draft.items.map((d): [DraftLine, TripLine['kind']] => [d, 'item']),
    ...[...draft.stockUps, ...draft.promotions, ...draft.addOns].map((d): [DraftLine, TripLine['kind']] => [d, 'suggestion']),
  ];
  for (const [d, kind] of all) {
    const l = holdLow(tripLine(d, kind, notes));
    if (have.has(l.lineKey)) continue;
    have.add(l.lineKey);
    added.push(l);
  }
  const lines = [...trip.lines, ...added];
  const matched = new Set(lines.flatMap((l) => (l.term === null ? [] : [normaliseTerm(l.term)])));
  const unmatched = trip.unmatched.filter((u) => !matched.has(normaliseTerm(u.term)));
  const seen = new Set(unmatched.map((u) => normaliseTerm(u.term)));
  for (const term of draft.unmatched) {
    const n = normaliseTerm(term);
    if (!matched.has(n) && !seen.has(n)) { seen.add(n); unmatched.push({ term, hint: '', ...wanted(items, term) }); }
  }
  return { ...trip, lines, unmatched };
}

const clampQuantity = (n: number): number => Math.min(MAX_QUANTITY, Math.max(1, Math.trunc(n) || 1));

/** The quantity and note asked for a term, if any item names it. */
function wanted(items: { term: string; quantity: number; note: string }[], term: string): Pick<UnmatchedTerm, 'quantity' | 'note'> {
  const it = items.find((x) => normaliseTerm(x.term) === normaliseTerm(term));
  return it ? { quantity: clampQuantity(it.quantity), note: it.note } : {};
}

export function lineViews(trip: Trip): LineView[] {
  return trip.lines.map((l) => ({ lineKey: l.lineKey, candidateIds: l.candidates.map((c) => c.productId) }));
}

const costAt = (c: TripCandidate, from: number, quantity: number) => Math.round(((c.baseCostGrosze ?? c.lineCostGrosze) / (c.baseQuantity ?? from)) * quantity);

function withQuantity(l: TripLine, quantity: number): TripLine {
  const candidates = l.candidates.map((c) => ({ ...c, lineCostGrosze: costAt(c, l.quantity, quantity) }));
  const own = candidates.find((c) => c.productId === l.productId);
  return { ...l, quantity, candidates, lineCostGrosze: own ? own.lineCostGrosze : Math.round((l.lineCostGrosze / l.quantity) * quantity) };
}

/** A product the user picked counts as settled: high confidence, no reason to ask again. */
function withProduct(l: TripLine, productId: string): TripLine {
  const c = l.candidates.find((x) => x.productId === productId);
  if (!c) return l;
  const { categoryPath: _oldCategory, retailerProductId: _oldRetailer, latestPriceSeenAt: _oldSeen, ...rest } = l;
  return { ...rest, productId, ...(c.retailerProductId ? { retailerProductId: c.retailerProductId } : {}), ...(c.latestPriceSeenAt ? { latestPriceSeenAt: c.latestPriceSeenAt } : {}), name: c.name, imageUrl: c.imageUrl ?? null, imageAlt: c.imageAlt ?? null, ...(c.categoryPath ? { categoryPath: c.categoryPath } : {}), lineCostGrosze: c.lineCostGrosze, confidence: 'high', confidenceReason: '', question: null, included: l.held ? true : l.included, held: false };
}

function pick(l: TripLine, productId: string): TripLine | null {
  return l.candidates.some((c) => c.productId === productId) ? withProduct(l, productId) : null;
}

function removal(l: TripLine): Correction[] {
  return l.term === null ? [] : [{ term: l.term, proposedProductId: l.proposedProductId, chosenProductId: null }];
}

export function applyOps(trip: Trip, ops: Op[]): { trip: Trip; corrections: Correction[]; addTerms: { term: string; quantity: number; note: string }[] } {
  let lines = trip.lines;
  const messages = [...trip.messages];
  const unmatched = [...trip.unmatched];
  const touched = new Map<string, TripLine>();
  const addTerms: { term: string; quantity: number; note: string }[] = [];
  const asked = ops.flatMap((o) => (o.op === 'add' ? [{ term: o.term, quantity: o.quantity, note: o.note ?? '' }] : []));
  const update = (key: string, f: (l: TripLine) => TripLine) => { lines = lines.map((l) => (l.lineKey === key ? f(l) : l)); };
  for (const op of ops) {
    const line = 'lineKey' in op ? lines.find((l) => l.lineKey === op.lineKey) : undefined;
    switch (op.op) {
      case 'add': addTerms.push({ term: op.term, quantity: op.quantity, note: op.note ?? '' }); break;
      case 'say': messages.push(op.text); break;
      case 'unmatched': {
        const i = unmatched.findIndex((u) => normaliseTerm(u.term) === normaliseTerm(op.term));
        const ask = wanted(asked, op.term);
        if (i >= 0) unmatched[i] = { ...unmatched[i]!, ...ask, term: op.term, hint: op.hint }; else unmatched.push({ term: op.term, hint: op.hint, ...ask });
        break;
      }
      case 'choose': {
        if (!line) break;
        const r = pick(line, op.productId);
        if (r === null) break;
        if (line.term !== null && !touched.has(line.lineKey)) touched.set(line.lineKey, line);
        update(line.lineKey, () => r);
        break;
      }
      case 'remove':
        if (!line) break;
        if (line.term !== null && !touched.has(line.lineKey)) touched.set(line.lineKey, line);
        lines = lines.filter((l) => l !== line);
        break;
      case 'setQuantity':
        if (line && Number.isInteger(op.quantity) && op.quantity >= 1 && op.quantity <= 20) update(line.lineKey, (l) => withQuantity(l, op.quantity));
        break;
      case 'ask': {
        if (!line) break;
        const known = op.options.filter((id) => line.candidates.some((c) => c.productId === id));
        if (known.length === 0) break;
        // Like the planner's questions: no low candidate is offered. With none left the question offers only skip / add by hand.
        const options = known
          .filter((id) => line.candidates.some((c) => c.productId === id && (c.confidence !== 'low' || (c.productId === line.productId && line.held !== true))))
          .slice(0, 3);
        update(line.lineKey, (l) => ({ ...l, question: { text: op.question, options } }));
        break;
      }
    }
  }
  const corrections: Correction[] = [];
  for (const [key, first] of touched) {
    const final = lines.find((l) => l.lineKey === key);
    if (!final) corrections.push(...removal(first));
    else if (final.productId !== first.proposedProductId) corrections.push({ term: first.term!, proposedProductId: first.proposedProductId, chosenProductId: final.productId });
  }
  return { trip: { ...trip, lines, messages, unmatched }, corrections, addTerms };
}

export function answer(trip: Trip, lineKey: string, productId: string | null): { trip: Trip; corrections: Correction[] } {
  const line = trip.lines.find((l) => l.lineKey === lineKey);
  if (!line) return { trip, corrections: [] };
  if (productId === null) return { trip: { ...trip, lines: trip.lines.filter((l) => l !== line) }, corrections: removal(line) };
  const picked = line.question !== null && !line.question.options.includes(productId) ? null : pick(line, productId);
  if (picked === null) return { trip, corrections: [] };
  const corrections: Correction[] = line.term !== null && productId !== line.proposedProductId
    ? [{ term: line.term, proposedProductId: line.proposedProductId, chosenProductId: productId }] : [];
  return { trip: { ...trip, lines: trip.lines.map((l) => (l === line ? picked : l)) }, corrections };
}

/** The user picked any candidate of a line (also outside its question): the line takes it and stops being asked or held. */
export function chooseProduct(trip: Trip, lineKey: string, productId: string): { trip: Trip; corrections: Correction[] } {
  const line = trip.lines.find((l) => l.lineKey === lineKey);
  const picked = line === undefined ? null : pick(line, productId);
  if (line === undefined || picked === null) return { trip, corrections: [] };
  const corrections: Correction[] = line.term !== null && productId !== line.proposedProductId
    ? [{ term: line.term, proposedProductId: line.proposedProductId, chosenProductId: productId }] : [];
  return { trip: { ...trip, lines: trip.lines.map((l) => (l === line ? picked : l)) }, corrections };
}

/** The user will add the term by hand on Auchan: the line goes, the term joins the unmatched list. */
export function moveToUnmatched(trip: Trip, lineKey: string): { trip: Trip; corrections: Correction[] } {
  const line = trip.lines.find((l) => l.lineKey === lineKey);
  if (line === undefined || line.term === null) return { trip, corrections: [] };
  const r = answer(trip, lineKey, null);
  return { trip: applyOps(r.trip, [{ op: 'add', term: line.term, quantity: line.quantity, note: line.note }, { op: 'unmatched', term: line.term, hint: '' }]).trip, corrections: r.corrections };
}

export function dropUnmatched(trip: Trip, term: string): Trip {
  const n = normaliseTerm(term);
  return { ...trip, unmatched: trip.unmatched.filter((u) => normaliseTerm(u.term) !== n) };
}

export function setIncluded(trip: Trip, lineKey: string, included: boolean): Trip {
  return { ...trip, lines: trip.lines.map((l) => (l.lineKey === lineKey ? { ...l, included, held: false } : l)) };
}

export const openQuestions = (trip: Trip): TripLine[] => trip.lines.filter((l) => (l.included || l.held === true) && l.question !== null);

export const needsQuestion = (line: TripLine): boolean => line.confidence !== 'high';

/** A problem the user can fix in the list; its text is shown as it is. */
export class ListProblem extends Error {}

export function approvedLines(trip: Trip): { term: string | null; productId: string; quantity: number }[] {
  const seen = new Set<string>();
  const out: { term: string | null; productId: string; quantity: number }[] = [];
  for (const l of trip.lines) {
    if (!l.included) continue;
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 20) throw new Error(`Invalid quantity for ${l.productId}`);
    if (seen.has(l.productId)) throw new ListProblem(`Ten sam produkt jest na liście dwa razy: ${l.name}. Usuń jedną pozycję.`);
    seen.add(l.productId);
    out.push({ term: l.term, productId: l.productId, quantity: l.quantity });
  }
  return out;
}

export const totalGrosze = (trip: Trip): number => trip.lines.filter((l) => l.included).reduce((sum, l) => sum + l.lineCostGrosze, 0);

const MAX_REPORT = 30_000;
const MAX_STRUCTURED_REPORT = 200_000;

export function saveTrip(file: string, trip: Trip): void {
  // A long report is cut rather than making the saved trip unloadable.
  if (typeof trip.reportText === 'string' && trip.reportText.length > MAX_REPORT) trip = { ...trip, reportText: trip.reportText.slice(0, MAX_REPORT) };
  if (trip.reportData && (!validPaymentReport(trip.reportData) || JSON.stringify(trip.reportData).length > MAX_STRUCTURED_REPORT)) trip = { ...trip, reportData: null };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify(trip), { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

const MAX_COST = 10_000_000;
const MAX_BYTES = 1024 * 1024;
const STEPS = ['dane', 'szkic', 'doprecyzowanie', 'zatwierdzenie', 'koszyk', 'platnosc'];
const CONFS = ['high', 'medium', 'low'];
type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isArr = <T>(v: unknown, ok: (x: unknown) => x is T): v is T[] => Array.isArray(v) && v.every(ok);
const validCategoryPath = (v: unknown): v is string[] => isArr(v, isStr) && v.length <= 8 && v.every((part) => part.length <= 120);
const validMoney = (v: unknown): v is number => isInt(v) && v >= 0 && v <= 10_000_000_000;
const validPaymentRow = (v: unknown): v is PaymentRow => isRec(v) && isStr(v.name) && v.name.length <= 200
  && (v.productId === undefined || (isStr(v.productId) && v.productId.length <= 200))
  && (v.categoryPath === undefined || validCategoryPath(v.categoryPath))
  && (v.quantity === undefined || (typeof v.quantity === 'number' && Number.isFinite(v.quantity) && v.quantity >= 0 && v.quantity <= 1000))
  && (v.unitPriceGrosze === undefined || v.unitPriceGrosze === null || validMoney(v.unitPriceGrosze))
  && (v.priceSource === undefined || v.priceSource === 'planned' || v.priceSource === 'cart')
  && (v.approvedGrosze === undefined || validMoney(v.approvedGrosze)) && (v.nowGrosze === undefined || validMoney(v.nowGrosze))
  && (v.risePercent === undefined || (typeof v.risePercent === 'number' && Number.isFinite(v.risePercent) && v.risePercent >= 0 && v.risePercent <= 1_000_000))
  && (v.substitutes === undefined || (isArr(v.substitutes, isStr) && v.substitutes.length <= 2 && v.substitutes.every((s) => s.length <= 500)))
  && (v.limit === undefined || (isRec(v.limit) && isStr(v.limit.reason) && v.limit.reason.length <= 500 && isInt(v.limit.added) && isInt(v.limit.requested)))
  && (v.note === undefined || (isStr(v.note) && v.note.length <= 500));
const validPaymentReport = (v: unknown): v is PaymentReport => isRec(v) && isArr(v.sections, (section): section is PaymentReport['sections'][number] =>
  isRec(section) && ['warning', 'missing', 'action', 'info', 'increase'].includes(String(section.key))
  && isStr(section.title) && section.title.length <= 100 && isArr(section.items, validPaymentRow) && section.items.length <= 500)
  && v.sections.length <= 8 && isRec(v.summary) && isInt(v.summary.addedCount) && v.summary.addedCount >= 0 && v.summary.addedCount <= 500
  && (v.summary.cartTotalGrosze === null || validMoney(v.summary.cartTotalGrosze));

function validCandidate(v: unknown): v is TripCandidate {
  return isRec(v) && isStr(v.productId) && isStr(v.name) && isInt(v.lineCostGrosze) && v.lineCostGrosze >= 0 && v.lineCostGrosze <= MAX_COST && isStr(v.confidence) && CONFS.includes(v.confidence)
    && (v.baseCostGrosze === undefined || (isInt(v.baseCostGrosze) && v.baseCostGrosze >= 0 && v.baseCostGrosze <= MAX_COST))
    && (v.baseQuantity === undefined || (isInt(v.baseQuantity) && v.baseQuantity >= 1));
}

function validLine(v: unknown): v is TripLine {
  return isRec(v) && isStr(v.lineKey) && (v.term === null || isStr(v.term)) && isStr(v.note) && isStr(v.productId) && isStr(v.name)
    && isInt(v.quantity) && v.quantity >= 1 && v.quantity <= 20 && isInt(v.lineCostGrosze) && v.lineCostGrosze >= 0 && v.lineCostGrosze <= MAX_COST && isStr(v.reason) && isStr(v.confidence) && CONFS.includes(v.confidence)
    && isStr(v.confidenceReason) && isArr(v.candidates, validCandidate) && v.candidates.length <= 20 && isStr(v.proposedProductId)
    && v.candidates.some((c) => c.productId === v.productId) && v.candidates.some((c) => c.productId === v.proposedProductId)
    && (v.question === null || (isRec(v.question) && isStr(v.question.text) && isArr(v.question.options, isStr) && v.question.options.length <= 3
      && v.question.options.every((o) => (v.candidates as TripCandidate[]).some((c) => c.productId === o))))
    && typeof v.included === 'boolean' && (v.held === undefined || typeof v.held === 'boolean') && (v.kind === 'item' || v.kind === 'suggestion');
}

function validProposal(v: unknown): boolean {
  return v === null || (isRec(v) && isStr(v.id) && Array.isArray(v.ops) && v.ops.every(isRec) && isInt(v.dropped) && (v.source === 'claude' || v.source === 'fallback'));
}

function validTrip(v: unknown): v is Trip {
  return isRec(v) && isStr(v.note) && isStr(v.step) && STEPS.includes(v.step) && (v.mode === 'claude' || v.mode === 'fallback')
    && isArr(v.lines, validLine) && v.lines.length <= 200 && new Set(v.lines.map((l) => l.lineKey)).size === v.lines.length
    && isArr(v.unmatched, (u): u is UnmatchedTerm => isRec(u) && isStr(u.term) && isStr(u.hint)
      && (u.quantity === undefined || (isInt(u.quantity) && u.quantity >= 1 && u.quantity <= MAX_QUANTITY)) && (u.note === undefined || isStr(u.note)))
    && isArr(v.messages, isStr) && v.messages.length <= 200 && v.messages.every((m) => m.length <= 2000)
    && validProposal(v.proposal) && isStr(v.updatedAt) && (v.blocked === undefined || typeof v.blocked === 'boolean')
    && (v.reportText === undefined || v.reportText === null || (isStr(v.reportText) && v.reportText.length <= MAX_REPORT))
    && (v.reportData === undefined || v.reportData === null || isRec(v.reportData));
}

/** Auchan's product id as its pages use it: digits only. Anything else is dropped. */
const RETAILER_ID = /^\d{4,14}$/;
function cleanRetailerId<T extends { retailerProductId?: unknown }>(x: T): T {
  if (x.retailerProductId === undefined || (isStr(x.retailerProductId) && RETAILER_ID.test(x.retailerProductId))) return x;
  const { retailerProductId: _drop, ...rest } = x;
  return rest as T;
}

/** The date of a price as the store writes it: an ISO UTC time. Anything else is dropped. */
function cleanSeenAt<T extends { latestPriceSeenAt?: unknown }>(x: T): T {
  const v = x.latestPriceSeenAt;
  if (v === undefined || (isStr(v) && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(v) && !Number.isNaN(Date.parse(v)))) return x;
  const { latestPriceSeenAt: _drop, ...rest } = x;
  return rest as T;
}

/** An optional category that is not a short clean path is dropped; the line stays. */
function cleanCategory<T extends { categoryPath?: unknown }>(x: T): T {
  if (x.categoryPath === undefined || validCategoryPath(x.categoryPath)) return x;
  const { categoryPath: _drop, ...rest } = x;
  return rest as T;
}

/** An image that is not an Auchan image URL (or has an odd description) is dropped; the trip stays usable. */
function cleanImages<T extends { imageUrl?: string | null; imageAlt?: string | null }>(x: T): T {
  if (x.imageUrl === undefined && x.imageAlt === undefined) return x;
  const imageUrl = validImageUrl(x.imageUrl);
  return { ...x, imageUrl, imageAlt: imageUrl !== null && isStr(x.imageAlt) && x.imageAlt.length <= 300 ? x.imageAlt : null };
}

export function loadTrip(file: string): Trip | null {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!validTrip(parsed)) return null;
    const clean = <T extends TripLine | TripCandidate>(x: T): T => cleanCategory(cleanSeenAt(cleanRetailerId(cleanImages(x))));
    parsed.lines = parsed.lines.map((l) => ({ ...clean(l), candidates: l.candidates.map(clean) }));
    if (parsed.reportData != null && !validPaymentReport(parsed.reportData)) parsed.reportData = null;
    if (parsed.proposal !== null) {
      const { ops } = validateOps({ ops: parsed.proposal.ops }, lineViews(parsed));
      parsed.proposal = { ...parsed.proposal, ops };
    }
    return parsed;
  } catch {
    return null;
  }
}
