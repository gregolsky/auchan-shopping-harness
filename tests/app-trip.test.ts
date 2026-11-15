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
