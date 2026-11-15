import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, symlinkSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyTrip, tripFromDraft, applyOps, answer, setIncluded, openQuestions, needsQuestion,
  approvedLines, totalGrosze, saveTrip, loadTrip, lineViews, lineKeyFor,
} from '../src/app/trip.ts';
import type { Draft, DraftLine } from '../src/draft.ts';

const NOW = new Date('2026-11-15T10:00:00Z');

function dl(over: Partial<DraftLine>): DraftLine {
  return {
    term: null, productId: 'P', name: 'Produkt', quantity: 1, lineCostGrosze: 100, reason: 'r', guess: false,
    capped: false, lastBought: null, confidence: 'high', confidenceReason: '', alternatives: [], ...over,
  };
}

function draft(): Draft {
  return {
    items: [
      dl({ term: 'Ser żółty', productId: 'A', name: 'Ser A', quantity: 2, lineCostGrosze: 1000, confidence: 'medium', confidenceReason: 'dwa podobne',
        alternatives: [{ productId: 'B', name: 'Ser B', lineCostGrosze: 800, confidence: 'low' }] }),
      dl({ term: 'mleko', productId: 'M', name: 'Mleko', quantity: 1, lineCostGrosze: 300 }),
    ],
    stockUps: [dl({ productId: 'S', name: 'Makaron', lineCostGrosze: 500 })],
    promotions: [dl({ productId: 'R', name: 'Ryz', lineCostGrosze: 200 })],
    addOns: [dl({ productId: 'O', name: 'Olej', lineCostGrosze: 700 })],
    unmatched: ['kawior'],
    totalGrosze: 1300,
    overBudgetGrosze: null,
  };
}

const base = () => tripFromDraft(emptyTrip(NOW), draft(), { 'Ser żółty': 'bez laktozy' });

test('the payment report survives a trip save and reload', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'trip-report-')), 'trip.json');
  saveTrip(file, { ...base(), step: 'platnosc', reportText: 'Sprawdź przed zapłatą:\n  - Mąka 1 kg' });
  assert.match(loadTrip(file)?.reportText ?? '', /Sprawdź przed zapłatą/);
});
const CHEESE = 't:ser zolty';

test('tripFromDraft maps items and suggestions', () => {
  const t = base();
  assert.equal(t.lines.length, 5);
  const cheese = t.lines[0]!;
  assert.equal(cheese.lineKey, CHEESE);
  assert.equal(lineKeyFor('Ser żółty', 'A'), CHEESE);
  assert.equal(cheese.kind, 'item');
  assert.equal(cheese.included, true);
  assert.equal(cheese.note, 'bez laktozy');
  assert.equal(cheese.proposedProductId, 'A');
  assert.deepEqual(cheese.candidates.map((c) => c.productId), ['A', 'B']);
  assert.equal(cheese.question, null);
  assert.equal(needsQuestion(cheese), true);
  assert.equal(needsQuestion(t.lines[1]!), false);
  const sug = t.lines.slice(2);
  assert.deepEqual(sug.map((l) => l.lineKey), ['p:S', 'p:R', 'p:O']);
  assert.ok(sug.every((l) => l.kind === 'suggestion' && !l.included && l.term === null));
  assert.deepEqual(t.unmatched, [{ term: 'kawior', hint: '' }]);
  assert.deepEqual(lineViews(t)[0], { lineKey: CHEESE, candidateIds: ['A', 'B'] });
});

test('applyOps choose records a correction only when it differs from the planner\'s pick', () => {
  const t = base();
  const r = applyOps(t, [{ op: 'choose', lineKey: CHEESE, productId: 'B' }]);
  const l = r.trip.lines[0]!;
  assert.equal(l.productId, 'B');
  assert.equal(l.name, 'Ser B');
  assert.equal(l.lineCostGrosze, 800);
  assert.deepEqual(r.corrections, [{ term: 'Ser żółty', proposedProductId: 'A', chosenProductId: 'B' }]);
  assert.equal(t.lines[0]!.productId, 'A'); // input untouched
  const same = applyOps(t, [{ op: 'choose', lineKey: CHEESE, productId: 'A' }]);
  assert.deepEqual(same.corrections, []);
});

test('applyOps remove on a term line records a removal', () => {
  const r = applyOps(base(), [{ op: 'remove', lineKey: CHEESE }, { op: 'remove', lineKey: 'p:S' }]);
  assert.equal(r.trip.lines.length, 3);
  assert.deepEqual(r.corrections, [{ term: 'Ser żółty', proposedProductId: 'A', chosenProductId: null }]);
});

