import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, progressLine, zl, viewModel, describeOp, parseBudget, describeQuestions, unmatchedText, nextSelected, claudeStatus, approveHint, badgeText, confidenceReasonText, lineLabel, workingPanel, doneSummary, failureText, START_TEXT, lineCard, proposalView, unmatchedCard, acceptAllText } from '../public/app.js';

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
  assert.match(describeOp({ op: 'remove', lineKey: 't:maka' }, byKey), /usuń/);
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

test('every line says which item of the list it answers', () => {
  const cheese = { ...line, term: 'ser żółty', note: 'duża paczka, gouda albo edam' };
  assert.equal(lineLabel(cheese), 'z Twojej listy: ser żółty — duża paczka, gouda albo edam');
  assert.equal(lineLabel({ ...line, note: '' }), 'z Twojej listy: mąka');
  const sug = (reason: string) => lineLabel({ ...line, term: null, note: '', reason, kind: 'suggestion' });
  assert.equal(sug('on offer: 2 za 1'), 'propozycja: promocja');
  assert.equal(sug('25% below its usual unit price'), 'propozycja: promocja');
  assert.equal(sug('bought in 8 of the latest 10 orders'), 'propozycja: kupujesz często');
  assert.equal(sug('bought 5 times'), 'propozycja: kupujesz często');
  assert.equal(sug('x'), 'propozycja');
  assert.equal(viewModel(tripAt('doprecyzowanie', { lines: [line] })).questions[0].label, 'z Twojej listy: mąka');
});

test('proposal texts name the list item they change', () => {
  const cheese = { ...line, lineKey: 't:ser', term: 'ser żółty', name: 'Ser żółty Królewski', candidates: [{ productId: 'g', name: 'Ser Gouda Auchan 500 g' }] };
  const meat = { ...line, lineKey: 't:kurczak', term: 'pierś z kurczaka', name: 'Kiełbasa' };
  const byKey = new Map([['t:ser', cheese], ['t:kurczak', meat]]);
  assert.equal(describeOp({ op: 'choose', lineKey: 't:ser', productId: 'g' }, byKey), 'ser żółty: zamień „Ser żółty Królewski” na „Ser Gouda Auchan 500 g”');
  assert.equal(describeOp({ op: 'remove', lineKey: 't:kurczak' }, byKey), 'pierś z kurczaka: usuń „Kiełbasa”');
  assert.equal(describeOp({ op: 'setQuantity', lineKey: 't:ser', quantity: 3 }, byKey), 'ser żółty: ustaw „Ser żółty Królewski” na 3 szt.');
});

test('the working panel shows the stage, elapsed seconds and the usual duration; slow after 90 s', () => {
  const p = workingPanel('Czytam listę (1/3)…', 12);
  assert.deepEqual(p, { text: 'Czytam listę (1/3)…', elapsed: '12 s', hint: 'Zwykle trwa to 10–30 s.', slow: null });
  assert.equal(workingPanel('x', 89).slow, null);
  assert.equal(workingPanel('x', 90).slow, 'Wciąż pracuję — Claude odpowiada wolniej niż zwykle.');
  assert.equal(START_TEXT.note, 'Czytam listę (1/3)…');
  assert.equal(START_TEXT.ask, 'Claude przygotowuje propozycję…');
});

test('after a note the alert summarises products, questions and the Claude proposal, omitting zero parts', () => {
  const q = { ...line, lineKey: 'a' }, plain = { ...line, lineKey: 'b', question: null }, sug = { ...line, lineKey: 'c', kind: 'suggestion', question: null };
  const proposal = { id: 'p', ops: [{}, {}, {}], dropped: 0 };
  assert.equal(doneSummary(viewModel(tripAt('doprecyzowanie', { lines: [q, plain, plain, sug], proposal }))), 'Gotowe: 3 produkty, 1 pytanie, propozycja Claude: 3 zmiany.');
  assert.equal(doneSummary(viewModel(tripAt('doprecyzowanie', { lines: [plain] }))), 'Gotowe: 1 produkt.');
  assert.equal(doneSummary(viewModel(tripAt('szkic', { lines: [] }))), 'Gotowe.');
});

test('a failed note or command says what to do', () => {
  assert.equal(failureText('note', 'Błąd sieci.'), 'Nie udało się ułożyć szkicu: Błąd sieci. Spróbuj jeszcze raz.');
  assert.equal(failureText('note', 'Błąd sieci'), 'Nie udało się ułożyć szkicu: Błąd sieci. Spróbuj jeszcze raz.');
  assert.equal(failureText('ask', 'Błąd.'), 'Nie udało się przygotować propozycji: Błąd. Spróbuj jeszcze raz.');
});

