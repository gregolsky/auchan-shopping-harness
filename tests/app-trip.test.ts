import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, symlinkSync, readFileSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyTrip, tripFromDraft, applyOps, answer, setIncluded, openQuestions, needsQuestion,
  approvedLines, totalGrosze, saveTrip, loadTrip, lineViews, lineKeyFor, chooseProduct, dropUnmatched, moveToUnmatched,
} from '../src/app/trip.ts';
import type { Draft, DraftLine } from '../src/draft.ts';

const NOW = new Date('2026-11-15T10:00:00Z');

function dl(over: Partial<DraftLine>): DraftLine {
  return {
    term: null, productId: 'P', name: 'Produkt', quantity: 1, lineCostGrosze: 100, reason: 'r', guess: false,
    capped: false, lastBought: null, confidence: 'high', confidenceReason: '', alternatives: [], imageUrl: null, imageAlt: null, ...over,
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
test('a report longer than the limit is cut when saving, so the trip is never lost', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'trip-long-')), 'trip.json');
  saveTrip(file, { ...base(), step: 'platnosc', reportText: 'x'.repeat(50_000) });
  const loaded = loadTrip(file);
  assert.ok(loaded);
  assert.equal(loaded.reportText?.length, 30_000);
  assert.equal(loaded.step, 'platnosc');
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

/** The cheese line with a medium alternative, so Claude's ask may offer it. */
function baseMediumB() {
  const d = draft();
  d.items[0]!.alternatives = [{ productId: 'B', name: 'Ser B', lineCostGrosze: 800, confidence: 'medium' }];
  return tripFromDraft(emptyTrip(NOW), d, { 'Ser żółty': 'bez laktozy' });
}

test('applyOps ask sets the question and openQuestions lists it', () => {
  const r = applyOps(baseMediumB(), [{ op: 'ask', lineKey: CHEESE, question: 'Ktory?', options: ['A', 'B'] }]);
  assert.deepEqual(r.trip.lines[0]!.question, { text: 'Ktory?', options: ['A', 'B'] });
  assert.deepEqual(openQuestions(r.trip).map((l) => l.lineKey), [CHEESE]);
  assert.deepEqual(openQuestions(setIncluded(r.trip, CHEESE, false)), []);
});