test('applyOps add returns the term for drafting; say, unmatched, setQuantity', () => {
  const r = applyOps(base(), [
    { op: 'add', term: 'chleb', quantity: 2, note: 'razowy' },
    { op: 'say', text: 'Gotowe' },
    { op: 'unmatched', term: 'trufle', hint: 'brak' },
    { op: 'setQuantity', lineKey: CHEESE, quantity: 4 },
  ]);
  assert.deepEqual(r.addTerms, [{ term: 'chleb', quantity: 2, note: 'razowy' }]);
  assert.deepEqual(r.trip.messages, ['Gotowe']);
  assert.deepEqual(r.trip.unmatched.at(-1), { term: 'trufle', hint: 'brak' });
  const l = r.trip.lines[0]!;
  assert.equal(l.quantity, 4);
  assert.equal(l.lineCostGrosze, 2000);
  assert.deepEqual(l.candidates.map((c) => c.lineCostGrosze), [2000, 1600]);
});

test('applyOps ask sets the question and openQuestions lists it', () => {
  const r = applyOps(base(), [{ op: 'ask', lineKey: CHEESE, question: 'Ktory?', options: ['A', 'B'] }]);
  assert.deepEqual(r.trip.lines[0]!.question, { text: 'Ktory?', options: ['A', 'B'] });
  assert.deepEqual(openQuestions(r.trip).map((l) => l.lineKey), [CHEESE]);
  assert.deepEqual(openQuestions(setIncluded(r.trip, CHEESE, false)), []);
});

test('answer with a product sets it and clears the question', () => {
  const asked = applyOps(base(), [{ op: 'ask', lineKey: CHEESE, question: 'Ktory?', options: ['A', 'B'] }]).trip;
  const r = answer(asked, CHEESE, 'B');
  assert.equal(r.trip.lines[0]!.productId, 'B');
  assert.equal(r.trip.lines[0]!.question, null);
  assert.deepEqual(r.corrections, [{ term: 'Ser żółty', proposedProductId: 'A', chosenProductId: 'B' }]);
  assert.deepEqual(openQuestions(r.trip), []);
  assert.equal(answer(asked, CHEESE, 'A').corrections.length, 0);
});

test('answer null removes the line and records a removal', () => {
  const r = answer(base(), CHEESE, null);
  assert.equal(r.trip.lines.some((l) => l.lineKey === CHEESE), false);
  assert.deepEqual(r.corrections, [{ term: 'Ser żółty', proposedProductId: 'A', chosenProductId: null }]);
});

test('setIncluded toggles a suggestion and totalGrosze follows', () => {
  const t = base();
  assert.equal(totalGrosze(t), 1300);
  const on = setIncluded(t, 'p:S', true);
  assert.equal(totalGrosze(on), 1800);
  assert.equal(totalGrosze(setIncluded(on, 'p:S', false)), 1300);
});

test('approvedLines returns included lines and throws on a duplicate product', () => {
  const t = setIncluded(base(), 'p:S', true);
  assert.deepEqual(approvedLines(t), [
    { term: 'Ser żółty', productId: 'A', quantity: 2 },
    { term: 'mleko', productId: 'M', quantity: 1 },
    { term: null, productId: 'S', quantity: 1 },
  ]);
  const dup = applyOps(t, [{ op: 'choose', lineKey: CHEESE, productId: 'B' }]).trip;
  dup.lines[1] = { ...dup.lines[1]!, productId: 'B' };
  assert.throws(() => approvedLines(dup), /B/);
  const bad = base();
  bad.lines[0] = { ...bad.lines[0]!, quantity: 21 };
  assert.throws(() => approvedLines(bad));
});

test('saveTrip writes mode 600 and loadTrip round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trip-'));
  const file = join(dir, 'trip.json');
  const t = base();
  saveTrip(file, t);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(loadTrip(file), t);
  assert.deepEqual(readdirSync(dir), ['trip.json']);
});

test('loadTrip returns null for garbage and for a missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trip-'));
  assert.equal(loadTrip(join(dir, 'none.json')), null);
  for (const body of ['not json', '[]', 'null', '{"note":1}', JSON.stringify({ ...base(), step: 'x' }),
    JSON.stringify({ ...base(), lines: [{ lineKey: 'a' }] }), JSON.stringify({ ...base(), lines: [{ ...base().lines[0], quantity: 'x' }] })]) {
    const f = join(dir, 'bad.json');
    writeFileSync(f, body);
    assert.equal(loadTrip(f), null, body);
  }
});

test('saveTrip replaces a symlink instead of following it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trip-'));
  const target = join(dir, 'victim.txt');
  writeFileSync(target, 'keep');
  const file = join(dir, 'trip.json');
  symlinkSync(target, file);
  saveTrip(file, base());
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  assert.equal(lstatSync(file).isSymbolicLink(), false);
  assert.notEqual(loadTrip(file), null);
});

test('corrections come from the final state, not each op', () => {
  const alt = (id: string) => ({ productId: id, name: id, lineCostGrosze: 100, confidence: 'low' as const });
  const d = draft();
  d.items[0]!.alternatives = [alt('B'), alt('C')];
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  const run = (ops: Parameters<typeof applyOps>[1]) => applyOps(t, ops).corrections;
  assert.deepEqual(run([{ op: 'choose', lineKey: CHEESE, productId: 'B' }, { op: 'choose', lineKey: CHEESE, productId: 'A' }]), []);
  assert.deepEqual(run([{ op: 'choose', lineKey: CHEESE, productId: 'B' }, { op: 'choose', lineKey: CHEESE, productId: 'C' }]),
    [{ term: 'Ser żółty', proposedProductId: 'A', chosenProductId: 'C' }]);
  assert.deepEqual(run([{ op: 'choose', lineKey: CHEESE, productId: 'B' }, { op: 'remove', lineKey: CHEESE }]),
    [{ term: 'Ser żółty', proposedProductId: 'A', chosenProductId: null }]);
});

