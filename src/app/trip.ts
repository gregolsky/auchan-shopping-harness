import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Confidence } from '../candidates.ts';
import type { Draft, DraftLine } from '../draft.ts';
import { normaliseTerm } from '../store.ts';
import { validateOps } from './ops.ts';
import type { LineView, Op } from './ops.ts';

export type Step = 'dane' | 'szkic' | 'doprecyzowanie' | 'zatwierdzenie' | 'koszyk' | 'platnosc';
/** baseCostGrosze is the cost at baseQuantity; lineCostGrosze is derived from it so quantity changes never drift. */
export interface TripCandidate { productId: string; name: string; lineCostGrosze: number; confidence: Confidence; baseCostGrosze?: number; baseQuantity?: number }
export interface TripLine {
  lineKey: string; term: string | null; note: string; productId: string; name: string; quantity: number;
  lineCostGrosze: number; reason: string; confidence: Confidence; confidenceReason: string;
  candidates: TripCandidate[]; proposedProductId: string; question: { text: string; options: string[] } | null;
  included: boolean; kind: 'item' | 'suggestion';
}
export interface Proposal { id: string; ops: Op[]; dropped: number; source: 'claude' | 'fallback' }
export interface Trip {
  note: string; step: Step; mode: 'claude' | 'fallback'; lines: TripLine[]; unmatched: { term: string; hint: string }[];
  messages: string[]; proposal: Proposal | null; updatedAt: string; reportText?: string | null;
}
export interface Correction { term: string; proposedProductId: string | null; chosenProductId: string | null; reason?: string }

export function emptyTrip(now: Date): Trip {
  return { note: '', step: 'dane', mode: 'claude', lines: [], unmatched: [], messages: [], proposal: null, updatedAt: now.toISOString(), reportText: null };
}

export function lineKeyFor(term: string | null, productId: string): string {
  return term === null ? `p:${productId}` : `t:${normaliseTerm(term)}`;
}

function tripLine(d: DraftLine, kind: TripLine['kind'], notes: Record<string, string>): TripLine {
  const cand = (c: { productId: string; name: string; lineCostGrosze: number; confidence: Confidence }): TripCandidate =>
    ({ ...c, baseCostGrosze: c.lineCostGrosze, baseQuantity: d.quantity });
  const own = cand(d);
  const others = d.alternatives.filter((a) => a.productId !== d.productId).map(cand);
  return {
    lineKey: lineKeyFor(d.term, d.productId), term: d.term,
    note: d.term === null ? '' : (notes[d.term] ?? notes[normaliseTerm(d.term)] ?? ''),
    productId: d.productId, name: d.name, quantity: d.quantity, lineCostGrosze: d.lineCostGrosze, reason: d.reason,
    confidence: d.confidence, confidenceReason: d.confidenceReason, candidates: [own, ...others],
    proposedProductId: d.productId, question: null, included: kind === 'item', kind,
  };
}