test('summary uses Polish plurals', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...line, lineKey: `k${i}`, question: null }));
  const text = (n: number) => doneSummary(viewModel(tripAt('szkic', { lines: many(n) })));
  assert.equal(text(5), 'Gotowe: 5 produktów.');
  assert.equal(text(22), 'Gotowe: 22 produkty.');
  assert.equal(text(12), 'Gotowe: 12 produktów.');
});

test('the page has a polite status panel with a CSS-only spinner that stops for reduced motion', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const css = readFileSync('public/app.css', 'utf8');
  assert.match(html, /id="working"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(css, /\.spinner\{[^}]*animation:spin/);
  assert.match(css, /prefers-reduced-motion:reduce\)\{\.spinner\{animation:none/);
});

test('a held line is a pending question, blocks approving and reads "czeka na Twój wybór"', () => {
  const held = { ...line, included: false, held: true, confidence: 'low' };
  const state = tripAt('zatwierdzenie', { lines: [line, held].map((l, i) => ({ ...l, lineKey: `k${i}`, ...(i === 0 ? { question: null } : {}) })) });
  const model = viewModel(state);
  assert.equal(model.questions.length, 1);
  assert.equal(model.canApprove, false);
  assert.equal(badgeText(held), 'Czeka na Twój wybór');
  assert.equal(badgeText({ ...line, confidence: 'low' }), 'Niepewne');
});

test('the made-from reason is translated', () => {
  assert.equal(confidenceReasonText('product made from the term, not the term itself'), 'to produkt z tego składnika, nie sam składnik');
  assert.equal(confidenceReasonText('mystery'), 'mystery');
});

const IMG = 'https://zakupy.auchan.pl/images-v3/00000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000001/300x300.jpg';
const cand = (id: string, name: string, cost: number, extra: object = {}) => ({ productId: id, name, lineCostGrosze: cost, confidence: 'high', ...extra });
const cardLine = {
  lineKey: 't:mleko', term: 'mleko', note: 'tłuste', name: 'Mleko 2%', productId: 'a', quantity: 2, lineCostGrosze: 400, reason: '', confidence: 'high', confidenceReason: '',
  included: true, kind: 'item', question: null, imageUrl: IMG, imageAlt: 'Mleko w kartonie',
  candidates: [cand('a', 'Mleko 2%', 400), cand('b', 'Mleko 3%', 440, { imageUrl: IMG, imageAlt: 'Trzy' }), cand('c', 'Mleko UHT', 380), cand('d', 'Mleko bez laktozy', 600), cand('e', 'Mleko kozie', 900)],
};

test('lineCard shows label, thumbnail, price, quantity limits, and up to three other candidates', () => {
  const c = lineCard(cardLine, []);
  assert.equal(c.label, 'z Twojej listy: mleko — tłuste');
  assert.equal(c.name, 'Mleko 2%');
  assert.equal(c.priceText, '4,00 zł');
  assert.deepEqual([c.imageUrl, c.imageAlt], [IMG, 'Mleko w kartonie']);
  assert.deepEqual([c.quantity, c.canDec, c.canInc], [2, true, true]);
  assert.equal(c.badge.reason, null);
  assert.equal(c.proposals.length, 0);
  assert.equal(c.question, null);
  assert.deepEqual(c.alternatives.map((a: any) => [a.productId, a.priceText]), [['b', '4,40 zł'], ['c', '3,80 zł'], ['d', '6,00 zł']]);
  assert.deepEqual([c.alternatives[0].imageUrl, c.alternatives[1].imageUrl, c.alternatives[1].imageAlt], [IMG, null, 'Mleko UHT']);
});

test('lineCard falls back to the name as the picture description and has no image when there is none', () => {
  const c = lineCard({ ...cardLine, imageUrl: null, imageAlt: null, quantity: 20 }, []);
  assert.equal(c.imageUrl, null);
  assert.equal(c.imageAlt, 'Mleko 2%');
  assert.deepEqual([c.canInc, lineCard({ ...cardLine, quantity: 1 }, []).canDec], [false, false]);
  assert.equal(lineCard({ ...cardLine, imageUrl: undefined, imageAlt: undefined }, []).imageUrl, null);
});

test('lineCard explains a doubtful match in Polish', () => {
  const c = lineCard({ ...cardLine, confidence: 'low', confidenceReason: 'pet product' }, []);
  assert.deepEqual([c.badge.text, c.badge.level, c.badge.reason], ['Niepewne', 'low', 'produkt dla zwierząt']);
  assert.equal(lineCard({ ...cardLine, confidence: 'medium', confidenceReason: '' }, []).badge.reason, 'dopasowanie niepewne');
});

test('lineCard turns Claude operations on the line into a proposal row with the product, removal or quantity', () => {
  const c = lineCard(cardLine, [{ index: 0, op: { op: 'choose', lineKey: 't:mleko', productId: 'b' } }, { index: 3, op: { op: 'remove', lineKey: 't:mleko' } }, { index: 4, op: { op: 'setQuantity', lineKey: 't:mleko', quantity: 5 } }]);
  assert.deepEqual(c.proposals.map((p: any) => [p.index, p.kind, p.text]), [[0, 'choose', 'Mleko 3%'], [3, 'remove', 'usuń'], [4, 'setQuantity', 'ilość 5']]);
  assert.deepEqual([c.proposals[0].product.priceText, c.proposals[0].product.imageUrl], ['4,40 zł', IMG]);
  assert.equal(c.proposals[1].product, null);
});

test('lineCard shows the question with its options instead of other candidates, and a held line says it waits', () => {
  const c = lineCard({ ...cardLine, held: true, included: false, confidence: 'low', question: { text: 'Które?', options: ['c', 'zzz', 'b'] } }, []);
  assert.equal(c.question.text, 'Które?');
  assert.deepEqual(c.question.options.map((o: any) => o.productId), ['c', 'b']);
  assert.deepEqual(c.alternatives, []);
  assert.equal(c.held, true);
  assert.equal(c.badge.text, 'Czeka na Twój wybór');
});

test('lineCard of a suggestion uses the suggestion label and is not a stepper line', () => {
  const c = lineCard({ ...cardLine, term: null, kind: 'suggestion', included: false, reason: 'on offer: 2 for 1' }, []);
  assert.equal(c.label, 'propozycja: promocja');
  assert.equal(c.suggestion, true);
  assert.equal(c.included, false);
});

test('proposalView splits operations by line and lists the ones not tied to a line, keeping their index', () => {
  const ops = [{ op: 'choose', lineKey: 't:mleko', productId: 'b' }, { op: 'add', term: 'chleb', quantity: 2 }, { op: 'unmatched', term: 'kawior', hint: 'x' }, { op: 'remove', lineKey: 't:mleko' }];
  const v = proposalView({ proposal: { id: 'p', ops }, lines: [cardLine] });
  assert.equal(v.count, 4);
  assert.deepEqual(v.byLine['t:mleko'].map((x) => x.index), [0, 3]);
  assert.deepEqual(v.loose.map((x) => [x.index, x.text]), [[1, 'Dodaj „chleb” × 2'], [2, 'Dodaj ręcznie „kawior”']]);
  assert.deepEqual(proposalView({ proposal: null, lines: [] }), { count: 0, byLine: {}, loose: [] });
  assert.equal(acceptAllText(4), 'Przyjmij wszystkie propozycje (4)');
});

test('unmatchedCard says what was not found and keeps Claude\'s hint', () => {
  assert.deepEqual(unmatchedCard({ term: 'kawior', hint: 'Nie ma w katalogu' }), { title: 'Nie znalazłem: kawior', hint: 'Nie ma w katalogu' });
  assert.equal(unmatchedCard({ term: 'kawior', hint: '' }).hint, null);
});

test('app.js builds the page with textContent only; every image has a description and no referrer', () => {
  const js = readFileSync('public/app.js', 'utf8');
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.equal(js.match(/createElement\('img'\)/g)?.length, 1);
  const i = js.indexOf("createElement('img')");
  const body = js.slice(i, i + 400);
  assert.match(body, /\.alt = /);
  assert.match(body, /referrerPolicy = 'no-referrer'/);
  assert.match(body, /loading = 'lazy'/);
  assert.doesNotMatch(js, /\.style\b|setAttribute\('style'/);
});

test('lineCard never lists a low candidate as an alternative', () => {
  const c = (id: string, confidence: string) => ({ productId: id, name: id, lineCostGrosze: 100, confidence });
  const card = lineCard({ lineKey: 't:x', term: 'x', name: 'a', productId: 'a', quantity: 1, lineCostGrosze: 100, confidence: 'high', confidenceReason: '', kind: 'item', included: true, question: null,
    candidates: [c('a', 'high'), c('b', 'low'), c('c', 'medium')] } as any);
  assert.deepEqual(card.alternatives.map((a: any) => a.productId), ['c']);
});
