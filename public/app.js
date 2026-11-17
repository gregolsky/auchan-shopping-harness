export const STEPS = ['Dane', 'Lista', 'Przegląd', 'Doprecyzowanie', 'Zatwierdzenie', 'Koszyk', 'Płatność'];
const CATEGORY_ORDER = ['produce', 'dairy', 'meat', 'bread', 'drink', 'snack', 'frozen', 'pantry', 'care', 'pet', 'other'];
const CATEGORY_LABELS = { produce: 'Warzywa i owoce', dairy: 'Nabiał', meat: 'Mięso, wędliny i ryby', bread: 'Pieczywo', drink: 'Napoje', snack: 'Słodycze i przekąski', frozen: 'Mrożonki', pantry: 'Suche i spiżarnia', care: 'Chemia i higiena', pet: 'Zwierzęta', other: 'Inne' };
const categoryText = (value) => String(value || '').toLocaleLowerCase('pl').normalize('NFD').replace(/\p{M}/gu, '').replace(/ł/g, 'l').trim();

/** Stable catalog grouping; a missing or new branch gets the visible Inne fallback. */
export function categoryFor(categoryPath) {
  const path = Array.isArray(categoryPath) ? categoryPath.map(categoryText) : [];
  const [root, branch, detail] = path;
  let key = 'other';
  if (path.some((part) => part.includes('mrozonk') || part.includes('mrozone'))) key = 'frozen';
  else if (detail?.includes('wypieki slodkie')) key = 'snack';
  else if (root === 'dla zwierzat') key = 'pet';
  else if (root === 'chemia i srodki czystosci' || root === 'higiena i kosmetyki') key = 'care';
  else if (['mleko, nabial i jaja', 'sery'].includes(branch) || detail === 'zamienniki nabialu') key = 'dairy';
  else if (branch === 'owoce, warzywa i ziola') key = 'produce';
  else if (['mieso i drob', 'wedliny', 'ryby i owoce morza'].includes(branch)) key = 'meat';
  else if (branch === 'pieczywo i wyroby cukiernicze') key = 'bread';
  else if (['napoje', 'soki, nektary', 'napoje, soki i syropy bio'].includes(branch) || root === 'kawa, herbata i kakao') key = 'drink';
  else if (['slodycze', 'slone przekaski', 'bakalie', 'wypieki'].includes(branch)) key = 'snack';
  else if (root === 'artykuly spozywcze' || root === 'zdrowa zywnosc') key = 'pantry';
  return { key, label: CATEGORY_LABELS[key], icon: key };
}

/** The category text a card shows: none when the card already sits under a heading of that category. */
export function categoryLabelText(categoryPath, groupKey = null) {
  const category = categoryFor(categoryPath);
  return category.key === groupKey ? '' : category.label;
}

export function groupByCategory(items) {
  const groups = new Map();
  items.forEach((item) => {
    const category = categoryFor(item.categoryPath);
    if (!groups.has(category.key)) groups.set(category.key, { category, items: [] });
    groups.get(category.key).items.push(item);
  });
  return [...groups.values()].sort((a, b) => CATEGORY_ORDER.indexOf(a.category.key) - CATEGORY_ORDER.indexOf(b.category.key));
}
const ICON_PATHS = {
  produce: ['M12 7C8 4 4 7 4 13C4 19 8 22 12 19C16 22 20 19 20 13C20 7 16 4 12 7Z', 'M12 7C12 4 13 3 16 2', 'M12 7C10 5 8 5 6 5', 'M8 12C8 10 9 9 10 9'],
  dairy: ['M7 3H17L19 8V21H5V8Z', 'M7 3L5 8H19L17 3', 'M9 12H15V17H9Z', 'M9 6H15'],
  meat: ['M3 12C7 6 14 6 19 12C14 18 7 18 3 12Z', 'M19 12L22 8V16Z', 'M8 12H8', 'M11 8C12 10 12 14 11 16'],
  bread: ['M3 11C3 7 6 5 9 5C11 3 14 3 16 5C19 5 21 8 21 11V19H3Z', 'M8 9V13', 'M13 8V12', 'M18 9V13', 'M3 16H21'],
  drink: ['M6 5H18L16 20H8Z', 'M7 10H17', 'M10 3H14', 'M12 3V5', 'M10 15H14'],
  snack: ['M12 3C17 3 21 7 21 12C21 17 17 21 12 21C7 21 3 17 3 12C3 7 7 3 12 3Z', 'M9 8H9', 'M16 9H16', 'M8 15H8', 'M14 16H14', 'M12 12H12'],
  frozen: ['M12 2V22', 'M2 12H22', 'M5 5L19 19', 'M19 5L5 19', 'M9 4L12 7L15 4', 'M9 20L12 17L15 20'],
  pantry: ['M6 6H18V21H6Z', 'M5 3H19V6H5Z', 'M9 11H15V16H9Z', 'M8 9H16'],
  care: ['M9 8H16V21H6V11C6 9 7 8 9 8Z', 'M10 8V4H15', 'M14 4H19', 'M9 14H13', 'M9 17H12'],
  pet: ['M8 13C6 15 5 17 6 19C7 21 10 20 12 19C14 20 17 21 18 19C19 17 18 15 16 13C14 11 10 11 8 13Z', 'M5 8C3 8 3 12 5 12C7 12 7 8 5 8Z', 'M19 8C17 8 17 12 19 12C21 12 21 8 19 8Z', 'M10 5C8 5 8 9 10 9C12 9 12 5 10 5Z', 'M14 5C12 5 12 9 14 9C16 9 16 5 14 5Z'],
  other: ['M3 7L12 3L21 7V18L12 22L3 18Z', 'M3 7L12 11L21 7', 'M12 11V22', 'M8 5L17 9'],
  cart: ['M2 4H5L8 17H19L22 8H6', 'M9 21H10', 'M18 21H19'],
  warning: ['M12 3L22 21H2Z', 'M12 9V14', 'M12 18H12'],
  missing: ['M12 3C7 3 3 7 3 12C3 17 7 21 12 21C17 21 21 17 21 12C21 7 17 3 12 3Z', 'M7 17L17 7'],
  action: ['M12 3V21', 'M3 12H21'],
  info: ['M12 3C7 3 3 7 3 12C3 17 7 21 12 21C17 21 21 17 21 12C21 7 17 3 12 3Z', 'M12 10V17', 'M12 7H12'],
  increase: ['M4 18L10 12L14 15L21 7', 'M16 7H21V12'],
};
export const iconPaths = (key) => ICON_PATHS[key] || ICON_PATHS.other;
const REPORT_STATUS = {
  'Sprawdź przed zapłatą': 'warning', 'Pominięto zablokowane produkty': 'warning',
  'Nie dodano': 'missing', 'Brak w sklepie': 'missing',
  'Dodaj sam na Auchan': 'action', 'Było już w koszyku': 'info', 'Niewielkie podwyżki': 'increase',
};
const REPORT_ORDER = ['warning', 'missing', 'action', 'info', 'increase'];

