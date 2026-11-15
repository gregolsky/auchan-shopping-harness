export const STEPS = ['Dane', 'Szkic', 'Doprecyzowanie', 'Zatwierdzenie', 'Koszyk', 'Płatność'];
const KEYS = ['dane', 'szkic', 'doprecyzowanie', 'zatwierdzenie', 'koszyk', 'platnosc'];
const HELP = ['Sprawdź świeżość danych lub odśwież historię zakupów.', 'Wklej listę i sprawdź dobrane produkty.', 'Wybierz produkt przy niepewnych dopasowaniach.', 'Sprawdź całą listę przed dodaniem do koszyka.', 'Obserwuj dodawanie produktów.', 'Przejrzyj raport i przejdź do płatności w Auchan.'];
const REASONS = {
  'not bought before': 'nie kupowano wcześniej', 'term only in the flavour': 'nazwa występuje tylko w opisie smaku',
  'pet product': 'produkt dla zwierząt', 'term not at the start of the name': 'nazwa produktu nie zaczyna się od szukanego słowa',
  'mixed with another ingredient': 'produkt zawiera też inny składnik',
};

export function progressLine(index) {
  return STEPS.map((name, i) => `[${i + 1} ${name}${i < index ? ' ✓' : i === index ? ' •' : ''}]`).join(' → ');
}
export function zl(grosze) { return `${(Number(grosze || 0) / 100).toFixed(2).replace('.', ',')} zł`; }

const BLOCKED_TEXT = 'Auchan odrzucił zapytanie. Nie zatwierdzaj ponownie — sprawdź koszyk na Auchan i zacznij nowe zakupy.';

/** Which tab to show after the trip moved: a tab beyond the trip's step (cart, payment) follows the trip back. */
export function nextSelected(selected, stepIndex, first = false) {
  return first || selected >= 4 || stepIndex >= 4 ? stepIndex : selected;
}

/** While Claude works on a note or a command, both buttons stay off and the page says what is happening. */
export function claudeStatus(pending) {
  const text = pending === 'note' ? 'Claude analizuje listę… (do minuty)' : pending === 'ask' ? 'Claude przygotowuje propozycję…' : null;
  return { working: text !== null, text, disableNote: text !== null, disableAsk: text !== null };
}

/** Why approving is not possible right now, in the order the user can act on it; null when it is possible. */
export function approveHint(model, busy) {
  if (model.inCart) return 'Te zakupy są już w koszyku. Zacznij nowe zakupy, żeby dodać coś jeszcze.';
  if (model.blocked) return BLOCKED_TEXT;
  if (busy === 'sync') return 'Trwa synchronizacja danych — poczekaj na koniec.';
  if (busy) return 'Trwa inna operacja — poczekaj na koniec.';
  if (model.proposalPending) return 'Najpierw zastosuj albo odrzuć propozycję zmian.';
  if (model.questions.length > 0) return 'Najpierw odpowiedz na pytania o produkty.';
  if (!model.hasIncluded) return 'Nic nie jest zaznaczone do zamówienia.';
  return null;
}

export function viewModel(state) {
  const trip = state.trip || {};
  const lines = trip.lines || [];
  const stepIndex = Math.max(0, KEYS.indexOf(trip.step));
  const model = {
    stepIndex,
    freshnessText: state.freshness?.ageHours == null ? 'Brak pełnej synchronizacji' : `Dane sprzed ${state.freshness.ageHours} godz.`,
    lines: lines.filter((l) => l.kind === 'item'), suggestions: lines.filter((l) => l.kind === 'suggestion'),
    unmatched: trip.unmatched || [], total: lines.filter((l) => l.included).reduce((sum, l) => sum + l.lineCostGrosze, 0),
    canApprove: stepIndex <= 3 && lines.some((l) => l.included) && !lines.some((l) => l.included && l.question) && !trip.proposal && !state.busy && !trip.blocked,
    inCart: stepIndex >= 4,
    blocked: Boolean(trip.blocked),
    hasIncluded: lines.some((l) => l.included),
    questions: lines.filter((l) => l.included && l.question).map((l) => ({ ...l, label: lineLabel(l) })),
    proposalPending: Boolean(trip.proposal),
    proposalText: trip.proposal?.ops?.map((op) => describeOp(op, new Map(lines.map((l) => [l.lineKey, l])))) || [],
  };
  model.approveHint = approveHint(model, state.busy);
  return model;
}