test('answer with a non-candidate or a non-offered option leaves the trip unchanged', () => {
  const t = base();
  assert.equal(answer(t, CHEESE, 'ZZZ').trip, t);
  const asked = applyOps(t, [{ op: 'ask', lineKey: CHEESE, question: 'Ktory?', options: ['A'] }]).trip;
  const r = answer(asked, CHEESE, 'B');
  assert.equal(r.trip, asked);
  assert.deepEqual(r.corrections, []);
  assert.notEqual(r.trip.lines[0]!.question, null);
});

test('tripFromDraft keeps existing lines, dedupes fresh ones and clears matched unmatched terms', () => {
  let t = base();
  t = applyOps(t, [{ op: 'setQuantity', lineKey: CHEESE, quantity: 5 }, { op: 'unmatched', term: 'chleb', hint: 'x' }]).trip;
  t = setIncluded(t, 'p:S', true);
  const d2 = draft();
  d2.items = [dl({ term: 'chleb', productId: 'H', name: 'Chleb 1' }), dl({ term: 'Chleb', productId: 'H2', name: 'Chleb 2' }), d2.items[0]!];
  d2.unmatched = [];
  const r = tripFromDraft(t, d2, {});
  assert.equal(r.lines.find((l) => l.lineKey === CHEESE)!.quantity, 5);
  assert.equal(r.lines.find((l) => l.lineKey === 'p:S')!.included, true);
  assert.deepEqual(r.lines.filter((l) => l.lineKey === 't:chleb').map((l) => l.productId), ['H']);
  assert.deepEqual(r.unmatched.map((u) => u.term), ['kawior']);
  const again = tripFromDraft(r, { ...draft(), unmatched: ['chleb'] }, {});
  assert.deepEqual(again.unmatched.map((u) => u.term), ['kawior']);
});

test('quantity changes never drift and a chosen line is not asked again', () => {
  const t = base();
  const r = applyOps(t, [{ op: 'setQuantity', lineKey: CHEESE, quantity: 1 }, { op: 'setQuantity', lineKey: CHEESE, quantity: 3 }, { op: 'setQuantity', lineKey: CHEESE, quantity: 2 }]).trip;
  assert.equal(r.lines[0]!.lineCostGrosze, 1000);
  assert.deepEqual(r.lines[0]!.candidates.map((c) => c.lineCostGrosze), [1000, 800]);
  assert.equal(applyOps(t, [{ op: 'setQuantity', lineKey: CHEESE, quantity: 21 }]).trip.lines[0]!.quantity, 2);
  const c = applyOps(t, [{ op: 'choose', lineKey: CHEESE, productId: 'B' }]).trip.lines[0]!;
  assert.equal(needsQuestion(c), false);
  assert.equal(c.confidenceReason, '');
  const a = answer(t, CHEESE, 'A').trip.lines[0]!;
  assert.equal(needsQuestion(a), false);
});

test('loadTrip rejects out-of-range values and dangling references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trip-'));
  const f = join(dir, 't.json');
  const mut = (fn: (t: ReturnType<typeof base>) => void) => { const t = JSON.parse(JSON.stringify(base())); fn(t); writeFileSync(f, JSON.stringify(t)); return loadTrip(f); };
  assert.notEqual(mut(() => {}), null);
  assert.equal(mut((t) => { t.lines[0]!.quantity = 21; }), null);
  assert.equal(mut((t) => { t.lines[0]!.lineCostGrosze = -1; }), null);
  assert.equal(mut((t) => { t.lines[0]!.productId = 'NOPE'; }), null);
  assert.equal(mut((t) => { t.lines[0]!.proposedProductId = 'NOPE'; }), null);
  assert.equal(mut((t) => { t.lines[0]!.question = { text: 'q', options: ['NOPE'] }; }), null);
  assert.equal(mut((t) => { t.lines[1]!.lineKey = t.lines[0]!.lineKey; }), null);
  assert.equal(mut((t) => { t.messages = Array(201).fill('x'); }), null);
  assert.equal(mut((t) => { t.messages = ['x'.repeat(2001)]; }), null);
  writeFileSync(f, JSON.stringify({ ...base(), messages: ['x'.repeat(1_100_000)] }));
  assert.equal(loadTrip(f), null);
  const p = mut((t) => { t.proposal = { id: 'p', source: 'claude', dropped: 0, ops: [{ op: 'remove', lineKey: CHEESE }, { op: 'remove', lineKey: 'nope' }] }; });
  assert.deepEqual(p!.proposal!.ops, [{ op: 'remove', lineKey: CHEESE }]);
});