/** Turns the saved CLI report into readable status groups; category comes only from an exact trip-product match. */
export function reportView(reportText, tripLines = [], structured = null) {
  if (structured) {
    const known = new Map(tripLines.filter((line) => line.productId).map((line) => [line.productId, line.categoryPath]));
    const retailerIds = new Map(tripLines.filter((line) => line.productId && line.retailerProductId).map((line) => [line.productId, line.retailerProductId]));
    return {
      sections: structured.sections.filter((section) => section.items.length).map((section) => ({ ...section, items: section.items.map((item) => {
        const categoryPath = item.categoryPath ?? known.get(item.productId);
        const details = [item.note];
        if (item.limit) details.push(`Dodano ${item.limit.added} z ${item.limit.requested} (powód: ${item.limit.reason}).`);
        if (item.substitutes?.length) details.push(`Zamienniki: ${item.substitutes.join('; ')}.`);
        return { ...item, title: item.name, detail: details.filter(Boolean).join(' '), categoryPath, category: categoryFor(categoryPath), retailerProductId: item.retailerProductId ?? retailerIds.get(item.productId) };
      }) })),
      summary: [`Dodano produktów: ${structured.summary.addedCount}`, `Razem w koszyku: ${structured.summary.cartTotalGrosze === null ? 'nieznana kwota' : zl(structured.summary.cartTotalGrosze)}`],
    };
  }
  const sections = [];
  const summary = [];
  let current = null;
  const known = [...tripLines].filter((line) => line.name).sort((a, b) => b.name.length - a.name.length);
  String(reportText || '').split('\n').forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    if (line.endsWith(':')) {
      const title = line.slice(0, -1);
      current = { key: REPORT_STATUS[title] || 'info', title, items: [] };
      sections.push(current);
      return;
    }
    if (/^(Dodano produktów:|Razem w koszyku:|Zapłać na )/.test(line)) { summary.push(line); return; }
    const text = line.replace(/^-\s*/, '');
    if (!current) { summary.push(text); return; }
    const product = known.find((candidate) => text.startsWith(candidate.name) && (text.length === candidate.name.length || /[\s:—]/.test(text[candidate.name.length])));
    const categoryPath = product?.categoryPath;
    const split = text.match(/^(.*?) (— .+|\(zamiast tego:.+\))$/) || text.match(/^(.*?): (\d[\d,]* zł.+)$/);
    current.items.push({ title: split ? split[1] : text, detail: split ? split[2].replace(/^— /, '') : '', categoryPath, category: categoryFor(categoryPath), retailerProductId: product?.retailerProductId });
  });
  return { sections: sections.filter((section) => section.items.length).sort((a, b) => REPORT_ORDER.indexOf(a.key) - REPORT_ORDER.indexOf(b.key)), summary };
}

export function reportPriceText(item) {
  if (item.approvedGrosze !== undefined && item.nowGrosze !== undefined) {
    const rise = item.risePercent === undefined ? '' : ` (+${item.risePercent.toFixed(1).replace('.', ',')}%)`;
    return `${zl(item.approvedGrosze)} → ${zl(item.nowGrosze)}${rise}`;
  }
  if (item.unitPriceGrosze === undefined || item.unitPriceGrosze === null) return '';
  return `${item.priceSource === 'cart' ? 'Cena w koszyku' : 'Cena planowana'}: ${zl(item.unitPriceGrosze)}/szt.`;
}
// The server keeps six steps; its 'szkic' is Lista without lines and Przegląd with lines (see stepIndexOf).
const KEYS = ['dane', 'szkic', 'doprecyzowanie', 'zatwierdzenie', 'koszyk', 'platnosc'];
const FIRST_CART = 5;
const HELP = ['Sprawdź świeżość danych lub odśwież historię zakupów.', 'Wklej listę zakupów i poproś o szkic.', 'Sprawdź dobrane produkty i napisz, co zmienić.', 'Wybierz produkt przy niepewnych dopasowaniach.', 'Sprawdź całą listę przed dodaniem do koszyka.', 'Obserwuj dodawanie produktów.', 'Przejrzyj raport i przejdź do płatności w Auchan.'];
const REASONS = {
  'not bought before': 'nie kupowano wcześniej', 'term only in the flavour': 'nazwa występuje tylko w opisie smaku',
  'pet product': 'produkt dla zwierząt', 'term not at the start of the name': 'nazwa produktu nie zaczyna się od szukanego słowa',
  'product made from the term, not the term itself': 'to produkt z tego składnika, nie sam składnik',
  'mixed with another ingredient': 'produkt zawiera też inny składnik',
};

export const THEMES = ['system', 'light', 'dark'];
const THEME_KEY = 'zakupy-theme';
export function normalizeTheme(value) { return THEMES.includes(value) ? value : 'system'; }
/** The stored choice, or 'system' when nothing valid is stored or storage throws (private window, blocked data). */
export function readTheme(storage) {
  try { return normalizeTheme(storage?.getItem(THEME_KEY)); } catch { return 'system'; }
}
export function saveTheme(storage, theme) {
  try { storage.setItem(THEME_KEY, normalizeTheme(theme)); return true; } catch { return false; }
}
/** 'light' and 'dark' pin the palette; 'system' removes the attribute so prefers-color-scheme decides. */
export function applyTheme(root, theme) {
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
}
function browserStorage() { try { return globalThis.localStorage; } catch { return undefined; } }
// The first application happens in theme.js (a blocking script in the head), so the page does not flash the wrong palette.

function setupThemeSwitch() {
  const buttons = [...document.querySelectorAll('[data-theme-choice]')];
  const show = (theme) => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.themeChoice === theme)); };
  show(readTheme(browserStorage()));
  for (const b of buttons) b.addEventListener('click', () => {
    const theme = normalizeTheme(b.dataset.themeChoice);
    applyTheme(document.documentElement, theme); saveTheme(browserStorage(), theme); show(theme);
  });
}

export function progressLine(index) {
  return STEPS.map((name, i) => `[${i + 1} ${name}${i < index ? ' ✓' : i === index ? ' •' : ''}]`).join(' → ');
}
export function zl(grosze) { return `${(Number(grosze || 0) / 100).toFixed(2).replace('.', ',')} zł`; }

/** Only the computer's local page offers a handoff, and only for a tokenized HTTP link. */
export function phoneEntryVisible(hostname, url) {
  if (!['127.0.0.1', 'localhost'].includes(hostname) || typeof url !== 'string') return false;
  try { const parsed = new URL(url); return parsed.protocol === 'http:' && Boolean(parsed.searchParams.get('t')); }
  catch { return false; }
}

const BLOCKED_TEXT = 'Auchan odrzucił zapytanie. Nie zatwierdzaj ponownie — sprawdź koszyk na Auchan i zacznij nowe zakupy.';

/** Which tab to show after the trip moved: a tab beyond the trip's step (cart, payment) follows the trip back. */
export function nextSelected(selected, stepIndex, first = false) {
  return first || selected >= FIRST_CART || stepIndex >= FIRST_CART ? stepIndex : selected;
}

/** The tab shown when a note is done: Przegląd, unless the trip is already in the cart or paid. */
export function afterNote(stepIndex) { return stepIndex >= FIRST_CART ? stepIndex : 2; }

/** Where Dalej on Przegląd goes: Doprecyzowanie while something is open, else straight to Zatwierdzenie. */
export function reviewNext(model) { return model.questions.length > 0 || model.proposalPending ? 3 : 4; }