test('answer with a product sets it and clears the question', () => {
  const asked = applyOps(baseMediumB(), [{ op: 'ask', lineKey: CHEESE, question: 'Ktory?', options: ['A', 'B'] }]).trip;
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
  assert.throws(() => approvedLines(dup), /Ten sam produkt jest na liście dwa razy: Mleko\. Usuń jedną pozycję\./);
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

test('a planner quantity above 20 is clamped to 20, with the cost scaled and the reason saying so', () => {
  const d = { ...draft(), items: [dl({ term: 'woda', productId: 'W', name: 'Woda', quantity: 30, lineCostGrosze: 3000, reason: 'kupowano często' })], stockUps: [], promotions: [], addOns: [] };
  const line = tripFromDraft(emptyTrip(NOW), d, {}).lines[0]!;
  assert.equal(line.quantity, 20);
  assert.equal(line.lineCostGrosze, 2000);
  assert.match(line.reason, /kupowano często.*ilość ograniczona do 20/);
  assert.doesNotThrow(() => approvedLines(tripFromDraft(emptyTrip(NOW), d, {})));
});

test('a low-confidence term line is held back with a question until the user answers', () => {
  const d = draft();
  d.items[0] = dl({
    term: 'pierś z kurczaka', productId: 'K', name: 'Kiełbasa z piersi kurczaka', confidence: 'low', confidenceReason: 'product made from the term, not the term itself',
    alternatives: [1, 2, 3, 4].map((n) => ({ productId: `X${n}`, name: `Filet ${n}`, lineCostGrosze: 100, confidence: 'medium' as const })),
  });
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  const line = t.lines[0]!;
  assert.equal(line.included, false);
  assert.deepEqual(line.question, { text: 'Nie mam pewnego dopasowania dla „pierś z kurczaka”. Wybierz produkt albo zdecyduj, co z tą pozycją zrobić.', options: ['X1', 'X2', 'X3'] });
  assert.equal(t.lines[1]!.included, true);
  assert.equal(t.lines[1]!.question, null);
});

test('options put the highest confidence first and never offer a low candidate, not even the held product', () => {
  const d = draft();
  d.items[0] = dl({
    term: 'kurczak', productId: 'K', name: 'Pasztet z kurczaka', confidence: 'low',
    alternatives: [{ productId: 'L', name: 'Low', lineCostGrosze: 100, confidence: 'low' }, { productId: 'H', name: 'High', lineCostGrosze: 100, confidence: 'high' }],
  });
  assert.deepEqual(tripFromDraft(emptyTrip(NOW), d, {}).lines[0]!.question!.options, ['H']);
});

test('answering a held-back line with a product includes it, and skipping removes it', () => {
  const d = draft();
  d.items[0] = dl({ term: 'kurczak', productId: 'K', name: 'Pasztet', confidence: 'low', alternatives: [{ productId: 'F', name: 'Filet', lineCostGrosze: 100, confidence: 'medium' }] });
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  const key = t.lines[0]!.lineKey;
  const picked = answer(t, key, 'F').trip.lines[0]!;
  assert.equal(picked.productId, 'F');
  assert.equal(picked.included, true);
  assert.equal(picked.question, null);
  assert.equal(answer(t, key, null).trip.lines.some((l) => l.lineKey === key), false);
});

test('a held-back line stays out of approval and does not count in the total', () => {
  const d = draft();
  d.items[0] = dl({ term: 'kurczak', productId: 'K', name: 'Pasztet', confidence: 'low' });
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  assert.equal(approvedLines(t).some((l) => l.productId === 'K'), false);
});

const IMG = 'https://zakupy.auchan.pl/images-v3/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/300x300.jpg';

test('images travel from the draft line and its alternatives to the trip line and candidates', () => {
  const d = draft();
  d.items[0] = { ...d.items[0], imageUrl: IMG, imageAlt: 'Ser A',
    alternatives: [{ productId: 'B', name: 'Ser B', lineCostGrosze: 800, confidence: 'low', imageUrl: IMG.replace('0001/300', '0002/300'), imageAlt: null }] };
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  const line = t.lines.find((l) => l.productId === 'A')!;
  assert.equal(line.imageUrl, IMG);
  assert.equal(line.imageAlt, 'Ser A');
  assert.equal(line.candidates[0].imageUrl, IMG);
  assert.match(line.candidates[1].imageUrl!, /0002\/300x300/);
  assert.equal(line.candidates[1].imageAlt, null);
  const file = join(mkdtempSync(join(tmpdir(), 'trip-')), 'trip.json');
  saveTrip(file, t);
  assert.deepEqual(loadTrip(file), t);
});

test('a choice moves the picked candidate image onto the line', () => {
  const d = draft();
  d.items[0] = { ...d.items[0], imageUrl: IMG, imageAlt: 'Ser A',
    alternatives: [{ productId: 'B', name: 'Ser B', lineCostGrosze: 800, confidence: 'low', imageUrl: IMG.replace('0001/300', '0002/300'), imageAlt: 'Ser B alt' }] };
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  const { trip } = applyOps(t, [{ op: 'choose', lineKey: CHEESE, productId: 'B' }]);
  assert.match(trip.lines.find((l) => l.lineKey === CHEESE)!.imageUrl!, /0002\/300x300/);
  assert.equal(trip.lines.find((l) => l.lineKey === CHEESE)!.imageAlt, 'Ser B alt');
});

test('loadTrip treats an invalid image as none instead of rejecting the trip', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'trip-')), 'trip.json');
  const t = JSON.parse(JSON.stringify(base()));
  t.lines[0].imageUrl = 'javascript:alert(1)';
  t.lines[0].imageAlt = 'x'.repeat(301);
  t.lines[0].candidates[0].imageUrl = 'https://evil.example/a.jpg';
  t.lines[1].imageUrl = IMG;
  t.lines[1].imageAlt = 42;
  writeFileSync(file, JSON.stringify(t));
  const loaded = loadTrip(file)!;
  assert.ok(loaded);
  assert.equal(loaded.lines[0].imageUrl, null);
  assert.equal(loaded.lines[0].imageAlt, null);
  assert.equal(loaded.lines[0].candidates[0].imageUrl, null);
  assert.equal(loaded.lines[1].imageUrl, IMG);
  assert.equal(loaded.lines[1].imageAlt, null);
});

