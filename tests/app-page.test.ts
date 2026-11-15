import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, progressLine, zl, viewModel, describeOp, parseBudget, describeQuestions, unmatchedText, nextSelected, claudeStatus, approveHint } from '../public/app.js';

const line = { lineKey: 't:maka', term: 'mąka', name: 'Mąka pszenna', productId: 'a', quantity: 2, lineCostGrosze: 1259,
  reason: 'bought before', confidence: 'medium', confidenceReason: 'not bought before', included: true, kind: 'item',
  question: { text: 'Która?', options: ['a'] }, candidates: [{ productId: 'a', name: 'Mąka pszenna' }] };

test('the six steps and money formatter are stable', () => {
  assert.equal(STEPS.length, 6);
  assert.equal(progressLine(2), '[1 Dane ✓] → [2 Szkic ✓] → [3 Doprecyzowanie •] → [4 Zatwierdzenie] → [5 Koszyk] → [6 Płatność]');
  assert.equal(zl(1259), '12,59 zł');
});

test('review stays disabled until questions are answered and totals use included lines', () => {
  const model = viewModel({ trip: { step: 'doprecyzowanie', lines: [line, { ...line, lineKey: 'x', kind: 'suggestion', lineCostGrosze: 1000, included: false }], proposal: null, unmatched: [], messages: [] }, freshness: { ageHours: 2 } });
  assert.equal(model.canApprove, false);
  assert.equal(model.total, 1259);
  assert.equal(model.lines.length, 1);
  assert.equal(model.suggestions.length, 1);
});

test('proposal operations have readable descriptions', () => {
  const byKey = new Map([['t:maka', line]]);
  assert.match(describeOp({ op: 'choose', lineKey: 't:maka', productId: 'a' }, byKey), /Mąka pszenna/);
  assert.match(describeOp({ op: 'setQuantity', lineKey: 't:maka', quantity: 3 }, byKey), /3/);
  assert.match(describeOp({ op: 'remove', lineKey: 't:maka' }, byKey), /Usuń/);
});

test('page loads same-origin assets and never injects untrusted HTML', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const js = readFileSync('public/app.js', 'utf8');
  assert.match(html, /src="\/app.js/);
  assert.match(html, /href="\/app.css/);
  assert.match(html, /href="\/icon.svg\?t=__APP_TOKEN__/);
  assert.match(html, /src="\/shopping.svg\?t=__APP_TOKEN__/);
  assert.match(html, /__APP_TOKEN__/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)|<style|\son\w+=/i);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

const tripAt = (step: string, extra: object = {}) => ({ trip: { step, lines: [{ ...line, question: null }], proposal: null, unmatched: [], messages: [], ...extra }, freshness: { ageHours: 2 } });

test('approving is only possible up to the review step', () => {
  assert.equal(viewModel(tripAt('zatwierdzenie')).canApprove, true);
  for (const step of ['koszyk', 'platnosc']) {
    const model = viewModel(tripAt(step));
    assert.equal(model.canApprove, false);
    assert.equal(model.inCart, true);
  }
});

test('a budget that is not a number is refused with a Polish message', () => {
  assert.deepEqual(parseBudget('149,99'), { ok: true, grosze: 14999 });
  assert.deepEqual(parseBudget(' 150 '), { ok: true, grosze: 15000 });
  assert.deepEqual(parseBudget(''), { ok: true, grosze: undefined });
  for (const bad of ['abc', '12zł', '-5', '1,234', '1e3', 'NaN']) {
    assert.deepEqual(parseBudget(bad), { ok: false, error: 'Podaj budżet jako liczbę, np. 150 lub 149,99' }, bad);
  }
});

test('step 3 puts a pending proposal first and blocks moving on until it is decided', () => {
  const proposal = { id: 'p', ops: [], dropped: 0 };
  const pending = describeQuestions(viewModel(tripAt('doprecyzowanie', { proposal })));
  assert.equal(pending.intro, 'Najpierw zastosuj albo odrzuć propozycję Claude.');
  assert.equal(pending.empty, null);
  assert.equal(pending.canContinue, false);
  const none = describeQuestions(viewModel(tripAt('doprecyzowanie')));
  assert.equal(none.empty, 'Nie ma pytań do rozstrzygnięcia.');
  assert.equal(none.canContinue, true);
  const asked = describeQuestions(viewModel({ trip: { step: 'doprecyzowanie', lines: [line], proposal: null, unmatched: [], messages: [] } }));
  assert.equal(asked.empty, null);
  assert.equal(asked.canContinue, false);
});

test('an unmatched term keeps Claude\'s hint', () => {
  assert.equal(unmatchedText({ term: 'ser', hint: 'Dodaj ręcznie, brak w katalogu' }), 'ser · Dodaj ręcznie, brak w katalogu');
  assert.equal(unmatchedText({ term: 'ser', hint: '' }), 'ser');
});

test('a tab beyond the trip follows the trip back after a failed fill', () => {
  assert.equal(nextSelected(4, 3), 3, 'cart tab after the fill failed');
  assert.equal(nextSelected(5, 3), 3);
  assert.equal(nextSelected(3, 4), 4, 'the fill started');
  assert.equal(nextSelected(1, 3), 1, 'the user browsing earlier tabs is left alone');
  assert.equal(nextSelected(0, 3, true), 3, 'first load');
});

test('while Claude works both buttons are off and the page says what happens', () => {
  assert.deepEqual(claudeStatus(null), { working: false, text: null, disableNote: false, disableAsk: false });
  assert.deepEqual(claudeStatus('note'), { working: true, text: 'Claude analizuje listę… (do minuty)', disableNote: true, disableAsk: true });
  assert.deepEqual(claudeStatus('ask'), { working: true, text: 'Claude przygotowuje propozycję…', disableNote: true, disableAsk: true });
});

test('after a blocked fill the page refuses approving and says why', () => {
  const model = viewModel(tripAt('zatwierdzenie', { blocked: true }));
  assert.equal(model.canApprove, false);
  assert.equal(model.approveHint, 'Auchan odrzucił zapytanie. Nie zatwierdzaj ponownie — sprawdź koszyk na Auchan i zacznij nowe zakupy.');
});

test('the approve hint names the real reason', () => {
  const hint = (state: any) => viewModel(state).approveHint;
  assert.equal(hint(tripAt('zatwierdzenie')), null);
  assert.match(hint({ ...tripAt('zatwierdzenie'), busy: 'sync' }), /synchronizacja/);
  assert.match(hint(tripAt('zatwierdzenie', { proposal: { id: 'p', ops: [], dropped: 0 } })), /zastosuj albo odrzuć propozycję/);
  assert.match(hint({ trip: { step: 'zatwierdzenie', lines: [line], proposal: null, unmatched: [], messages: [] } }), /odpowiedz na pytania/);
  assert.match(hint(tripAt('zatwierdzenie', { lines: [] })), /Nic nie jest zaznaczone/);
  assert.match(hint(tripAt('koszyk')), /już w koszyku/);
  assert.equal(approveHint({ inCart: false, blocked: false, proposalPending: false, questions: [], hasIncluded: true }, null), null);
});

test('the ask box keeps its text and Claude calls are guarded in the page code', () => {
  const js = readFileSync('public/app.js', 'utf8');
  assert.match(js, /input\.value = draftForm\.ask/);
  assert.match(js, /if \(pending !== null\) return/);
});