/** What step 3 shows: a pending proposal comes first and blocks moving on; "no questions" only when nothing waits. */
export function describeQuestions(model) {
  if (model.proposalPending) return { intro: 'Najpierw zastosuj albo odrzuć propozycję Claude.', empty: null, canContinue: false };
  if (model.questions.length === 0) return { intro: null, empty: 'Nie ma pytań do rozstrzygnięcia.', canContinue: true };
  return { intro: null, empty: null, canContinue: false };
}

/** A term Claude could not match keeps its hint next to it. */
export function unmatchedText(item) { return item.hint ? `${item.term} · ${item.hint}` : item.term; }

/** Budget in zł as typed ("150", "149,99"): empty is fine (no budget), anything else that is not a number is refused. */
export function parseBudget(text) {
  const value = String(text ?? '').trim();
  if (value === '') return { ok: true, grosze: undefined };
  if (!/^\d+([.,]\d{1,2})?$/.test(value)) return { ok: false, error: 'Podaj budżet jako liczbę, np. 150 lub 149,99' };
  return { ok: true, grosze: Math.round(Number(value.replace(',', '.')) * 100) };
}

const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many}`;

export const START_TEXT = { note: 'Czytam listę (1/3)…', ask: 'Claude przygotowuje propozycję…' };
const SLOW_AFTER_SECONDS = 90;

/** The status panel while Claude works: stage text, elapsed seconds, the usual duration, and a warning when it takes too long. */
export function workingPanel(text, seconds) {
  return { text, elapsed: `${seconds} s`, hint: 'Zwykle trwa to 10–30 s.', slow: seconds >= SLOW_AFTER_SECONDS ? 'Wciąż pracuję — Claude odpowiada wolniej niż zwykle.' : null };
}

/** What the alert says when a note is done: counts of products, questions and the held Claude proposal; zero parts are left out. */
export function doneSummary(model) {
  const parts = [];
  if (model.lines.length) parts.push(plural(model.lines.length, 'produkt', 'produkty', 'produktów'));
  if (model.questions.length) parts.push(plural(model.questions.length, 'pytanie', 'pytania', 'pytań'));
  const ops = model.proposalText.length;
  if (ops) parts.push(`propozycja Claude: ${plural(ops, 'zmiana', 'zmiany', 'zmian')}`);
  return parts.length ? `Gotowe: ${parts.join(', ')}.` : 'Gotowe.';
}

/** A failed note or command: what went wrong and what to do. */
export function failureText(kind, message) {
  const what = kind === 'note' ? 'Nie udało się ułożyć szkicu' : 'Nie udało się przygotować propozycji';
  return `${what}: ${String(message).replace(/\.$/, '')}. Spróbuj jeszcze raz.`;
}

/** Which item of the user's list a line answers: their own words, or why a suggestion was made. */
export function lineLabel(line) {
  if (line.term) return `z Twojej listy: ${line.note ? `${line.term} — ${line.note}` : line.term}`;
  const reason = String(line.reason || '');
  if (/^on offer|below its usual/.test(reason)) return 'propozycja: promocja';
  if (/^bought /.test(reason)) return 'propozycja: kupujesz często';
  return 'propozycja';
}

export function describeOp(op, linesByKey) {
  const line = linesByKey.get(op.lineKey);
  const name = line?.name || line?.term || 'pozycję';
  const of = line?.term ? `${line.term}: ` : '';
  switch (op.op) {
    case 'add': return `Dodaj „${op.term}” × ${op.quantity}`;
    case 'choose': return `${of}zamień „${name}” na „${line?.candidates?.find((c) => c.productId === op.productId)?.name || op.productId}”`;
    case 'remove': return `${of}usuń „${name}”`;
    case 'setQuantity': return `${of}ustaw „${name}” na ${op.quantity} szt.`;
    case 'ask': return `${of}zapytaj o „${name}”: ${op.question}`;
    case 'unmatched': return `Dodaj ręcznie „${op.term}”`;
    case 'say': return op.text;
    default: return 'Nieznana zmiana';
  }
}

function element(tag, className = '', value = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value);
  return node;
}
function append(parent, ...children) { for (const child of children) parent.append(child); return parent; }
function button(label, action, className = 'button', disabled = false) {
  const node = element('button', className, label);
  node.type = 'button'; node.disabled = disabled; node.addEventListener('click', action); return node;
}
function card(title, description = '') {
  const node = element('section', 'card');
  append(node, element('h2', '', title));
  if (description) append(node, element('p', 'subtle', description));
  return node;
}
function badge(line) {
  const labels = { high: 'Pewne', medium: 'Sprawdź wybór', low: 'Niepewne' };
  return element('span', `badge ${line.confidence}`, labels[line.confidence] || 'Sprawdź');
}

export function start() {
  const token = new URL(location.href).searchParams.get('t') || '';
  const target = document.querySelector('#content');
  const steps = document.querySelector('#steps');
  const alert = document.querySelector('#alert');
  let state = null, selected = 0, rulesOpen = false, report = null, progress = { sent: 0, total: 0 }, logs = [];
  let productSearch = '', searchResults = [], searchDone = false, renderVersion = 0, pending = null;
  const draftForm = { note: null, usual: false, budget: '', ask: '' };

  const tell = (message) => { alert.textContent = message || ''; alert.hidden = !message; };
  async function api(path, body) {
    const options = { headers: { 'x-app-token': token } };
    if (body !== undefined) { options.method = 'POST'; options.headers['content-type'] = 'application/json'; options.body = JSON.stringify(body); }
    const response = await fetch(path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Nie udało się wykonać operacji.');
    return data;
  }
  async function run(path, body) {
    try {
      tell('');
      const result = await api(path, body);
      if (result?.trip) state = result;
      else if (result?.step) state.trip = result;
      else if (result?.started === false) tell(result.reason || 'Operacja nie została rozpoczęta.');
      await refresh();
      return result;
    } catch (error) { tell(error.message); return null; }
  }
  async function refresh() {
    try { const first = state === null; state = await api('/api/state'); selected = nextSelected(selected, viewModel(state).stepIndex, first); render(); }
    catch (error) { tell(error.message); }
  }

  /** Runs one Claude call at a time; a second click while it is in flight does nothing. */
  async function withClaude(kind, work) {
    if (pending !== null) return;
    pending = kind; render();
    try { await work(); } finally { pending = null; render(); }
  }
  const claudeNote = () => { const status = claudeStatus(pending); return status.working ? element('p', 'meta', status.text) : null; };

  function renderSteps(model) {
    steps.replaceChildren();
    STEPS.forEach((name, i) => {
      const allowed = i <= Math.max(model.stepIndex, 1);
      const tab = button(name, () => { rulesOpen = false; selected = i; render(); }, `step ${selected === i && !rulesOpen ? 'active' : i < model.stepIndex ? 'done' : ''}`, !allowed);
      const number = element('span', 'number', i < model.stepIndex ? '✓' : i + 1);
      number.setAttribute('aria-hidden', 'true'); tab.prepend(number);
      tab.setAttribute('aria-label', `${i + 1}. ${name}`);
      tab.setAttribute('aria-current', selected === i && !rulesOpen ? 'step' : 'false');
      steps.append(tab);
    });
    steps.append(button('⚙  Moje reguły', () => { rulesOpen = true; render(); }, `step ${rulesOpen ? 'active' : ''}`));
    document.querySelector('#progress-line').textContent = progressLine(model.stepIndex);
    document.querySelector('#step-help').textContent = rulesOpen ? 'Zobacz zapamiętane wybory i zablokowane produkty.' : HELP[selected];
  }

  function lineRow(line, editable = false) {
    const row = element('div', 'line');
    row.append(element('div', 'meta from-list', lineLabel(line)));
    const heading = element('div', 'row');
    append(heading, element('span', 'line-name', line.name), element('span', 'price', zl(line.lineCostGrosze)));
    append(row, heading, badge(line), element('div', 'meta', `${line.quantity} szt.${line.confidence !== 'high' ? ` · Dlaczego sprawdzić: ${REASONS[line.confidenceReason] || line.confidenceReason || 'dopasowanie niepewne'}` : ''}`));
    if (editable) {
      const actions = element('div', 'actions');
      if (line.kind === 'suggestion') actions.append(button(line.included ? '✓ W koszyku' : '＋ Dodaj', () => run('/api/line', { lineKey: line.lineKey, included: !line.included }), 'small'));
      else {
        actions.append(button('−', () => run('/api/line', { lineKey: line.lineKey, quantity: Math.max(1, line.quantity - 1) }), 'small', line.quantity <= 1));
        actions.append(button('＋', () => run('/api/line', { lineKey: line.lineKey, quantity: Math.min(20, line.quantity + 1) }), 'small', line.quantity >= 20));
        actions.append(button('Usuń', () => run('/api/line', { lineKey: line.lineKey, remove: true }), 'small danger'));
      }
      row.append(actions);
    }
    return row;
  }

  function renderData() {
    const box = card('1. Dane', 'Aktualna historia zakupów pomaga dobrać produkty i sprawdzić ceny.');
    append(box, element('p', '', viewModel(state).freshnessText), button('↻ Odśwież dane', () => run('/api/sync', {})), button('Dalej: szkic →', () => { selected = 1; render(); }, 'quiet'));
    if (state.busy === 'sync') box.append(element('p', 'meta', 'Trwa synchronizacja. Jeśli otworzy się okno Auchan, zaloguj się i pozostaw je otwarte.'));
    target.append(box);
    if (logs.length) target.append(renderLogs());
  }
  function renderDraft() {
    const grid = element('div', 'grid');
    const form = card('2. Szkic listy', 'Wklej listę. Możesz dopisać ilość na końcu każdego wiersza.');
    const note = element('textarea'); note.value = draftForm.note ?? state.trip.note ?? ''; note.placeholder = 'mleko 2\nchleb\nmąka pszenna 1'; note.setAttribute('aria-label', 'Lista zakupów'); note.addEventListener('input', () => { draftForm.note = note.value; });
    const usual = element('input'); usual.type = 'checkbox'; usual.id = 'usual'; usual.checked = draftForm.usual; usual.addEventListener('change', () => { draftForm.usual = usual.checked; });
    const usualLabel = element('label', 'check'); append(usualLabel, usual, element('span', '', 'Dodaj to, co zwykle kupuję'));
    const budget = element('input'); budget.type = 'text'; budget.inputMode = 'decimal'; budget.placeholder = 'Opcjonalnie'; budget.id = 'budget'; budget.value = draftForm.budget; budget.addEventListener('input', () => { draftForm.budget = budget.value; });
    const budgetLabel = element('label', '', 'Budżet w zł'); budgetLabel.htmlFor = 'budget';
    append(form, note, usualLabel, budgetLabel, budget,
      button('Ułóż szkic →', async () => { const parsed = parseBudget(budget.value); if (!parsed.ok) { tell(parsed.error); return; } const body = { note: note.value, includeUsual: usual.checked }; if (parsed.grosze !== undefined) body.budgetGrosze = parsed.grosze; await withClaude('note', async () => { await run('/api/note', body); selected = 1; }); }, 'button', state.busy === 'fill' || claudeStatus(pending).disableNote));
    if (claudeNote()) form.append(claudeNote());
    const results = card('Wybrane produkty', 'Sprawdź nazwę, ilość i ocenę dopasowania.');
    const model = viewModel(state);
    const blockedNotice = state.trip.messages?.find((m) => m.startsWith('Pominięto zablokowane produkty:'));
    if (blockedNotice) results.append(element('p', 'message blocked', `⛔ ${blockedNotice}`));
    if (!model.lines.length) results.append(element('p', 'empty', 'Produkty pojawią się tu po ułożeniu szkicu.'));
    model.lines.forEach((l) => results.append(lineRow(l, true)));
    if (model.suggestions.length) {
      results.append(element('h3', '', 'Propozycje · dodawane tylko po Twoim kliknięciu'));
      model.suggestions.forEach((l) => results.append(lineRow(l, true)));
    }
    if (model.unmatched.length) {
      results.append(element('h3', '', 'Nie znaleziono w katalogu'));
      model.unmatched.forEach((item) => results.append(element('p', 'meta', `${item.term} · dodaj ręcznie w Auchan`)));
    }
    if (model.lines.length) results.append(element('div', 'total row', `Szacowana kwota: ${zl(model.total)}`));
    append(grid, form, results); target.append(grid);
    if (state.trip.lines.length) target.append(button('Dalej: doprecyzowanie →', () => { selected = 2; render(); }, 'quiet'));
  }
  function renderQuestions() {
    const model = viewModel(state);
    const info = describeQuestions(model);
    if (model.proposalPending) renderProposal(true);
    const box = card('3. Doprecyzowanie', 'Wybierz produkt tam, gdzie dopasowanie wymaga Twojej decyzji.');
    if (info.intro) box.append(element('p', 'message', info.intro));
    if (info.empty) box.append(element('p', 'empty', info.empty));
    target.append(box);
    model.questions.forEach((l) => {
      const row = card(l.question.text);
      row.prepend(element('div', 'meta from-list', l.label));
      const options = element('div', 'choices');
      l.question.options.forEach((id) => options.append(button(l.candidates.find((c) => c.productId === id)?.name || id, () => run('/api/answer', { lineKey: l.lineKey, productId: id }), 'small')));
      options.append(button('Pomiń produkt', () => run('/api/answer', { lineKey: l.lineKey, productId: null }), 'small danger'));
      row.append(options); target.append(row);
    });
    target.append(button('Dalej: zatwierdzenie →', () => { selected = 3; render(); }, 'quiet', !info.canContinue));
  }
  function renderReview() {
    const model = viewModel(state);
    const box = card('4. Zatwierdzenie', 'Ostatnia kontrola przed dodaniem produktów do koszyka Auchan.');
    const included = state.trip.lines.filter((l) => l.included);
    included.forEach((l) => box.append(lineRow(l)));
    if (!included.length) box.append(element('p', 'empty', 'Lista jest pusta. Wróć do szkicu.'));
    if (model.unmatched.length) append(box, element('h3', '', 'Do dodania ręcznie w Auchan'), ...model.unmatched.map((u) => element('p', 'meta', unmatchedText(u))));
    append(box, element('div', 'total', `Szacowana kwota: ${zl(model.total)}`), model.inCart ? element('p', 'meta', 'Te zakupy są już w koszyku. Zacznij nowe zakupy, żeby dodać coś jeszcze.') : button('✓ Zatwierdź i dodaj do koszyka', async () => { const result = await run('/api/approve', {}); if (result?.started) { selected = 4; render(); } }, 'button', !model.canApprove));
    if (!model.canApprove && !model.inCart && model.approveHint) box.append(element('p', 'meta', model.approveHint));
    target.append(box);
  }
  function renderLogs() { const box = card('Dziennik'); logs.slice(-20).forEach((l) => box.append(element('p', 'message', l))); return box; }
  function renderCart() {
    const box = card('5. Koszyk', 'Produkty są dodawane partiami. Możesz obserwować postęp.');
    const bar = element('progress'); bar.max = Math.max(progress.total, 1); bar.value = progress.sent; bar.setAttribute('aria-label', 'Postęp dodawania produktów do koszyka');
    append(box, bar, element('p', 'meta', `${progress.sent} z ${progress.total} produktów`)); target.append(box);
    if (logs.length) target.append(renderLogs());
  }
  function renderPayment() {
    const box = card('6. Płatność', 'Sprawdź raport, potem przejdź do Auchan. Aplikacja nie składa zamówienia ani nie płaci.');
    const reportText = report?.text || state.trip.reportText;
    if (reportText) {
      let group = null;
      reportText.split('\n').filter(Boolean).forEach((line) => {
        if (line.endsWith(':')) { group = element('div', 'report-group'); group.append(element('h3', '', line.slice(0, -1))); box.append(group); }
        else (group || box).append(element('p', 'meta', line.trim()));
      });
    }
    else box.append(element('p', 'empty', 'Raport jest dostępny po zakończeniu dodawania produktów. Po odświeżeniu strony sprawdź koszyk bezpośrednio w Auchan.'));
    const link = element('a', 'button', '↗ Zapłać na Auchan'); link.href = 'https://zakupy.auchan.pl/checkout'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    box.append(link); target.append(box);
  }
  async function renderRules(version) {
    const box = card('Moje reguły', 'Tu widać wybory, których nauczył się planer.'); target.append(box);
    try {
      const rules = await api('/api/rules');
      if (!rulesOpen || version !== renderVersion) return;
      if (!rules.length) box.append(element('p', 'empty', 'Nie ma jeszcze zapisanych reguł.'));
      rules.forEach((rule) => {
        const row = element('div', 'line row');
        const text = rule.brand ? `${rule.term} · marka ${rule.brand}` : rule.term;
        append(row, element('span', '', text), button('Usuń regułę', async () => { await run('/api/rules/delete', { term: rule.term }); render(); }, 'small danger'));
        if (rule.brand) row.append(button('Usuń markę', async () => { await run('/api/rules/brand', { term: rule.term, brand: null }); render(); }, 'small'));
        box.append(row);
      });
      const blocked = await api('/api/blocked');
      if (!rulesOpen || version !== renderVersion) return;
      const blockedBox = card('Produkty zablokowane', 'Zablokowanych produktów planer nie proponuje i nie dodaje do koszyka. Zmiana listy wymaga ponownego ułożenia szkicu.');
      if (!blocked.length) blockedBox.append(element('p', 'empty', 'Brak zablokowanych produktów.'));
      blocked.forEach((item) => {
        const row = element('div', 'line row');
        append(row, element('span', 'line-name', `⛔ ${item.name}`), button('Odblokuj', async () => {
          const changed = await run('/api/blocked/remove', { productId: item.productId });
          if (changed?.changed) render();
        }, 'small danger', state.busy !== null));
        blockedBox.append(row);
      });
      target.append(blockedBox);
      const searchBox = card('Zablokuj produkt', 'Wyszukaj dokładny produkt z katalogu Auchan, potem wybierz „Zablokuj”.');
      const label = element('label', '', 'Nazwa produktu'); label.htmlFor = 'product-search';
      const input = element('input'); input.type = 'search'; input.id = 'product-search'; input.value = productSearch;
      input.placeholder = 'np. mąka pszenna'; input.addEventListener('input', () => { productSearch = input.value; });
      const find = button('Szukaj produktów', async () => {
        try { tell(''); searchResults = await api('/api/blocked/search', { query: input.value.trim() }); productSearch = input.value; searchDone = true; render(); }
        catch (error) { tell(error.message); }
      }, 'quiet');
      append(searchBox, label, input, find);
      if (searchDone && searchResults.length === 0) searchBox.append(element('p', 'empty', 'Brak wyników. Spróbuj krótszej nazwy.'));
      const blockedIds = new Set(blocked.map((p) => p.productId));
      searchResults.forEach((item) => {
        const row = element('div', 'line row');
        append(row, element('span', 'line-name', item.name), button(blockedIds.has(item.productId) ? 'Zablokowany' : 'Zablokuj', async () => {
          const changed = await run('/api/blocked/add', { productId: item.productId });
          if (changed?.changed) render();
        }, 'small', blockedIds.has(item.productId) || state.busy !== null));
        searchBox.append(row);
      });
      target.append(searchBox);
    } catch (error) { tell(error.message); }
  }
  function renderProposal(early = false) {
    const proposal = state.trip.proposal;
    if (!proposal || ![1, 2, 3].includes(selected) || (selected === 2 && !early)) return;
    const box = card('Propozycja zmian od Claude', 'Zmiany czekają na Twoją decyzję.');
    viewModel(state).proposalText.forEach((t) => box.append(element('p', 'message', t)));
    if (proposal.dropped) box.append(element('p', 'meta', `Pominięto ${proposal.dropped} nieprawidłowych zmian.`));
    append(box, button('Zastosuj', () => run('/api/apply', { proposalId: proposal.id })), button('Odrzuć', () => run('/api/reject', { proposalId: proposal.id }), 'quiet'));
    target.append(box);
  }
  function renderAsk() {
    if (![1, 2, 3].includes(selected) || !state.trip.lines.length) return;
    const box = card('Powiedz, co zmienić', 'Możesz opisać zmianę własnymi słowami. Zobaczysz propozycję przed zastosowaniem.');
    const input = element('textarea', 'short-textarea'); input.setAttribute('aria-label', 'Polecenie dla Claude'); input.placeholder = 'Na przykład: wybierz większe opakowanie sera';
    input.value = draftForm.ask; input.addEventListener('input', () => { draftForm.ask = input.value; });
    append(box, input, button('Zaproponuj zmianę', () => withClaude('ask', async () => { const result = await run('/api/ask', { text: input.value }); if (result) draftForm.ask = ''; }), 'quiet', state.busy === 'fill' || claudeStatus(pending).disableAsk));
    if (claudeNote()) box.append(claudeNote());
    target.append(box);
  }
  function render() {
    if (!state) return;
    const version = ++renderVersion;
    const model = viewModel(state);
    document.querySelector('#mode').textContent = state.trip.mode === 'fallback' ? 'Tryb bez Claude' : 'Z pomocą Claude';
    document.querySelector('#new-trip').disabled = state.busy === 'fill' || state.trip.step === 'koszyk';
    renderSteps(model); target.replaceChildren();
    if (rulesOpen) { void renderRules(version); return; }
    [renderData, renderDraft, renderQuestions, renderReview, renderCart, renderPayment][selected]();
    renderProposal(); renderAsk();
    const messages = (state.trip.messages || []).filter((m) => selected !== 1 || !m.startsWith('Pominięto zablokowane produkty:')).slice(-4);
    if (messages.length) {
      const box = card('Wskazówki'); messages.forEach((m) => box.append(element('p', 'message', m))); target.append(box);
    }
  }
  document.querySelector('#new-trip').addEventListener('click', async () => { if (state.busy === 'fill') return; const result = await run('/api/trip/reset', {}); if (result?.step === 'dane') { selected = 0; rulesOpen = false; report = null; logs = []; draftForm.note = null; draftForm.usual = false; draftForm.budget = ''; draftForm.ask = ''; render(); } });
  const events = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  events.addEventListener('state', () => { void refresh(); });
  events.addEventListener('progress', (event) => { progress = JSON.parse(event.data); if (selected === 4) render(); });
  events.addEventListener('log', (event) => { logs.push(JSON.parse(event.data).text); if (selected === 4 || selected === 0) render(); });
  events.addEventListener('report', (event) => { report = JSON.parse(event.data).report; selected = 5; render(); });
  events.addEventListener('done', () => { void refresh(); });
  void refresh();
}

if (typeof document !== 'undefined') start();