test('a trip saved before images existed still loads', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'trip-')), 'trip.json');
  const t = JSON.parse(JSON.stringify(base()));
  for (const l of t.lines) { delete l.imageUrl; delete l.imageAlt; for (const c of l.candidates) { delete c.imageUrl; delete c.imageAlt; } }
  writeFileSync(file, JSON.stringify(t));
  assert.equal(loadTrip(file)!.lines[0].imageUrl ?? null, null);
});

test('chooseProduct picks any candidate, clears a question and a hold, and records a correction only when it differs', () => {
  const d = draft();
  d.items[0] = dl({ term: 'kurczak', productId: 'K', name: 'Pasztet', confidence: 'low', alternatives: [{ productId: 'F', name: 'Filet', lineCostGrosze: 100, confidence: 'medium' }] });
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  const key = t.lines[0]!.lineKey;
  const r = chooseProduct(t, key, 'F');
  assert.equal(r.trip.lines[0]!.productId, 'F');
  assert.equal(r.trip.lines[0]!.question, null);
  assert.equal(r.trip.lines[0]!.included, true);
  assert.equal(r.trip.lines[0]!.held, false);
  assert.deepEqual(r.corrections, [{ term: 'kurczak', proposedProductId: 'K', chosenProductId: 'F' }]);
  assert.deepEqual(chooseProduct(t, key, 'K').corrections, []);
  const plain = chooseProduct(base(), CHEESE, 'B');
  assert.equal(plain.trip.lines[0]!.productId, 'B');
  assert.equal(plain.trip.lines[0]!.lineCostGrosze, 800);
});

test('chooseProduct ignores an unknown line or a product that is not a candidate of the line', () => {
  const t = base();
  assert.equal(chooseProduct(t, CHEESE, 'ZZZ').trip, t);
  assert.equal(chooseProduct(t, 'nope', 'A').trip, t);
  assert.deepEqual(chooseProduct(t, CHEESE, 'ZZZ').corrections, []);
});

test('dropUnmatched removes one term by its normalised form', () => {
  const t = { ...base(), unmatched: [{ term: 'Kawior', hint: '' }, { term: 'trufle', hint: 'x' }] };
  assert.deepEqual(dropUnmatched(t, 'kawior').unmatched, [{ term: 'trufle', hint: 'x' }]);
  assert.equal(dropUnmatched(t, 'nic').unmatched.length, 2);
});

test('a held line with only low candidates asks with no options', () => {
  const d = draft();
  d.items[0] = dl({
    term: 'pierś z kurczaka', productId: 'K', name: 'Przysmak dla psa', confidence: 'low',
    alternatives: [{ productId: 'L', name: 'Low', lineCostGrosze: 100, confidence: 'low' }],
  });
  assert.deepEqual(tripFromDraft(emptyTrip(NOW), d, {}).lines[0]!.question!.options, []);
});