/** Lista's note about a draft that already exists; null when there is none. */
export function listNotice(count) {
  return count > 0 ? { text: `Masz już ułożony szkic (${plural(count, 'produkt', 'produkty', 'produktów')}) — `, link: 'Przejdź do przeglądu →' } : null;
}

/** Page step (0..6) of a trip: the server's 'szkic' is Lista (1) with no lines and Przegląd (2) with lines. */
function stepIndexOf(trip) {
  const i = Math.max(0, KEYS.indexOf(trip?.step));
  if (i === 1) return (trip.lines || []).length ? 2 : 1;
  return i > 1 ? i + 1 : i;
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

export function viewModel(state, now = new Date()) {
  const trip = state.trip || {};
  const lines = trip.lines || [];
  const stepIndex = stepIndexOf(trip);
  const model = {
    stepIndex,
    freshnessText: state.freshness?.ageHours == null ? 'Brak pełnej synchronizacji' : `Dane sprzed ${state.freshness.ageHours} godz.`,
    lines: lines.filter((l) => l.kind === 'item'), suggestions: lines.filter((l) => l.kind === 'suggestion'),
    staleNote: lines.some((l) => l.included && priceAgeText(l.latestPriceSeenAt, now)) ? 'Część cen może być nieaktualna.' : null,
    unmatched: trip.unmatched || [], total: lines.filter((l) => l.included).reduce((sum, l) => sum + l.lineCostGrosze, 0),
    canApprove: stepIndex <= 4 && lines.some((l) => l.included) && !lines.some((l) => (l.included || l.held) && l.question) && !trip.proposal && !state.busy && !trip.blocked,
    inCart: stepIndex >= FIRST_CART,
    blocked: Boolean(trip.blocked),
    hasIncluded: lines.some((l) => l.included),
    questions: lines.filter((l) => (l.included || l.held) && l.question).map((l) => ({ ...l, label: lineLabel(l) })),
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

const mini = (c, now) => ({ productId: c.productId, retailerProductId: c.retailerProductId, name: c.name, priceText: zl(c.lineCostGrosze), priceAge: priceAgeText(c.latestPriceSeenAt, now), imageUrl: c.imageUrl || null, imageAlt: c.imageAlt || c.name, categoryPath: c.categoryPath });

/** Claude's pending operations: per line (by lineKey) and the ones not tied to a line; each keeps its index in the proposal. */
export function proposalView(trip) {
  const ops = trip?.proposal?.ops || [];
  const byLine = {}, loose = [];
  const lines = new Map((trip?.lines || []).map((l) => [l.lineKey, l]));
  ops.forEach((op, index) => {
    if (op.lineKey !== undefined && lines.has(op.lineKey)) (byLine[op.lineKey] ||= []).push({ index, op });
    else loose.push({ index, op, text: describeOp(op, lines) });
  });
  return { count: ops.length, byLine, loose };
}
/** The line by line part of a pending proposal: how many changes sit on product cards and what each one does. */
export function proposalNote(trip) {
  const view = proposalView(trip);
  const lines = new Map((trip?.lines || []).map((l) => [l.lineKey, l]));
  const what = (op, line) => ({
    remove: 'usuń', setQuantity: `ilość ${op.quantity}`, ask: 'pytanie',
    choose: `zamiana na ${(line.candidates || []).find((c) => c.productId === op.productId)?.name || 'inny produkt'}`,
  }[op.op] || 'zmiana');
  const items = Object.entries(view.byLine).map(([lineKey, ops]) => {
    const line = lines.get(lineKey);
    return { lineKey, name: line.term || line.name, what: ops.map(({ op }) => what(op, line)).join(', ') };
  });
  if (!items.length) return null;
  const count = Object.values(view.byLine).reduce((n, ops) => n + ops.length, 0);
  const intro = `Jeszcze ${plural(count, 'zmiana', 'zmiany', 'zmian')} przy produktach:`;
  return { intro, items, text: `${intro} ${items.map((i) => `${i.name} (${i.what})`).join(', ')}.` };
}

/** Button labels for a proposal row: accepting an unmatched term only means the user adds it on Auchan themselves. */
export function proposalButtons(op) {
  if (op.op === 'unmatched') return { accept: 'OK, dodam sam na Auchan', skip: 'Odrzuć' };
  if (op.op === 'add') return { accept: 'Dodaj do listy', skip: 'Odrzuć' };
  return { accept: 'Weź to', skip: 'Odrzuć' };
}

/** One line saying what "accept all" contains. */
export function acceptAllSummary(ops) {
  const n = (kind) => ops.filter((o) => o.op === kind).length;
  const p = (kind, one, few, many) => (n(kind) ? [plural(n(kind), one, few, many)] : []);
  return [
    ...(n('unmatched') ? [`${n('unmatched')} do dodania ręcznie`] : []),
    ...(n('add') ? [`${n('add')} do dodania do listy`] : []),
    ...p('choose', 'zamiana produktu', 'zamiany produktu', 'zamian produktu'),
    ...p('setQuantity', 'zmiana ilości', 'zmiany ilości', 'zmian ilości'),
    ...p('remove', 'usunięcie', 'usunięcia', 'usunięć'),
    ...p('ask', 'pytanie', 'pytania', 'pytań'),
  ].join(', ');
}

export const acceptAllText = (count) => `Przyjmij wszystkie propozycje (${count})`;

/** Everything one product card shows, so the DOM code only has to place it. */
export function lineCard(line, ops = [], now = new Date()) {
  const find = (id) => (line.candidates || []).find((c) => c.productId === id);
  const proposals = ops.map(({ index, op }) => {
    if (op.op === 'remove') return { index, kind: 'remove', text: 'usuń', product: null };
    if (op.op === 'setQuantity') return { index, kind: 'setQuantity', text: `ilość ${op.quantity}`, product: null };
    const c = find(op.productId);
    return { index, kind: 'choose', text: c?.name || op.productId, product: c ? mini(c, now) : null };
  });
  const asked = line.question ? line.question.options.map(find).filter(Boolean).map((c) => mini(c, now)) : [];
  const doubtful = line.held || line.confidence !== 'high';
  return {
    lineKey: line.lineKey, term: line.term ?? null, hasOthers: asked.length > 0 || (line.candidates || []).some((c) => c.productId !== line.productId && c.confidence !== 'low'),
    label: lineLabel(line), retailerProductId: line.retailerProductId, name: line.name, priceText: zl(line.lineCostGrosze), priceAge: priceAgeText(line.latestPriceSeenAt, now), categoryPath: line.categoryPath,
    imageUrl: line.imageUrl || null, imageAlt: line.imageAlt || line.name,
    quantity: line.quantity, canDec: line.quantity > 1, canInc: line.quantity < 20,
    suggestion: line.kind === 'suggestion', included: Boolean(line.included), held: Boolean(line.held),
    badge: { text: badgeText(line), level: line.held ? 'low' : line.confidence, reason: doubtful ? confidenceReasonText(line.confidenceReason) : null },
    proposals,
    question: line.question ? { text: line.question.text, options: asked } : null,
    alternatives: line.question ? [] : (line.candidates || []).filter((c) => c.productId !== line.productId && c.confidence !== 'low').slice(0, 3).map((c) => mini(c, now)),
  };
}

const ACTIONS = {
  other: ['Wybierz inny', 'Pozycja zostaje na liście, zmienisz tylko produkt.'],
  search: ['Szukaj innego w Auchan', 'Pozycja zostaje na liście; szukasz innego produktu w Auchan.'],
  byHand: ['Dodam sam na Auchan', 'Pozycja znika z koszyka i trafia na listę do dodania ręcznie.'],
  remove: ['Nie kupuję', 'Pozycja znika z tych zakupów całkiem.'],
};
/** What the user can do with a product that does not fit; each action says what happens to the item. Suggestions only have their own add toggle. */
export function lineActions(card) {
  if (card.suggestion) return [];
  const ids = [...(card.hasOthers ? ['other'] : []), ...(card.term !== null ? ['search', 'byHand'] : []), 'remove'];
  return ids.map((id) => ({ id, label: ACTIONS[id][0], consequence: ACTIONS[id][1] }));
}

/** Keep each card quiet until one action is hovered or focused. */
export function actionHelp(actions, activeId) {
  return actions.find((action) => action.id === activeId)?.consequence || '';
}

/** The last pointer or keyboard event wins; leaving it restores the other active interaction. */
export function actionHelpEvent(state = { hovered: null, focused: null, active: null }, kind, id) {
  const next = { ...state };
  if (kind === 'mouseenter') { next.hovered = id; next.active = id; }
  else if (kind === 'focus') { next.focused = id; next.active = id; }
  else if (kind === 'mouseleave' && next.hovered === id) {
    next.hovered = null;
    if (next.active === id) next.active = next.focused;
  } else if (kind === 'blur' && next.focused === id) {
    next.focused = null;
    if (next.active === id) next.active = next.hovered;
  }
  return next;
}

/** The item's new state in words, shown after an action. */
export function actionNote(id, name) {
  return {
    byHand: `${name} → dodasz sam na Auchan`,
    remove: `${name} — usunięty z zakupów`,
    search: `${name} — zostaje na liście, szukasz innego produktu`,
    other: `${name} — zostaje na liście, wybierz inny produkt`,
  }[id];
}

/** A term Claude could not match: its own card, with the hint when there is one. */
export function unmatchedCard(item) { return { title: `Nie znalazłem: ${item.term}`, hint: item.hint || null }; }

export const MANUAL_HINT = 'Produkty dodane ręcznie na Auchan planer pozna po złożeniu zamówienia.';

/** The product page on Auchan; null when the id is missing or not Auchan's digits-only product id. */
export function auchanProductUrl(retailerProductId) {
  return typeof retailerProductId === 'string' && /^\d{4,14}$/.test(retailerProductId) ? `https://zakupy.auchan.pl/products/${retailerProductId}/details` : null;
}

const MONTHS = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const STALE_DAYS = 30;
/** „cena z 7 sie” for a price seen more than 30 days before now; null when it is recent, unknown or unreadable. */
export function priceAgeText(seenAt, now = new Date()) {
  const at = typeof seenAt === 'string' ? new Date(seenAt) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  if (now.getTime() - at.getTime() <= STALE_DAYS * 86_400_000) return null;
  return `cena z ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

export function auchanSearchUrl(term) { return `https://zakupy.auchan.pl/search?q=${encodeURIComponent(String(term))}`; }

/** What the search status panel says, from the last search event and the service's busy flag; null when there is nothing to show. */
export function searchPanel(event, busy, block = null) {
  if (block && busy !== 'search') return { text: searchBlockText(block), active: false };
  if (busy === 'search') {
    if (!event || event.status === 'done' || event.status === 'stopped') return { text: 'Otwieram przeglądarkę…', active: true };
    if (event.status === 'login') return { text: 'Zaloguj się w oknie przeglądarki…', active: true };
    if (event.status === 'captcha') return { text: 'Rozwiąż weryfikację w oknie przeglądarki (to wymóg Auchan)…', active: true };
    return { text: `Szukam: ${event.term} (${event.index}/${event.total})…`, active: true };
  }
  if (event?.status === 'done') return { text: `Znaleziono produkty dla ${event.found} z ${event.total} haseł.`, active: false };
  if (event?.status === 'stopped' && event.reason) return { text: event.reason, active: false };
  if (event?.status === 'stopped') return { text: `Szukanie zatrzymano: weryfikacja nie została rozwiązana albo Auchan odmówił. Nie ponawiam. Znaleziono produkty dla ${event.found} z ${event.total} haseł.`, active: false };
  return null;
}

/** After Auchan refused a search, searching is held back; this says until when. */
export function searchBlockText(block, timeZone) {
  const when = new Date(block.until).toLocaleString('pl-PL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
  return `Auchan odmówił wyszukiwania (${block.status}). Wyszukiwanie wstrzymane do ${when}.`;
}

/** The "search on Auchan" button: how many terms it covers, or a forced rerun when all were searched in the last 7 days. */
export function searchButton(state, pending = null) {
  const search = state.search;
  if (!search || search.block || stepIndexOf(state.trip) >= FIRST_CART) return null;
  const disabled = Boolean(state.busy) || pending !== null;
  if (search.terms.length > 0) return { label: `Szukaj w Auchan (${search.terms.length})`, force: false, disabled };
  if (search.recent.length > 0) return { label: `Szukaj ponownie (${search.recent.length})`, force: true, disabled };
  return null;
}

function element(tag, className = '', value = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = String(value);
  return node;
}
function iconNode(key) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'category-icon'); svg.setAttribute('aria-hidden', 'true');
  iconPaths(key).forEach((shape) => { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', shape); svg.append(path); });
  return svg;
}
function categoryTag(categoryPath, groupKey = null) {
  const category = categoryFor(categoryPath);
  const tag = element('span', 'category-tag');
  tag.setAttribute('aria-label', category.label);
  const text = categoryLabelText(categoryPath, groupKey);
  return text ? append(tag, iconNode(category.icon), element('span', '', text)) : append(tag, iconNode(category.icon));
}
function append(parent, ...children) { for (const child of children) parent.append(child); return parent; }
function button(label, action, className = 'button', disabled = false) {
  const node = element('button', className, label);
  node.type = 'button'; node.disabled = disabled; node.addEventListener('click', action); return node;
}
function searchLink(term) {
  const link = element('a', 'search-link', `Szukaj „${term}” na Auchan ↗`);
  link.href = auchanSearchUrl(term); link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
  return link;
}
/** A small link to the product's page on Auchan; null without a valid id. It is placed beside a button, never inside one. */
function productLink(retailerProductId) {
  const href = auchanProductUrl(retailerProductId);
  if (!href) return null;
  const link = element('a', 'product-link', 'Zobacz na Auchan ↗');
  link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer';
  return link;
}
/** A price with, when it is old, „· cena z 7 sie” after it. */
function priceNode(text, age) {
  const node = element('span', 'price', text);
  if (age) node.append(element('span', 'price-age', ` · ${age}`));
  return node;
}
function card(title, description = '') {
  const node = element('section', 'card');
  append(node, element('h2', '', title));
  if (description) append(node, element('p', 'subtle', description));
  return node;
}
function stateIllustration(variant, text) {
  const box = element('div', 'state-illustration');
  const token = new URL(location.href).searchParams.get('t') || '';
  const image = element('img'); image.src = `/shopping.svg?t=${encodeURIComponent(token)}#${variant}`; image.alt = ''; image.width = 280; image.height = 180;
  return append(box, image, element('p', 'empty', text));
}
export function badgeText(line) {
  if (line.held) return 'Czeka na Twój wybór';
  return { high: 'Pewne', medium: 'Sprawdź wybór', low: 'Niepewne' }[line.confidence] || 'Sprawdź';
}
export function confidenceReasonText(reason) { return REASONS[reason] || reason || 'dopasowanie niepewne'; }
function thumb(url, alt, className = 'thumb') {
  if (!url) { const blank = element('span', `${className} placeholder`); blank.setAttribute('aria-hidden', 'true'); blank.append(iconNode('cart')); return blank; }
  const img = document.createElement('img');
  img.alt = alt; img.src = url; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.className = className;
  return img;
}

export function start() {
  setupThemeSwitch();
  const token = new URL(location.href).searchParams.get('t') || '';
  const target = document.querySelector('#content');
  const steps = document.querySelector('#steps');
  const alert = document.querySelector('#alert');
  let state = null, selected = 0, rulesOpen = false, report = null, progress = { sent: 0, total: 0 }, logs = [];
  let productSearch = '', searchResults = [], searchDone = false, renderVersion = 0, pending = null, searchEvent = null;
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
  const phoneTrigger = document.querySelector('#phone-trigger');
  const phoneDialog = document.querySelector('#phone-dialog');
  const phoneLink = document.querySelector('#phone-link');
  const phoneQr = document.querySelector('#phone-qr');
  const phoneCopyStatus = document.querySelector('#phone-copy-status');
  let phoneUrl = null;
  if (['127.0.0.1', 'localhost'].includes(location.hostname)) {
    void api(`/api/phone?t=${encodeURIComponent(token)}`).then((result) => {
      if (phoneEntryVisible(location.hostname, result.url)) { phoneUrl = result.url; phoneTrigger.hidden = false; }
    }).catch(() => { /* The handoff is optional when the LAN is unavailable. */ });
  }
  phoneTrigger.addEventListener('click', () => {
    if (!phoneUrl) return;
    phoneLink.href = phoneUrl;
    phoneLink.target = '_blank'; phoneLink.rel = 'noopener noreferrer'; phoneLink.referrerPolicy = 'no-referrer';
    phoneLink.textContent = phoneUrl;
    phoneQr.src = `/phone-qr.svg?t=${encodeURIComponent(token)}`;
    phoneCopyStatus.textContent = '';
    phoneDialog.showModal();
  });
  document.querySelector('#phone-close').addEventListener('click', () => phoneDialog.close());
  phoneDialog.addEventListener('close', () => phoneTrigger.focus());
  document.querySelector('#phone-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(phoneUrl);
      phoneCopyStatus.textContent = 'Link skopiowany.';
    } catch {
      phoneCopyStatus.textContent = 'Nie udało się skopiować. Skopiuj link ręcznie.';
      phoneLink.focus();
    }
  });
  async function run(path, body, failure) {
    try {
      tell('');
      const result = await api(path, body);
      if (result?.trip) state = result;
      else if (result?.step) state.trip = result;
      else if (result?.started === false) tell(result.reason || 'Operacja nie została rozpoczęta.');
      await refresh();
      return result;
    } catch (error) { tell(failure ? failure(error.message) : error.message); return null; }
  }
  async function refresh() {
    try { const first = state === null; state = await api('/api/state'); if (searchEvent === null && state.search?.last) searchEvent = state.search.last; showSearch(); selected = nextSelected(selected, viewModel(state).stepIndex, first); render(); }
    catch (error) { tell(error.message); }
  }

  /** Runs one Claude call at a time; a second click while it is in flight does nothing. A visible panel counts the seconds. */
  const panel = document.querySelector('#working');
  let working = null;
  function showWorking() {
    if (working === null) { panel.hidden = true; return; }
    const view = workingPanel(working.text, Math.floor((Date.now() - working.startedAt) / 1000));
    panel.hidden = false;
    panel.querySelector('.working-text').textContent = view.text;
    panel.querySelector('.working-elapsed').textContent = view.elapsed;
    panel.querySelector('.working-hint').textContent = view.slow || view.hint;
    panel.classList.toggle('slow', view.slow !== null);
  }
  async function withClaude(kind, work) {
    if (pending !== null) return;
    pending = kind; working = { text: START_TEXT[kind], startedAt: Date.now() }; showWorking(); render();
    const timer = setInterval(showWorking, 1000);
    try { await work(); } finally { clearInterval(timer); pending = null; working = null; showWorking(); render(); }
  }
  const searchPanelNode = document.querySelector('#search-status');
  function showSearch() {
    const view = state ? searchPanel(searchEvent, state.busy, state.search?.block ?? null) : null;
    searchPanelNode.hidden = view === null;
    if (view === null) return;
    searchPanelNode.querySelector('.working-text').textContent = view.text;
    searchPanelNode.classList.toggle('finished', !view.active);
  }
  /** The button that searches Auchan for the unmatched and doubtful terms; it only ever runs on a click. */
  function searchButtonNode() {
    const view = searchButton(state, pending);
    if (view === null) return null;
    return button(view.label, async () => { searchEvent = null; await run('/api/search', view.force ? { force: true } : {}); showSearch(); }, 'quiet', view.disabled);
  }
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
    const active = steps.querySelector('.step.active');
    if (active) steps.scrollLeft = active.offsetLeft - steps.offsetLeft - (steps.clientWidth - active.clientWidth) / 2;
    document.querySelector('#progress-line').textContent = progressLine(model.stepIndex);
    document.querySelector('#step-help').textContent = rulesOpen ? 'Zobacz zapamiętane wybory i zablokowane produkty.' : HELP[selected];
  }

  const proposalOp = (index, accept) => run('/api/proposal/op', { proposalId: state.trip.proposal.id, index, accept });
  /** A clickable mini-card (thumbnail, name, price) with the product's Auchan link beside the button, not in it. */
  function option(product, action) {
    const node = element('button', 'option');
    node.type = 'button'; node.addEventListener('click', action);
    const description = append(element('span', 'option-details'), element('span', 'option-name', product.name), categoryTag(product.categoryPath));
    append(node, thumb(product.imageUrl, product.imageAlt, 'thumb small-thumb'), description, priceNode(product.priceText, product.priceAge));
    const wrap = element('div', 'option-item');
    wrap.append(node);
    const link = productLink(product.retailerProductId);
    if (link) wrap.append(link);
    return wrap;
  }
  /** One product of the list with everything needed to decide next to it: the stepper, Claude's proposal, the question or other candidates. */
  function lineCardNode(line, ops, groupKey = null) {
    const view = lineCard(line, ops);
    const node = element('article', `line-card${view.held ? ' waiting' : ''}`);
    node.dataset.lineKey = line.lineKey; node.tabIndex = -1;
    node.append(element('div', 'meta from-list', view.label));
    const info = element('div', 'line-info');
    append(info, element('span', 'line-name', view.name), categoryTag(view.categoryPath, groupKey), priceNode(view.priceText, view.priceAge), element('span', `badge ${view.badge.level}`, view.badge.text));
    const ownLink = productLink(view.retailerProductId);
    if (ownLink) info.append(ownLink);
    if (view.badge.reason) info.append(element('div', 'meta why', `Dlaczego sprawdzić: ${view.badge.reason}`));
    node.append(append(element('div', 'line-main'), thumb(view.imageUrl, view.imageAlt), info));
    if (view.suggestion) node.append(append(element('div', 'actions'), button(view.included ? '✓ W koszyku' : '＋ Dodaj', () => run('/api/line', { lineKey: line.lineKey, included: !view.included }), 'small')));
    else {
      const stepper = element('div', 'stepper');
      stepper.setAttribute('role', 'group'); stepper.setAttribute('aria-label', 'Ilość');
      const minus = button('−', () => run('/api/line', { lineKey: line.lineKey, quantity: view.quantity - 1 }), 'small', !view.canDec); minus.setAttribute('aria-label', 'Mniej');
      const plus = button('+', () => run('/api/line', { lineKey: line.lineKey, quantity: view.quantity + 1 }), 'small', !view.canInc); plus.setAttribute('aria-label', 'Więcej');
      append(stepper, minus, element('span', 'quantity', `${view.quantity} szt.`), plus);
      node.append(stepper);
    }
    view.proposals.forEach((p) => {
      const row = element('div', 'proposal');
      row.append(element('span', 'proposal-title', 'Claude proponuje:'));
      if (p.product) append(row, thumb(p.product.imageUrl, p.product.imageAlt, 'thumb small-thumb'), element('span', 'line-name', p.text), priceNode(p.product.priceText, p.product.priceAge));
      else row.append(element('span', 'line-name', p.text));
      const proposedLink = p.product && productLink(p.product.retailerProductId);
      if (proposedLink) row.append(proposedLink);
      append(row, append(element('div', 'actions'), button('Weź to', () => proposalOp(p.index, true), 'small'), button('Zostaw obecny', () => proposalOp(p.index, false), 'small quiet')));
      node.append(row);
    });
    if (view.question) {
      const ask = element('div', 'ask');
      ask.append(element('p', 'question', view.question.text));
      const options = element('div', 'options');
      view.question.options.forEach((o) => options.append(option(o, () => run('/api/answer', { lineKey: line.lineKey, productId: o.productId }))));
      append(ask, options);
      node.append(ask);
    } else if (view.alternatives.length) {
      const others = element('div', 'others');
      others.hidden = true;
      others.id = `alternatives-${++nextActionHelpId}`;
      others.append(element('div', 'meta', 'Inne pasujące:'));
      const options = element('div', 'options');
      view.alternatives.forEach((o) => options.append(option(o, () => run('/api/line', { lineKey: line.lineKey, productId: o.productId }))));
      node.append(append(others, options));
    }
    node.append(actionsNode(line, view));
    const reveal = node.querySelector('[data-show-alternatives]');
    const others = node.querySelector('.others'); // absent when the line asks a question or has no other candidates
    if (reveal && others) reveal.setAttribute('aria-controls', others.id);
    return node;
  }
  function appendGroupedProducts(parent, lines, heading = 'h3') {
    groupByCategory(lines).forEach(({ category, items }) => {
      const section = element('section', 'category-group');
      const title = append(element(heading, 'category-heading'), iconNode(category.icon), element('span', '', category.label), element('span', 'category-count', String(items.length)));
      section.append(title);
      items.forEach((line) => section.append(lineCardNode(line, opsFor(line), category.key)));
      parent.append(section);
    });
  }
  let nextActionHelpId = 0;
  /** The explicit actions of a card, with one line under the buttons for the hovered or focused action. */
  function actionsNode(line, view) {
    const box = element('div', 'item-actions');
    const actions = lineActions(view);
    if (!actions.length) return box;
    const name = line.term || line.name;
    const consequence = element('p', 'meta consequence', '');
    consequence.id = `action-help-${++nextActionHelpId}`;
    consequence.hidden = true;
    let helpState;
    const showHelp = () => {
      consequence.textContent = actionHelp(actions, helpState?.active);
      consequence.hidden = !consequence.textContent;
    };
    const handleHelp = (kind, id) => { helpState = actionHelpEvent(helpState, kind, id); showHelp(); };
    const handlers = {
      other: () => {
        const card = box.parentElement;
        const others = card?.querySelector('.others');
        if (others) { others.hidden = false; box.querySelector('[data-show-alternatives]')?.setAttribute('aria-expanded', 'true'); }
        const first = card?.querySelector('.others .option, .ask .option'); // a line with a question offers its candidates there
        if (first) { first.scrollIntoView({ block: 'nearest' }); first.focus(); }
      },
      search: () => { if (state.search?.block) window.open(auchanSearchUrl(line.term), '_blank', 'noopener,noreferrer'); else { searchEvent = null; void run('/api/search', { terms: [line.term] }).then(showSearch); } },
      byHand: async () => { if (await run('/api/line/by-hand', { lineKey: line.lineKey })) tell(actionNote('byHand', name)); },
      remove: async () => { const r = line.question ? await run('/api/answer', { lineKey: line.lineKey, productId: null }) : await run('/api/line', { lineKey: line.lineKey, remove: true }); if (r) tell(actionNote('remove', name)); },
    };
    const row = element('div', 'actions');
    actions.forEach((a) => {
      const b = button(a.label, () => { void handlers[a.id](); }, a.id === 'remove' ? 'small danger' : 'small quiet', a.id === 'search' && Boolean(state.busy));
      b.title = a.consequence;
      if (a.id === 'other') { b.dataset.showAlternatives = ''; b.setAttribute('aria-expanded', 'false'); }
      b.setAttribute('aria-describedby', consequence.id);
      b.addEventListener('focus', () => handleHelp('focus', a.id));
      b.addEventListener('blur', () => handleHelp('blur', a.id));
      b.addEventListener('mouseenter', () => handleHelp('mouseenter', a.id));
      b.addEventListener('mouseleave', () => handleHelp('mouseleave', a.id));
      row.append(b);
    });
    return append(box, row, consequence);
  }
  const opsFor = (line) => proposalView(state.trip).byLine[line.lineKey] || [];
  const ownTerms = new Set();
  function unmatchedNode(item) {
    const view = unmatchedCard(item);
    const node = element('article', 'line-card unmatched');
    node.append(element('div', 'line-name', view.title));
    if (view.hint) node.append(element('p', 'meta', view.hint));
    const mine = ownTerms.has(item.term);
    append(node, append(element('div', 'actions'),
      button(mine ? '✓ Dodam sam na Auchan' : 'Dodam sam na Auchan', () => { ownTerms.add(item.term); render(); }, 'small', mine),
      button('Usuń', () => run('/api/unmatched/remove', { term: item.term }), 'small danger')));
    append(node, searchLink(item.term), element('p', 'meta', MANUAL_HINT));
    return node;
  }

  function renderData() {
    const box = card('1. Dane', 'Aktualna historia zakupów pomaga dobrać produkty i sprawdzić ceny.');
    append(box, element('p', '', viewModel(state).freshnessText), button('↻ Odśwież dane', () => run('/api/sync', {})), button('Dalej: lista →', () => { selected = 1; render(); }, 'quiet'));
    if (state.busy === 'sync') box.append(element('p', 'meta', 'Trwa synchronizacja. Jeśli otworzy się okno Auchan, zaloguj się i pozostaw je otwarte.'));
    target.append(box);
    if (logs.length) target.append(renderLogs());
  }
  function renderList() {
    const form = card('2. Lista', 'Wklej listę. Możesz dopisać ilość na końcu każdego wiersza.');
    const notice = listNotice(state.trip.lines.length);
    if (notice) append(form, append(element('p', 'message', notice.text), button(notice.link, () => { selected = 2; render(); }, 'link-button')));
    const note = element('textarea'); note.value = draftForm.note ?? state.trip.note ?? ''; note.placeholder = 'mleko 2\nchleb\nmąka pszenna 1'; note.setAttribute('aria-label', 'Lista zakupów'); note.addEventListener('input', () => { draftForm.note = note.value; });
    const usual = element('input'); usual.type = 'checkbox'; usual.id = 'usual'; usual.checked = draftForm.usual; usual.addEventListener('change', () => { draftForm.usual = usual.checked; });
    const usualLabel = element('label', 'check'); append(usualLabel, usual, element('span', '', 'Dodaj to, co zwykle kupuję'));
    const budget = element('input'); budget.type = 'text'; budget.inputMode = 'decimal'; budget.placeholder = 'Opcjonalnie'; budget.id = 'budget'; budget.value = draftForm.budget; budget.addEventListener('input', () => { draftForm.budget = budget.value; });
    const budgetLabel = element('label', '', 'Budżet w zł'); budgetLabel.htmlFor = 'budget';
    append(form, note, usualLabel, budgetLabel, budget,
      button('Ułóż szkic →', async () => { const parsed = parseBudget(budget.value); if (!parsed.ok) { tell(parsed.error); return; } const body = { note: note.value, includeUsual: usual.checked }; if (parsed.grosze !== undefined) body.budgetGrosze = parsed.grosze; await withClaude('note', async () => { const result = await run('/api/note', body, (m) => failureText('note', m)); if (result) { selected = afterNote(viewModel(state).stepIndex); render(); tell(doneSummary(viewModel(state))); } }); }, 'button', state.busy === 'fill' || state.busy === 'search' || claudeStatus(pending).disableNote));
    target.append(form);
  }
  function renderReviewStep() {
    const results = card('3. Przegląd', 'Sprawdź nazwę, ilość i ocenę dopasowania.');
    const model = viewModel(state);
    const blockedNotice = state.trip.messages?.find((m) => m.startsWith('Pominięto zablokowane produkty:'));
    if (blockedNotice) results.append(append(element('p', 'message blocked'), iconNode('warning'), element('span', '', blockedNotice)));
    if (!model.lines.length) results.append(stateIllustration('empty', 'Produkty pojawią się tu po ułożeniu szkicu.'));
    appendGroupedProducts(results, model.lines);
    if (model.suggestions.length) {
      results.append(element('h3', '', 'Propozycje · dodawane tylko po Twoim kliknięciu'));
      appendGroupedProducts(results, model.suggestions, 'h4');
    }
    if (model.unmatched.length) {
      results.append(element('h3', '', 'Nie znaleziono w katalogu'));
      const find = searchButtonNode(); if (find) results.append(find);
      model.unmatched.forEach((item) => results.append(unmatchedNode(item)));
    }
    if (model.lines.length) results.append(element('div', 'total row', `Szacowana kwota: ${zl(model.total)}`));
    target.append(results);
    if (state.trip.lines.length) { const next = reviewNext(model); target.append(button(next === 4 ? 'Dalej: zatwierdzenie →' : 'Dalej: doprecyzowanie →', () => { selected = next; render(); }, 'quiet')); }
  }
  function renderQuestions() {
    const model = viewModel(state);
    const info = describeQuestions(model);
    const box = card('4. Doprecyzowanie', 'Wybierz produkt tam, gdzie dopasowanie wymaga Twojej decyzji.');
    if (info.intro) box.append(element('p', 'message', info.intro));
    if (info.empty) box.append(stateIllustration('empty', info.empty));
    target.append(box);
    const view = proposalView(state.trip);
    state.trip.lines.filter((l) => ((l.included || l.held) && l.question) || view.byLine[l.lineKey]).forEach((l) => target.append(lineCardNode(l, opsFor(l))));
    const find = model.unmatched.length || state.search?.terms?.length || state.search?.recent?.length ? searchButtonNode() : null;
    if (find) target.append(find);
    model.unmatched.forEach((item) => target.append(unmatchedNode(item)));
    target.append(button('Dalej: zatwierdzenie →', () => { selected = 4; render(); }, 'quiet', !info.canContinue));
  }
  function renderApprovalStep() {
    const model = viewModel(state);
    const box = card('5. Zatwierdzenie', 'Ostatnia kontrola przed dodaniem produktów do koszyka Auchan.');
    const included = state.trip.lines.filter((l) => l.included);
    appendGroupedProducts(box, included);
    if (!included.length) box.append(stateIllustration('empty', 'Lista jest pusta. Wróć do listy.'));
    if (model.unmatched.length) append(box, element('h3', '', 'Do dodania ręcznie w Auchan'), ...model.unmatched.flatMap((u) => [element('p', 'meta', unmatchedText(u)), searchLink(u.term)]), element('p', 'meta', MANUAL_HINT));
    append(box, element('div', 'total', `Szacowana kwota: ${zl(model.total)}`), ...(model.staleNote ? [element('p', 'meta stale-note', model.staleNote)] : []), model.inCart ? element('p', 'meta', 'Te zakupy są już w koszyku. Zacznij nowe zakupy, żeby dodać coś jeszcze.') : button('✓ Zatwierdź i dodaj do koszyka', async () => { const result = await run('/api/approve', {}); if (result?.started) { selected = 5; render(); } }, 'button', !model.canApprove));
    if (!model.canApprove && !model.inCart && model.approveHint) box.append(element('p', 'meta', model.approveHint));
    target.append(box);
  }
  function renderLogs() { const box = card('Dziennik'); logs.slice(-20).forEach((l) => box.append(element('p', 'message', l))); return box; }
  function renderCart() {
    const box = card('6. Koszyk', 'Produkty są dodawane partiami. Możesz obserwować postęp.');
    const bar = element('progress'); bar.max = Math.max(progress.total, 1); bar.value = progress.sent; bar.setAttribute('aria-label', 'Postęp dodawania produktów do koszyka');
    append(box, bar, element('p', 'meta', `${progress.sent} z ${progress.total} produktów`)); target.append(box);
    if (logs.length) target.append(renderLogs());
  }
  function renderPayment() {
    const box = card('7. Płatność', 'Sprawdź raport, potem przejdź do Auchan. Aplikacja nie składa zamówienia ani nie płaci.');
    box.append(stateIllustration('success', 'Zakupy są gotowe do sprawdzenia w Auchan.'));
    const reportText = report?.text || state.trip.reportText;
    const structured = report?.structured || state.trip.reportData;
    if (structured || reportText) {
      const view = reportView(reportText, state.trip.lines, structured);
      view.sections.forEach((section) => {
        const group = element('section', `report-group report-${section.key}`);
        const heading = append(element('h3', 'report-heading'), iconNode(section.key), element('span', '', section.title), element('span', 'report-count', String(section.items.length)));
        group.append(heading);
        const renderItems = (parent, items) => {
          const list = element('ul', 'report-list');
          items.forEach((item) => {
            const row = element('li', 'report-item');
            append(row, categoryTag(item.categoryPath), element('span', 'report-name', item.title));
            const itemLink = productLink(item.retailerProductId);
            if (itemLink) row.append(itemLink);
            const facts = element('div', 'report-facts');
            if (item.quantity !== undefined) facts.append(element('span', 'report-quantity', `× ${String(item.quantity).replace('.', ',')}`));
            const price = reportPriceText(item);
            if (price) facts.append(element('span', 'report-price', price));
            if (facts.childNodes.length) row.append(facts);
            if (item.detail) row.append(element('span', 'report-detail', item.detail));
            list.append(row);
          });
          parent.append(list);
        };
        if (section.key === 'info' && section.items.length > 6) {
          groupByCategory(section.items).forEach(({ category, items }) => {
            const sub = element('div', 'report-category');
            sub.append(append(element('h4', 'report-category-heading'), iconNode(category.icon), element('span', '', category.label), element('span', 'category-count', String(items.length))));
            renderItems(sub, items);
            group.append(sub);
          });
        } else renderItems(group, section.items);
        box.append(group);
      });
      const summary = view.summary.filter((line) => !line.startsWith('Zapłać na '));
      if (summary.length) box.append(append(element('div', 'report-summary'), ...summary.map((line) => element('p', '', line))));
    }
    else box.append(element('p', 'empty', 'Raport jest dostępny po zakończeniu dodawania produktów. Po odświeżeniu strony sprawdź koszyk bezpośrednio w Auchan.'));
    if (state.trip.unmatched.length) append(box, element('h3', '', 'Do dodania ręcznie w Auchan'), ...state.trip.unmatched.flatMap((u) => [element('p', 'meta', unmatchedText(u)), searchLink(u.term)]), element('p', 'meta', MANUAL_HINT));
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
        append(row, append(element('span', 'blocked-product-name'), iconNode('warning'), element('span', 'line-name', item.name)), button('Odblokuj', async () => {
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
  /** Scrolls to a product card, focuses it for keyboard users and flashes it briefly. */
  function showLine(lineKey) {
    const node = [...document.querySelectorAll('.line-card')].find((n) => n.dataset.lineKey === lineKey);
    if (!node) return;
    node.scrollIntoView({ block: 'center' });
    node.focus({ preventScroll: true });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1600);
  }
  /** Claude's pending changes: one button for all of them, and the ones that belong to no line. The rest sit on the product cards. */
  function renderProposal() {
    const proposal = state.trip.proposal;
    if (!proposal || ![2, 3].includes(selected)) return;
    const view = proposalView(state.trip);
    const box = card('Claude proponuje zmiany', 'Przy produktach widać każdą zmianę osobno — możesz ją wziąć albo zostawić obecny wybór.');
    const note = proposalNote(state.trip);
    if (note) {
      const p = element('p', 'proposal-note', `${note.intro} `);
      note.items.forEach((item, i) => {
        p.append(button(`${item.name} (${item.what})`, () => showLine(item.lineKey), 'link-button'), i < note.items.length - 1 ? ', ' : '.');
      });
      box.append(p);
    }
    view.loose.forEach(({ index, op, text }) => {
      const row = element('div', 'proposal');
      const labels = proposalButtons(op);
      append(row, element('span', 'line-name', text), append(element('div', 'actions'), button(labels.accept, () => proposalOp(index, true), 'small'), button(labels.skip, () => proposalOp(index, false), 'small quiet')));
      box.append(row);
    });
    if (proposal.dropped) box.append(element('p', 'meta', `Pominięto ${proposal.dropped} nieprawidłowych zmian.`));
    const summary = acceptAllSummary(proposal.ops || []);
    if (summary) box.append(element('p', 'meta', `W tym: ${summary}.`));
    append(box, button(acceptAllText(view.count), () => run('/api/apply', { proposalId: proposal.id })), button('Odrzuć wszystkie', () => run('/api/reject', { proposalId: proposal.id }), 'quiet'));
    target.append(box);
  }
  function renderAsk() {
    if (![2, 3].includes(selected) || !state.trip.lines.length) return;
    const box = card('Powiedz, co zmienić', 'Możesz opisać zmianę własnymi słowami. Zobaczysz propozycję przed zastosowaniem.');
    const input = element('textarea', 'short-textarea'); input.setAttribute('aria-label', 'Polecenie dla Claude'); input.placeholder = 'Na przykład: wybierz większe opakowanie sera';
    input.value = draftForm.ask; input.addEventListener('input', () => { draftForm.ask = input.value; });
    append(box, input, button('Zaproponuj zmianę', () => withClaude('ask', async () => { const result = await run('/api/ask', { text: input.value }, (m) => failureText('ask', m)); if (result) { draftForm.ask = ''; tell(doneSummary(viewModel(state))); } }), 'quiet', state.busy === 'fill' || state.busy === 'search' || claudeStatus(pending).disableAsk));
    target.append(box);
  }
  function render() {
    if (!state) return;
    const version = ++renderVersion;
    const model = viewModel(state);
    document.querySelector('#mode').textContent = state.trip.mode === 'fallback' ? 'Tryb bez Claude' : 'Z pomocą Claude';
    document.querySelector('#hero-art').src = `/shopping.svg?t=${encodeURIComponent(token)}#step-${rulesOpen ? 0 : selected}`;
    document.querySelector('#new-trip').disabled = state.busy === 'fill' || state.busy === 'search' || state.trip.step === 'koszyk';
    showSearch(); renderSteps(model); target.replaceChildren();
    if (rulesOpen) { void renderRules(version); return; }
    renderProposal();
    [renderData, renderList, renderReviewStep, renderQuestions, renderApprovalStep, renderCart, renderPayment][selected]();
    renderAsk();
    const messages = (state.trip.messages || []).filter((m) => selected !== 2 || !m.startsWith('Pominięto zablokowane produkty:')).slice(-4);
    if (messages.length) {
      const box = card('Wskazówki'); messages.forEach((m) => box.append(element('p', 'message', m))); target.append(box);
    }
  }
  document.querySelector('#new-trip').addEventListener('click', async () => { if (state.busy === 'fill' || state.busy === 'search') return; const result = await run('/api/trip/reset', {}); if (result?.step === 'dane') { selected = 0; rulesOpen = false; report = null; logs = []; searchEvent = null; draftForm.note = null; draftForm.usual = false; draftForm.budget = ''; draftForm.ask = ''; render(); } });
  const events = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
  events.addEventListener('state', () => { void refresh(); });
  events.addEventListener('working', (event) => { if (working !== null) { working.text = JSON.parse(event.data).text; showWorking(); } });
  events.addEventListener('progress', (event) => { progress = JSON.parse(event.data); if (selected === 5) render(); });
  events.addEventListener('log', (event) => { logs.push(JSON.parse(event.data).text); if (selected === 5 || selected === 0) render(); });
  events.addEventListener('report', (event) => { report = JSON.parse(event.data).report; selected = 6; render(); });
  events.addEventListener('search', (event) => { searchEvent = JSON.parse(event.data); showSearch(); if (searchEvent.status === 'done' || searchEvent.status === 'stopped') void refresh(); });
  events.addEventListener('done', () => { void refresh(); });
  void refresh();
}

if (typeof document !== 'undefined') start();
