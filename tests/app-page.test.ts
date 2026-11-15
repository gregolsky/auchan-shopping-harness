import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, progressLine, zl, viewModel, describeOp, parseBudget, describeQuestions, unmatchedText, nextSelected, claudeStatus, approveHint, badgeText, confidenceReasonText, lineLabel, workingPanel, doneSummary, failureText, START_TEXT, lineCard, proposalView, unmatchedCard, acceptAllText, proposalNote, proposalButtons, acceptAllSummary, auchanSearchUrl, searchPanel, searchButton, searchBlockText, MANUAL_HINT, THEMES, normalizeTheme, readTheme, saveTheme, applyTheme, afterNote, reviewNext, listNotice } from '../public/app.js';

const line = { lineKey: 't:maka', term: 'mąka', name: 'Mąka pszenna', productId: 'a', quantity: 2, lineCostGrosze: 1259,
  reason: 'bought before', confidence: 'medium', confidenceReason: 'not bought before', included: true, kind: 'item',
  question: { text: 'Która?', options: ['a'] }, candidates: [{ productId: 'a', name: 'Mąka pszenna' }] };

test('the seven steps and money formatter are stable', () => {
  assert.equal(STEPS.length, 7);
  assert.equal(progressLine(3), '[1 Dane ✓] → [2 Lista ✓] → [3 Przegląd ✓] → [4 Doprecyzowanie •] → [5 Zatwierdzenie] → [6 Koszyk] → [7 Płatność]');
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

test('the server step szkic lands on Przegląd with lines and on Lista without; later steps shift by one', () => {
  const at = (step: string, lines: object[]) => viewModel({ trip: { step, lines, proposal: null, unmatched: [], messages: [] } }).stepIndex;
  assert.equal(at('dane', []), 0);
  assert.equal(at('szkic', []), 1);
  assert.equal(at('szkic', [line]), 2);
  assert.equal(at('doprecyzowanie', [line]), 3);
  assert.equal(at('zatwierdzenie', [line]), 4);
  assert.equal(at('koszyk', [line]), 5);
  assert.equal(at('platnosc', [line]), 6);
});

test('after a note the page shows Przegląd unless the trip is already in the cart or paid', () => {
  assert.equal(afterNote(1), 2);
  assert.equal(afterNote(2), 2);
  assert.equal(afterNote(3), 2, 'open questions are reached with Dalej');
  assert.equal(afterNote(4), 2);
  assert.equal(afterNote(5), 5);
  assert.equal(afterNote(6), 6);
});

test('Dalej on Przegląd goes to Doprecyzowanie, or straight to Zatwierdzenie when nothing is open', () => {
  assert.equal(reviewNext({ questions: [], proposalPending: false }), 4);
  assert.equal(reviewNext({ questions: [line], proposalPending: false }), 3);
  assert.equal(reviewNext({ questions: [], proposalPending: true }), 3);
});

test('Lista tells about an existing draft and offers Przegląd', () => {
  assert.equal(listNotice(0), null);
  assert.deepEqual(listNotice(1), { text: 'Masz już ułożony szkic (1 produkt) — ', link: 'Przejdź do przeglądu →' });
  assert.equal(listNotice(3)!.text, 'Masz już ułożony szkic (3 produkty) — ');
  assert.equal(listNotice(5)!.text, 'Masz już ułożony szkic (5 produktów) — ');
});

test('approving is only possible up to the approval step', () => {
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
  assert.equal(nextSelected(5, 4), 4, 'cart tab after the fill failed');
  assert.equal(nextSelected(6, 4), 4);
  assert.equal(nextSelected(4, 5), 5, 'the fill started');
  assert.equal(nextSelected(1, 4), 1, 'the user browsing earlier tabs is left alone');
  assert.equal(nextSelected(0, 4, true), 4, 'first load');
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

const mlLine = { ...cardLine, lineKey: 't:marchew', term: 'marchew', name: 'Marchew 1 kg' };
const kurczak = { ...cardLine, lineKey: 't:kurczak', term: 'pierś z kurczaka', name: 'Pierś kurczaka' };

test('proposalNote counts the changes shown at products and names each line', () => {
  const trip = { lines: [mlLine, kurczak], proposal: { id: 'p', ops: [
    { op: 'setQuantity', lineKey: 't:marchew', quantity: 2 }, { op: 'remove', lineKey: 't:kurczak' }, { op: 'add', term: 'chleb', quantity: 1 }] } };
  const n = proposalNote(trip)!;
  assert.equal(n.intro, 'Jeszcze 2 zmiany przy produktach:');
  assert.deepEqual(n.items, [{ lineKey: 't:marchew', name: 'marchew', what: 'ilość 2' }, { lineKey: 't:kurczak', name: 'pierś z kurczaka', what: 'usuń' }]);
  assert.equal(n.text, 'Jeszcze 2 zmiany przy produktach: marchew (ilość 2), pierś z kurczaka (usuń).');
  assert.equal(proposalNote({ lines: [mlLine], proposal: { id: 'p', ops: [{ op: 'add', term: 'x', quantity: 1 }] } }), null);
  assert.equal(proposalNote({ lines: [], proposal: null }), null);
  const one = proposalNote({ lines: [mlLine], proposal: { id: 'p', ops: [{ op: 'remove', lineKey: 't:marchew' }] } })!;
  assert.equal(one.intro, 'Jeszcze 1 zmiana przy produktach:');
});

test('proposal buttons say what accepting does for each kind', () => {
  assert.deepEqual(proposalButtons({ op: 'unmatched', term: 'x' }), { accept: 'OK, dodam sam na Auchan', skip: 'Pomiń' });
  assert.deepEqual(proposalButtons({ op: 'add', term: 'x', quantity: 1 }), { accept: 'Dodaj do listy', skip: 'Pomiń' });
  assert.deepEqual(proposalButtons({ op: 'remove', lineKey: 'a' }), { accept: 'Weź to', skip: 'Pomiń' });
});

test('accept-all summary says what the number contains', () => {
  const ops = [{ op: 'unmatched', term: 'a' }, { op: 'unmatched', term: 'b' }, { op: 'setQuantity', lineKey: 'x', quantity: 2 }, { op: 'remove', lineKey: 'y' }, { op: 'add', term: 'c', quantity: 1 }];
  assert.equal(acceptAllSummary(ops), '2 do dodania ręcznie, 1 do dodania do listy, 1 zmiana ilości, 1 usunięcie');
  assert.equal(acceptAllSummary([]), '');
  assert.equal(acceptAllSummary([{ op: 'remove', lineKey: 'y' }, { op: 'remove', lineKey: 'z' }, { op: 'choose', lineKey: 'q', productId: 'p' }]), '1 zamiana produktu, 2 usunięcia');
});

test('auchanSearchUrl encodes the term for the Auchan search page', () => {
  assert.equal(auchanSearchUrl('parówki'), 'https://zakupy.auchan.pl/search?q=par%C3%B3wki');
  assert.equal(auchanSearchUrl('mąka & cukier?#'), 'https://zakupy.auchan.pl/search?q=m%C4%85ka%20%26%20cukier%3F%23');
  assert.equal(new URL(auchanSearchUrl('a/../b')).origin, 'https://zakupy.auchan.pl');
});

test('the manual hint says the planner learns hand-added products from the placed order', () => {
  assert.equal(MANUAL_HINT, 'Produkty dodane ręcznie na Auchan planer pozna po złożeniu zamówienia.');
});

test('the search panel says what the browser is waiting for, in Polish', () => {
  assert.deepEqual(searchPanel(null, 'search'), { text: 'Otwieram przeglądarkę…', active: true });
  assert.deepEqual(searchPanel({ type: 'search', status: 'login' }, 'search'), { text: 'Zaloguj się w oknie przeglądarki…', active: true });
  assert.deepEqual(searchPanel({ type: 'search', status: 'captcha', term: 'ser' }, 'search'), { text: 'Rozwiąż weryfikację w oknie przeglądarki (to wymóg Auchan)…', active: true });
  assert.deepEqual(searchPanel({ type: 'search', status: 'searching', term: 'ser', index: 2, total: 5 }, 'search'), { text: 'Szukam: ser (2/5)…', active: true });
});

test('the search panel reports the result, a stop, and hides when nothing happened', () => {
  assert.deepEqual(searchPanel({ type: 'search', status: 'done', found: 4, total: 5 }, null), { text: 'Znaleziono produkty dla 4 z 5 haseł.', active: false });
  const stopped = searchPanel({ type: 'search', status: 'stopped', found: 1, total: 5 }, null);
  assert.equal(stopped.active, false);
  assert.match(stopped.text, /zatrzymano/i);
  assert.match(stopped.text, /1 z 5/);
  assert.match(stopped.text, /nie ponawiam/i);
  assert.equal(searchPanel(null, null), null);
  assert.equal(searchPanel({ type: 'search', status: 'searching', term: 'ser', index: 1, total: 2 }, null), null, 'a stale running status is not shown once the search is over');
});

test('a stop with a reason shows that reason', () => {
  assert.deepEqual(searchPanel({ type: 'search', status: 'stopped', found: 0, total: 2, reason: 'Zamknij inne okno.' }, null), { text: 'Zamknij inne okno.', active: false });
});

test('after a refusal the page says until when searching is held back, and hides the button', () => {
  const block = { until: '2026-11-16T14:30:00.000Z', status: 403 };
  const text = searchBlockText(block, 'UTC');
  assert.match(text, /^Auchan odmówił wyszukiwania \(403\)\. Wyszukiwanie wstrzymane do .*16.*14:30\.$/);
  assert.deepEqual(searchPanel(null, null, block), { text: searchBlockText(block), active: false });
  assert.deepEqual(searchPanel({ type: 'search', status: 'stopped', found: 0, total: 1 }, null, block), { text: searchBlockText(block), active: false }, 'the block wins over the stale stop');
  assert.equal(searchButton({ trip: { step: 'szkic' }, busy: null, search: { terms: ['a'], recent: [], block } }), null);
  assert.notEqual(searchButton({ trip: { step: 'szkic' }, busy: null, search: { terms: ['a'], recent: [], block: null } }), null);
});

test('the search button counts the terms, and offers a forced rerun when all were searched lately', () => {
  const state = (search: object, busy: string | null = null, step = 'szkic') => ({ trip: { step }, busy, search });
  assert.deepEqual(searchButton(state({ terms: ['a', 'b'], recent: [] })), { label: 'Szukaj w Auchan (2)', force: false, disabled: false });
  assert.deepEqual(searchButton(state({ terms: [], recent: ['a'] })), { label: 'Szukaj ponownie (1)', force: true, disabled: false });
  assert.equal(searchButton(state({ terms: [], recent: [] })), null);
  assert.equal(searchButton({ trip: { step: 'szkic' }, busy: null }), null, 'an older state without search info');
  assert.equal(searchButton(state({ terms: ['a'], recent: [] }, 'sync')).disabled, true);
  assert.equal(searchButton(state({ terms: ['a'], recent: [] }, 'search')).disabled, true);
  assert.equal(searchButton(state({ terms: ['a'], recent: [] }, null, 'koszyk')), null);
});

test('every link to Auchan opens safely: noopener noreferrer, no referrer', () => {
  const js = readFileSync('public/app.js', 'utf8');
  const html = readFileSync('public/index.html', 'utf8');
  assert.doesNotMatch(html, /zakupy\.auchan\.pl/);
  const hrefs = [...js.matchAll(/\.href = ([^;]*);/g)];
  assert.ok(hrefs.length >= 2, 'the pay link and the search link');
  for (const m of hrefs) {
    const around = js.slice(m.index!, m.index! + 260);
    assert.match(around, /target = '_blank'/, m[0]);
    assert.match(around, /rel = 'noopener noreferrer'/, m[0]);
  }
  const search = js.slice(js.indexOf('function searchLink'), js.indexOf('function searchLink') + 400);
  assert.match(search, /referrerPolicy = 'no-referrer'/);
});

test('the search button is disabled while a note or an ask call is pending', () => {
  const state = { trip: { step: 'szkic' }, busy: null, search: { terms: ['a'], recent: [] } };
  assert.equal(searchButton(state, null).disabled, false);
  assert.equal(searchButton(state, 'note').disabled, true);
  assert.equal(searchButton(state, 'ask').disabled, true);
});

test('the page has a polite search status panel', () => {
  const html = readFileSync('public/index.html', 'utf8');
  assert.match(html, /id="search-status"[^>]*role="status"[^>]*aria-live="polite"/);
});

test('the page code lists the manual hint under the search links in steps 4 and 6', () => {
  const js = readFileSync('public/app.js', 'utf8');
  assert.ok(js.match(/MANUAL_HINT/g)!.length >= 3, 'defined once, shown in step 2/3 cards, 4 and 6');
  assert.match(js, /\/api\/search/);
});

test('theme helpers accept only known themes and never throw on broken storage', () => {
  assert.deepEqual(THEMES, ['system', 'light', 'dark']);
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('purple'), 'system');
  assert.equal(normalizeTheme(null), 'system');
  assert.equal(readTheme({ getItem: () => 'light' }), 'light');
  assert.equal(readTheme({ getItem: () => 'nope' }), 'system');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readTheme(broken), 'system');
  assert.equal(readTheme(undefined), 'system');
  assert.equal(saveTheme(broken, 'dark'), false);
  const kept = new Map<string, string>();
  const ok = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  assert.equal(saveTheme(ok, 'dark'), true);
  assert.equal(readTheme(ok), 'dark');
});

test('applyTheme sets data-theme for light and dark and removes it for system', () => {
  const root = { dataset: {} as Record<string, string> };
  applyTheme(root, 'dark');
  assert.equal(root.dataset.theme, 'dark');
  applyTheme(root, 'light');
  assert.equal(root.dataset.theme, 'light');
  applyTheme(root, 'system');
  assert.equal('theme' in root.dataset, false);
});

test('the header has a three-button theme switch with aria-pressed', () => {
  const html = readFileSync('public/index.html', 'utf8');
  for (const theme of THEMES) assert.match(html, new RegExp(`<button[^>]*type="button"[^>]*data-theme-choice="${theme}"[^>]*aria-pressed="false"`));
  assert.match(html, /role="group"[^>]*aria-label="Motyw"/);
});

test('dark palette is defined twice and no hard-coded colour sits outside the token blocks', () => {
  const css = readFileSync('public/app.css', 'utf8');
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/);
  assert.match(css, /:root\[data-theme="dark"\]\s*\{/);
  const outside = css.replace(/\/\*tokens\*\/[\s\S]*?\/\*end tokens\*\//g, '');
  assert.doesNotMatch(outside, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(outside, /\b(?:rgba?|hsla?)\(/);
  assert.doesNotMatch(outside, /:\s*(?:white|black)\b/);
  assert.match(css, /body\{[^}]*background:var\(--bg\)/);
});

function ratio(a: string, b: string) {
  const lum = (h: string) => { const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test('both palettes keep text at 4.5:1 and dark borders and focus at 3:1', () => {
  const css = readFileSync('public/app.css', 'utf8');
  const blocks = [...css.matchAll(/\/\*tokens\*\/([\s\S]*?)\/\*end tokens\*\//g)].map((m) => m[1]);
  assert.equal(blocks.length, 3);
  const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const light = tokens(blocks[0]);
  const dark = { ...light, ...tokens(blocks[1]) };
  assert.deepEqual(tokens(blocks[1]), tokens(blocks[2]));
  const textPairs: [string, string][] = [['text', 'bg'], ['text', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'mode-bg'], ['muted', 'work-bg'], ['green', 'bg'], ['green', 'surface'], ['on-accent', 'green'],
    ['danger', 'surface'], ['active-text', 'active-bg'], ['badge-text', 'badge-bg'], ['med-text', 'med-bg'], ['low-text', 'low-bg'], ['alert-text', 'alert-bg'], ['block-text', 'block-bg'], ['text', 'row-bg'], ['text', 'prop-bg'], ['alert-text', 'prop-bg'], ['dis-text', 'dis-bg'], ['text', 'wait-bg'], ['text', 'work-bg'], ['text', 'hover-bg'], ['text', 'flash-bg'], ['text', 'msg-bg']];
  for (const [name, palette] of [['light', light], ['dark', dark]] as const) {
    for (const [fg, bg] of textPairs) assert.ok(ratio(palette[fg], palette[bg]) >= 4.5, `${name} ${fg}/${bg} ${ratio(palette[fg], palette[bg]).toFixed(2)}`);
    assert.ok(ratio(palette.focus, palette.bg) >= 3 && ratio(palette.focus, palette.surface) >= 3, `${name} focus`);
  }
  for (const bg of ['surface', 'bg']) assert.ok(ratio(dark.line, dark[bg]) >= 3, `dark line/${bg}`);
  assert.ok(ratio(dark.field, dark.surface) >= 3, 'dark field');
});

test('theme.js is a blocking classic script in the head before the stylesheet', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const tag = html.match(/<script[^>]*src="\/theme\.js[^>]*>/)?.[0] ?? '';
  assert.ok(tag, 'theme.js is loaded');
  assert.doesNotMatch(tag, /type="module"|defer|async/);
  assert.ok(html.indexOf('/theme.js') < html.indexOf('/app.css'), 'before the stylesheet');
  assert.ok(html.indexOf('/theme.js') < html.indexOf('</head>'), 'in the head');
});

test('theme.js applies the stored theme to the root and ignores broken storage', async () => {
  const { runInNewContext } = await import('node:vm');
  const src = readFileSync('public/theme.js', 'utf8');
  const run = (storage: unknown) => {
    const root = { dataset: {} as Record<string, string> };
    runInNewContext(src, { document: { documentElement: root }, localStorage: storage });
    return root.dataset.theme;
  };
  assert.equal(run({ getItem: () => 'dark' }), 'dark');
  assert.equal(run({ getItem: () => 'light' }), 'light');
  assert.equal(run({ getItem: () => 'system' }), undefined);
  assert.equal(run({ getItem: () => 'purple' }), undefined);
  assert.equal(run({ getItem() { throw new Error('denied'); } }), undefined);
});

test('app.js leaves the first theme application to theme.js', () => {
  assert.doesNotMatch(readFileSync('public/app.js', 'utf8'), /^if \(typeof document !== 'undefined'\) applyTheme/m);
});