test('moveToUnmatched removes the line, records a removal and lists the term for adding by hand', () => {
  const d = draft();
  d.items[0] = dl({ term: 'pierś z kurczaka', productId: 'K', name: 'Przysmak', confidence: 'low' });
  const t = tripFromDraft(emptyTrip(NOW), d, {});
  const r = moveToUnmatched(t, t.lines[0]!.lineKey);
  assert.equal(r.trip.lines.some((l) => l.term === 'pierś z kurczaka'), false);
  assert.deepEqual(r.trip.unmatched.at(-1), { term: 'pierś z kurczaka', hint: '', quantity: 1, note: '' });
  assert.deepEqual(r.corrections, [{ term: 'pierś z kurczaka', proposedProductId: 'K', chosenProductId: null }]);
  assert.equal(moveToUnmatched(t, 'nope').trip, t);
});

test('unmatched terms keep the parsed quantity and note', () => {
  const d = { ...draft(), unmatched: ['kawior', 'ikra'] };
  const t = tripFromDraft(emptyTrip(NOW), d, {}, [{ term: 'kawior', quantity: 3, note: 'czarny' }, { term: 'ikra', quantity: 99, note: '' }]);
  assert.deepEqual(t.unmatched.find((u) => u.term === 'kawior'), { term: 'kawior', hint: '', quantity: 3, note: 'czarny' });
  assert.equal(t.unmatched.find((u) => u.term === 'ikra')!.quantity, 20, 'cut to the limit');
  const o = applyOps(emptyTrip(NOW), [{ op: 'add', term: 'Sól', quantity: 2, note: 'morska' }, { op: 'unmatched', term: 'sól', hint: 'x' }]).trip;
  assert.deepEqual(o.unmatched, [{ term: 'sól', hint: 'x', quantity: 2, note: 'morska' }]);
  const kept = applyOps(o, [{ op: 'unmatched', term: 'sól', hint: 'y' }]).trip;
  assert.deepEqual(kept.unmatched, [{ term: 'sól', hint: 'y', quantity: 2, note: 'morska' }], 'a new hint keeps the quantity');
});

test('moveToUnmatched keeps the line quantity and note', () => {
  let t = base();
  t = applyOps(t, [{ op: 'setQuantity', lineKey: CHEESE, quantity: 4 }]).trip;
  const r = moveToUnmatched(t, CHEESE).trip;
  assert.equal(r.unmatched.find((u) => u.term === 'Ser żółty')!.quantity, 4);
});

test('loadTrip validates the unmatched quantity and note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trip-'));
  const f = join(dir, 't.json');
  const withU = (u: object) => JSON.stringify({ ...base(), unmatched: [u] });
  writeFileSync(f, withU({ term: 'a', hint: '', quantity: 2, note: 'n' }));
  assert.deepEqual(loadTrip(f)!.unmatched, [{ term: 'a', hint: '', quantity: 2, note: 'n' }]);
  writeFileSync(f, withU({ term: 'a', hint: '' }));
  assert.ok(loadTrip(f), 'old trips without them still load');
  for (const bad of [{ quantity: 0 }, { quantity: 21 }, { quantity: 1.5 }, { quantity: '2' }, { note: 5 }]) {
    writeFileSync(f, withU({ term: 'a', hint: '', ...bad }));
    assert.equal(loadTrip(f), null, JSON.stringify(bad));
  }
});

test('Claude\'s ask never offers a low candidate; with none left it asks with no options', () => {
  const t = base();
  const mixed = applyOps(t, [{ op: 'ask', lineKey: CHEESE, question: 'Który?', options: ['B', 'A'] }]).trip.lines.find((l) => l.lineKey === CHEESE)!;
  assert.deepEqual(mixed.question, { text: 'Który?', options: ['A'] });
  const onlyLow = applyOps(t, [{ op: 'ask', lineKey: CHEESE, question: 'Który?', options: ['B'] }]).trip.lines.find((l) => l.lineKey === CHEESE)!;
  assert.deepEqual(onlyLow.question, { text: 'Który?', options: [] });
});