/** Adds lines for new keys only; an existing line (the user's choice, quantity, included flag) is kept untouched. */
export function tripFromDraft(trip: Trip, draft: Draft, notes: Record<string, string>): Trip {
  const have = new Set(trip.lines.map((l) => l.lineKey));
  const added: TripLine[] = [];
  const all: [DraftLine, TripLine['kind']][] = [
    ...draft.items.map((d): [DraftLine, TripLine['kind']] => [d, 'item']),
    ...[...draft.stockUps, ...draft.promotions, ...draft.addOns].map((d): [DraftLine, TripLine['kind']] => [d, 'suggestion']),
  ];
  for (const [d, kind] of all) {
    const l = tripLine(d, kind, notes);
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
    if (!matched.has(n) && !seen.has(n)) { seen.add(n); unmatched.push({ term, hint: '' }); }
  }
  return { ...trip, lines, unmatched };
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
  return { ...l, productId, name: c.name, lineCostGrosze: c.lineCostGrosze, confidence: 'high', confidenceReason: '', question: null };
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
  const update = (key: string, f: (l: TripLine) => TripLine) => { lines = lines.map((l) => (l.lineKey === key ? f(l) : l)); };
  for (const op of ops) {
    const line = 'lineKey' in op ? lines.find((l) => l.lineKey === op.lineKey) : undefined;
    switch (op.op) {
      case 'add': addTerms.push({ term: op.term, quantity: op.quantity, note: op.note ?? '' }); break;
      case 'say': messages.push(op.text); break;
      case 'unmatched': {
        const i = unmatched.findIndex((u) => normaliseTerm(u.term) === normaliseTerm(op.term));
        if (i >= 0) unmatched[i] = { term: op.term, hint: op.hint }; else unmatched.push({ term: op.term, hint: op.hint });
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
        const options = op.options.filter((id) => line.candidates.some((c) => c.productId === id)).slice(0, 3);
        if (options.length > 0) update(line.lineKey, (l) => ({ ...l, question: { text: op.question, options } }));
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

export function setIncluded(trip: Trip, lineKey: string, included: boolean): Trip {
  return { ...trip, lines: trip.lines.map((l) => (l.lineKey === lineKey ? { ...l, included } : l)) };
}

export const openQuestions = (trip: Trip): TripLine[] => trip.lines.filter((l) => l.included && l.question !== null);

export const needsQuestion = (line: TripLine): boolean => line.confidence !== 'high';

export function approvedLines(trip: Trip): { term: string | null; productId: string; quantity: number }[] {
  const seen = new Set<string>();
  const out: { term: string | null; productId: string; quantity: number }[] = [];
  for (const l of trip.lines) {
    if (!l.included) continue;
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 20) throw new Error(`Invalid quantity for ${l.productId}`);
    if (seen.has(l.productId)) throw new Error(`Product ${l.productId} appears twice`);
    seen.add(l.productId);
    out.push({ term: l.term, productId: l.productId, quantity: l.quantity });
  }
  return out;
}

export const totalGrosze = (trip: Trip): number => trip.lines.filter((l) => l.included).reduce((sum, l) => sum + l.lineCostGrosze, 0);

const MAX_REPORT = 30_000;

export function saveTrip(file: string, trip: Trip): void {
  // A long report is cut rather than making the saved trip unloadable.
  if (typeof trip.reportText === 'string' && trip.reportText.length > MAX_REPORT) trip = { ...trip, reportText: trip.reportText.slice(0, MAX_REPORT) };
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
    && typeof v.included === 'boolean' && (v.kind === 'item' || v.kind === 'suggestion');
}

function validProposal(v: unknown): boolean {
  return v === null || (isRec(v) && isStr(v.id) && Array.isArray(v.ops) && v.ops.every(isRec) && isInt(v.dropped) && (v.source === 'claude' || v.source === 'fallback'));
}

function validTrip(v: unknown): v is Trip {
  return isRec(v) && isStr(v.note) && isStr(v.step) && STEPS.includes(v.step) && (v.mode === 'claude' || v.mode === 'fallback')
    && isArr(v.lines, validLine) && v.lines.length <= 200 && new Set(v.lines.map((l) => l.lineKey)).size === v.lines.length
    && isArr(v.unmatched, (u): u is { term: string; hint: string } => isRec(u) && isStr(u.term) && isStr(u.hint))
    && isArr(v.messages, isStr) && v.messages.length <= 200 && v.messages.every((m) => m.length <= 2000)
    && validProposal(v.proposal) && isStr(v.updatedAt)
    && (v.reportText === undefined || v.reportText === null || (isStr(v.reportText) && v.reportText.length <= MAX_REPORT));
}

export function loadTrip(file: string): Trip | null {
  try {
    if (statSync(file).size > MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!validTrip(parsed)) return null;
    if (parsed.proposal !== null) {
      const { ops } = validateOps({ ops: parsed.proposal.ops }, lineViews(parsed));
      parsed.proposal = { ...parsed.proposal, ops };
    }
    return parsed;
  } catch {
    return null;
  }
}
