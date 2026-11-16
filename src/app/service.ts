import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { buildDraft } from '../draft.ts';
import type { Draft } from '../draft.ts';
import { syncAll } from '../cli.ts';
import type { Deps } from '../cli.ts';
import { BUSY, formatReport, runFill } from '../fill-cli.ts';
import { Blocked, LoginRequired, ProfileBusy, RateLimited, Refused } from '../worker.ts';
import type { FillDeps } from '../fill-cli.ts';
import { acquireLock, lockHeld, releaseLock } from '../lock.ts';
import { LOCK_PATH } from '../dbpath.ts';
import { zl } from '../money.ts';
import { cleanText, parseSearchState } from '../parse.ts';
import { createBrowserSearch, MAX_SEARCH_TERMS, PROFILE_BUSY_TEXT, searchBlockText } from '../search-browser.ts';
import type { BrowserSearchOptions, PageLike, SearchResult } from '../search-browser.ts';
import { normaliseTerm } from '../store.ts';
import type { IntentRule, Store } from '../store.ts';
import { failureText as describeError, syncMessages } from './messages.ts';
import { askClaude } from './claude.ts';
import type { Spawn } from './claude.ts';
import { parseNote } from './fallback.ts';
import type { Op } from './ops.ts';
import {
  answer as answerLine, applyOps, approvedLines, chooseProduct, dropUnmatched, emptyTrip, ListProblem, loadTrip, moveToUnmatched, needsQuestion, openQuestions, questionOptions, saveTrip, setIncluded, tripFromDraft,
} from './trip.ts';
import type { Correction, Trip, TripLine } from './trip.ts';

export type AppEvent =
  | { type: 'log'; text: string }
  | { type: 'progress'; sent: number; total: number }
  | { type: 'report'; report: unknown }
  | { type: 'state' }
  | { type: 'working'; stage: 'parse' | 'draft' | 'choose' | 'done'; text: string }
  | { type: 'search'; status: 'login' | 'captcha' | 'searching' | 'done' | 'stopped'; term?: string; index?: number; total?: number; found?: number; reason?: string }
  | { type: 'done'; code: number };

export interface ServiceDeps {
  openStore(): Store;
  spawn: Spawn;
  fillDeps: FillDeps;
  syncDeps: Deps;
  tripFile: string;
  now(): Date;
  emit(e: AppEvent): void;
  /** The visible browser window the Auchan search runs in. */
  openSearchPage(): Promise<PageLike>;
  /** Pace and waits of the search; tests shorten them. */
  searchTuning?: Partial<Pick<BrowserSearchOptions, 'paceMs' | 'captchaWaitMs' | 'loginWaitMs' | 'pollMs' | 'sleep' | 'now'>>;
}

export type Busy = 'sync' | 'fill' | 'search' | null;
type SearchEvent = Extract<AppEvent, { type: 'search' }>;
type Start = { started: boolean; reason?: string };

const FALLBACK_MESSAGE = 'Tryb bez Claude: pytam o każdą niepewną pozycję.';
const INTERRUPTED = 'Wypełnianie przerwane — uruchom ponownie; doda tylko brakujące.';
const MAX_MESSAGES = 200;
const MAX_MESSAGE = 2000;

const ALREADY_IN_CART = 'Te zakupy są już w koszyku. Zacznij nowe zakupy, żeby dodać coś jeszcze.';
const FROZEN = 'Trwa dodawanie do koszyka — poczekaj na koniec.';
const FROZEN_PAID = 'Te zakupy są już w koszyku. Kliknij „Nowe zakupy”, żeby zacząć od nowa.';
export const BLOCKED_REASON = 'Auchan odrzucił zapytanie. Nie zatwierdzaj ponownie — sprawdź koszyk na Auchan i zacznij nowe zakupy.';
const SEARCH_FROZEN = 'Trwa szukanie w Auchan — poczekaj na koniec.';
const SEARCH_STOPPED = 'Szukanie w Auchan zatrzymano (weryfikacja nie została rozwiązana lub Auchan odmówił). Nie ponawiam.';
const LOGIN_PROMPT = 'Zaloguj się w oknie przeglądarki i zostaw je otwarte — dodawanie ruszy samo.';

/** The fill's failure in Polish for the kinds the user meets; anything else keeps the CLI's text. */
function failureText(err: unknown): string | null {
  if (err instanceof Refused) return `Auchan odrzucił zmianę koszyka (${cleanText(err.productName)}). Część produktów mogła już trafić do koszyka — sprawdź koszyk, usuń ten produkt z listy i spróbuj ponownie.`;
  if (err instanceof RateLimited) {
    const wait = err.retrySeconds === undefined ? 'później' : `za ${Math.max(1, Math.ceil(err.retrySeconds / 60))} min`;
    return `Auchan prosi o zwolnienie tempa, więc dodawanie zatrzymano. Spróbuj ponownie ${wait}.`;
  }
  if (err instanceof Blocked) return BLOCKED_REASON;
  if (err instanceof LoginRequired) return 'Auchan nadal nie widzi logowania: zaloguj się w oknie przeglądarki i spróbuj ponownie.';
  return null;
}

const refuse = (reason: string): Start => ({ started: false, reason });
const dropped = (n: number) => `pominięto ${n} nieprawidłowych zmian`;

export function createService(d: ServiceDeps) {
  let trip: Trip = loadTrip(d.tripFile) ?? emptyTrip(d.now());
  let busy: Busy = null;
  let generation = 0;
  let stopped = false;
  let active: { markFailed(): void; release(): void } | null = null;
  let activeSearch: { close(): Promise<void>; release(): void } | null = null;
  let lastSearch: SearchEvent | null = null;

  /** Emits from background work: a failing listener must never become an unhandled rejection. */
  const safeEmit = (e: AppEvent) => {
    try {
      d.emit(e);
    } catch (err) {
      console.error(`Błąd zdarzenia: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const withStore = <T>(f: (s: Store) => T): T => {
    const s = d.openStore();
    try {
      return f(s);
    } finally {
      s.close();
    }
  };

  function editBlacklist(change: (store: Store) => void): boolean {
    if (busy !== null) return false;
    const lockFile = d.fillDeps.lockFile ?? LOCK_PATH;
    const token = acquireLock(lockFile);
    if (!token) return false;
    try {
      withStore(change);
      invalidateDraft();
      return true;
    } finally {
      releaseLock(lockFile, token);
    }
  }

  /** Stores a new trip: trims messages, stamps, saves and announces it. */
  function commit(next: Trip): Trip {
    trip = {
      ...next,
      messages: next.messages.slice(-MAX_MESSAGES).map((m) => m.slice(0, MAX_MESSAGE)),
      updatedAt: d.now().toISOString(),
    };
    saveTrip(d.tripFile, trip);
    d.emit({ type: 'state' });
    return trip;
  }

  /** After a change to questions or the proposal, the wizard stands at the right step again. */
  function settle(t: Trip): Trip {
    if (t.step !== 'szkic' && t.step !== 'doprecyzowanie' && t.step !== 'zatwierdzenie') return t;
    return { ...t, step: openQuestions(t).length > 0 || t.proposal !== null ? 'doprecyzowanie' : 'zatwierdzenie' };
  }

  const frozen = () => busy === 'fill' || busy === 'search' || trip.step === 'koszyk' || trip.step === 'platnosc';
  /** While the cart is being filled the trip stays as it is; the page is told why. */
  function hold(): Trip {
    const text = trip.step === 'platnosc' ? FROZEN_PAID : busy === 'search' ? SEARCH_FROZEN : FROZEN;
    if (trip.messages.at(-1) !== text) commit({ ...trip, messages: [...trip.messages, text] });
    return trip;
  }

  if (trip.step === 'koszyk') commit({ ...trip, step: 'zatwierdzenie', messages: [...trip.messages, INTERRUPTED] });

  const draftTerms = (store: Store, items: { term: string; quantity: number }[], includeUsual: boolean, budgetGrosze?: number): Draft =>
    buildDraft({ items, includeUsual, budgetGrosze, searched: store.searchResults() }, store.productFacts(), store.intentRules(), d.now(), store.blockedProducts());

  const noteMap = (items: { term: string; note: string }[]): Record<string, string> =>
    Object.fromEntries(items.flatMap((i) => (i.note === '' ? [] : [[i.term, i.note], [normaliseTerm(i.term), i.note]])));

  const isAskOrSay = (o: Op) => o.op === 'ask' || o.op === 'say';

  /** Whether an operation would change the trip; Claude often proposes what the line already has. */
  function changesTrip(t: Trip, o: Op): boolean {
    const line = 'lineKey' in o ? t.lines.find((l) => l.lineKey === o.lineKey) : undefined;
    switch (o.op) {
      case 'choose': return line !== undefined && line.productId !== o.productId;
      case 'setQuantity': return line !== undefined && line.quantity !== o.quantity;
      case 'remove': return line !== undefined;
      case 'add': return !t.lines.some((l) => l.term !== null && normaliseTerm(l.term) === normaliseTerm(o.term));
      case 'unmatched': return !t.unmatched.some((u) => normaliseTerm(u.term) === normaliseTerm(o.term));
      default: return true;
    }
  }

  /** Asking and saying change nothing; everything else that changes something waits as a proposal. */
  function holdProposal(t: Trip, ops: Op[], drop: number, quiet = true): Trip {
    // A question about a line that is confident and carries no note from the user only gets in the way.
    const confident = (o: Op) => quiet && o.op === 'ask' && t.lines.some((l) => l.lineKey === o.lineKey && l.confidence === 'high' && l.note.trim() === '');
    ops = ops.filter((o) => !confident(o));
    const now = applyOps(t, ops.filter(isAskOrSay)).trip;
    const rest = ops.filter((o) => !isAskOrSay(o) && changesTrip(now, o));
    const messages = drop > 0 ? [...now.messages, dropped(drop)] : now.messages;
    const proposal = rest.length > 0 ? { id: randomUUID(), ops: rest, dropped: drop, source: 'claude' as const } : now.proposal;
    return { ...now, messages, proposal };
  }

  function askEveryDoubtfulLine(t: Trip): Trip {
    const lines = t.lines.map((l): TripLine => {
      if (!l.included || l.question !== null || !needsQuestion(l)) return l;
      return { ...l, question: { text: `Który produkt wybrać dla „${l.term ?? l.name}”?`, options: questionOptions(l) } };
    });
    return { ...t, lines };
  }

  const record = (corrections: Correction[]) => {
    if (corrections.length) withStore((s) => corrections.forEach((c) => s.recordCorrection(c)));
  };

  function invalidateDraft(): void {
    generation++;
    if (['szkic', 'doprecyzowanie', 'zatwierdzenie'].includes(trip.step)) {
      commit({ ...emptyTrip(d.now()), note: trip.note, step: 'szkic', ...(trip.blocked ? { blocked: true } : {}), messages: ['Lista blokowanych produktów zmieniła się. Ułóż szkic ponownie.'] });
    } else safeEmit({ type: 'state' });
  }

  /** Applies operations of the pending proposal: corrections are recorded, added terms are drafted; `left` stays pending. */
  function takeOps(ops: Op[], left: Trip['proposal']): Trip {
    const r = applyOps({ ...trip, proposal: left }, ops);
    record(r.corrections);
    let next = r.trip;
    if (r.addTerms.length > 0) {
      const draft = withStore((s) => draftTerms(s, r.addTerms, false));
      next = tripFromDraft(next, draft, noteMap(r.addTerms));
      if (draft.blocked?.length) next = { ...next, messages: [...next.messages, `Pominięto zablokowane produkty: ${draft.blocked.join(', ')}.`] };
    }
    return commit(settle(next));
  }


  /** Terms the user could look up on Auchan: unmatched ones and list lines with no sure pick. Split by whether they were searched in the last 7 days. */
  function searchPlan(): { terms: string[]; recent: string[] } {
    const seen = new Set<string>();
    const wanted: string[] = [];
    const add = (term: string | null) => {
      if (term === null || term.trim() === '' || seen.has(normaliseTerm(term))) return;
      seen.add(normaliseTerm(term));
      wanted.push(term);
    };
    trip.unmatched.forEach((u) => add(u.term));
    trip.lines.forEach((l) => { if (l.kind === 'item' && (l.held || l.confidence === 'low' || l.candidates.length === 0)) add(l.term); });
    const recent = withStore((s) => wanted.filter((t) => s.searchedRecently(t, d.now())));
    return { terms: wanted.filter((t) => !recent.includes(t)).slice(0, MAX_SEARCH_TERMS), recent };
  }

  /** Drafts only the searched terms again: their old lines are replaced, every other line stays as the user left it. */
  function redraft(t: Trip, terms: string[]): { trip: Trip; fresh: TripLine[] } {
    const keys = new Set(terms.map(normaliseTerm));
    const old = t.lines.filter((l) => l.kind === 'item' && l.term !== null && keys.has(normaliseTerm(l.term)));
    const items = terms.map((term) => {
      const was = old.find((l) => normaliseTerm(l.term!) === normaliseTerm(term));
      const asked = t.unmatched.find((u) => normaliseTerm(u.term) === normaliseTerm(term));
      return { term, quantity: was?.quantity ?? asked?.quantity ?? 1, note: was?.note ?? asked?.note ?? '' };
    });
    const draft = withStore((s) => draftTerms(s, items, false));
    const base = { ...t, lines: t.lines.filter((l) => !old.includes(l)) };
    const next = tripFromDraft(base, { ...draft, stockUps: [], promotions: [], addOns: [] }, noteMap(items));
    return { trip: next, fresh: next.lines.filter((l) => !base.lines.includes(l)) };
  }

  const view = {
    state() {
      const { ordersAt, promotionsAt } = withStore((s) => ({ ordersAt: s.lastSyncFinishedAt('orders'), promotionsAt: s.lastSyncFinishedAt('promotions') }));
      const oldest = ordersAt !== null && promotionsAt !== null ? (ordersAt < promotionsAt ? ordersAt : promotionsAt) : null;
      const ageHours = oldest === null ? null : Math.max(0, Math.round(((d.now().getTime() - new Date(oldest).getTime()) / 3600_000) * 10) / 10);
      const block = withStore((s) => s.searchBlock(d.now()));
      return { trip, freshness: { ordersAt, promotionsAt, ageHours }, busy, search: { ...searchPlan(), last: lastSearch, block } };
    },

    async note(input: { note: string; includeUsual: boolean; budgetGrosze?: number }): Promise<Trip> {
      if (frozen()) return hold();
      const mine = ++generation;
      const stale = () => frozen() || mine !== generation;
      let t: Trip = { ...emptyTrip(d.now()), note: input.note, ...(trip.blocked ? { blocked: true } : {}) };
      d.emit({ type: 'working', stage: 'parse', text: 'Czytam listę (1/3)…' });
      const parsed = await askClaude(d.spawn, 'parse', t, input.note);
      if (stale()) return frozen() ? hold() : trip;
      const mode: Trip['mode'] = parsed === null ? 'fallback' : 'claude';
      d.emit({ type: 'working', stage: 'draft', text: 'Dobieram produkty z historii i promocji (2/3)…' });
      const items = parsed === null
        ? parseNote(input.note)
        : parsed.ops.flatMap((o) => (o.op === 'add' ? [{ term: o.term, quantity: o.quantity, note: o.note ?? '' }] : []));
      t = { ...t, mode, messages: mode === 'fallback' ? [FALLBACK_MESSAGE] : [] };
      const draft = withStore((s) => draftTerms(s, items, input.includeUsual, input.budgetGrosze));
      t = tripFromDraft(t, draft, noteMap(items), items);
      if (draft.blocked?.length) t = { ...t, messages: [...t.messages, `Pominięto zablokowane produkty: ${draft.blocked.join(', ')}.`] };
      let drop = 0;
      if (parsed !== null) {
        drop += parsed.dropped;
        const matched = new Set(t.lines.flatMap((l) => (l.term === null ? [] : [normaliseTerm(l.term)])));
        const blocked = new Set((draft.blocked ?? []).map(normaliseTerm));
        const extra = parsed.ops.filter((o) => o.op === 'add' || o.op === 'say' || (o.op === 'unmatched' && !matched.has(normaliseTerm(o.term)) && !blocked.has(normaliseTerm(o.term))));
        t = applyOps(t, extra).trip;
      }
      if (draft.overBudgetGrosze !== null) t = { ...t, messages: [...t.messages, `Przekroczono budżet o ${zl(draft.overBudgetGrosze)}.`] };
      if (t.lines.length === 0 && t.unmatched.length === 0 && !draft.blocked?.length) t = { ...t, messages: [...t.messages, 'Nie rozpoznano żadnych pozycji.'] };

      if (mode === 'claude' && t.lines.length > 0) {
        d.emit({ type: 'working', stage: 'choose', text: 'Claude sprawdza dopasowania (3/3)…' });
        const chosen = await askClaude(d.spawn, 'choose', t, input.note);
        if (stale()) return frozen() ? hold() : trip;
        if (chosen === null) {
          t = { ...t, mode: 'fallback', messages: [...t.messages, FALLBACK_MESSAGE] };
        } else {
          t = holdProposal(t, chosen.ops, drop + chosen.dropped);
          drop = 0;
        }
      }
      if (drop > 0) t = { ...t, messages: [...t.messages, dropped(drop)] };
      if (t.mode === 'fallback') t = askEveryDoubtfulLine(t);
      d.emit({ type: 'working', stage: 'done', text: 'Gotowe.' });
      return commit(settle({ ...t, step: 'szkic' }));
    },

    async ask(text: string): Promise<Trip> {
      if (frozen()) return hold();
      const before = generation;
      d.emit({ type: 'working', stage: 'choose', text: 'Claude przygotowuje propozycję…' });
      const r = await askClaude(d.spawn, 'adhoc', trip, text);
      d.emit({ type: 'working', stage: 'done', text: 'Gotowe.' });
      if (frozen()) return hold();
      if (before !== generation) return trip;
      if (r === null) return commit({ ...trip, messages: [...trip.messages, 'Claude jest niedostępny — nie mogę wykonać polecenia.'] });
      return commit(settle(holdProposal(trip, r.ops, r.dropped, false)));
    },

    apply(proposalId: string): Trip {
      if (frozen()) return hold();
      const p = trip.proposal;
      if (p === null || p.id !== proposalId) return trip;
      return takeOps(p.ops, null);
    },

    /** One operation of the pending proposal: taken through the same path as apply, or dropped. The rest stays pending. */
    proposalOp(proposalId: string, index: number, accept: boolean): Trip {
      if (frozen()) return hold();
      const p = trip.proposal;
      if (p === null || p.id !== proposalId || !Number.isInteger(index) || index < 0 || index >= p.ops.length) return trip;
      const rest = p.ops.filter((_, i) => i !== index);
      // A new id per step: a second click sent before the page re-rendered carries the old id and an index that
      // now points at a different operation, so it must be ignored rather than applied.
      const left = rest.length > 0 ? { ...p, id: randomUUID(), ops: rest } : null;
      return accept ? takeOps([p.ops[index]!], left) : commit(settle({ ...trip, proposal: left }));
    },

    reject(proposalId: string): Trip {
      if (frozen()) return hold();
      if (trip.proposal === null || trip.proposal.id !== proposalId) return trip;
      return commit(settle({ ...trip, proposal: null }));
    },

    chooseProduct(lineKey: string, productId: string): Trip {
      if (frozen()) return hold();
      const r = chooseProduct(trip, lineKey, productId);
      record(r.corrections);
      return commit(settle(r.trip));
    },

    dropUnmatched(term: string): Trip {
      if (frozen()) return hold();
      return commit(dropUnmatched(trip, term));
    },

    answer(lineKey: string, productId: string | null): Trip {
      if (frozen()) return hold();
      const r = answerLine(trip, lineKey, productId);
      record(r.corrections);
      return commit(settle(r.trip));
    },

    /** The user adds the product by hand on Auchan: the term moves to the unmatched list. */
    addByHand(lineKey: string): Trip {
      if (frozen()) return hold();
      const r = moveToUnmatched(trip, lineKey);
      record(r.corrections);
      return commit(settle(r.trip));
    },

    line(lineKey: string, change: { quantity?: number; remove?: true; included?: boolean }): Trip {
      if (frozen()) return hold();
      let t = trip;
      if (change.remove) {
        const r = applyOps(t, [{ op: 'remove', lineKey }]);
        record(r.corrections);
        t = r.trip;
      }
      else {
        if (change.quantity !== undefined) t = applyOps(t, [{ op: 'setQuantity', lineKey, quantity: change.quantity }]).trip;
        if (change.included !== undefined) t = setIncluded(t, lineKey, change.included);
      }
      return commit(settle(t));
    },

    async approve(): Promise<Start> {
      if (busy !== null) return refuse('Inna operacja trwa: poczekaj, aż się skończy.');
      if (trip.step === 'koszyk' || trip.step === 'platnosc') return refuse(ALREADY_IN_CART);
      if (trip.blocked) return refuse(BLOCKED_REASON);
      if (trip.proposal !== null) return refuse('Najpierw zastosuj albo odrzuć propozycję zmian.');
      if (openQuestions(trip).length > 0) return refuse('Najpierw odpowiedz na pytania o produkty.');
      let lines;
      try {
        lines = approvedLines(trip);
      } catch (e) {
        return refuse(e instanceof ListProblem ? e.message : `Lista zakupów jest niepoprawna: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (lines.length === 0) return refuse('Nic nie jest zaznaczone do zamówienia.');
      try {
        if (lockHeld(d.fillDeps.lockFile ?? LOCK_PATH)) return refuse(BUSY);
        withStore((s) => s.approveBasket(lines, trip.unmatched.map((u) => u.term), d.now()));
      } catch (e) {
        return refuse(`Nie udało się zatwierdzić koszyka: ${e instanceof Error ? e.message : String(e)}`);
      }
      const previous = trip;
      try {
        commit({ ...trip, step: 'koszyk' });
      } catch (e) {
        trip = previous;
        return refuse(`Nie udało się zapisać wyprzedzającego stanu: ${e instanceof Error ? e.message : String(e)}`);
      }
      busy = 'fill';
      void runInBackground(generation).catch((e) => {
        console.error(`Błąd wypełniania: ${e instanceof Error ? e.message : String(e)}`);
        busy = null;
      });
      return { started: true };
    },

    /** Looks the terms up in the visible browser; found products are saved and only those terms are drafted again. */
    async searchAuchan(terms?: string[], opts: { force?: boolean } = {}): Promise<Start> {
      if (busy !== null) return refuse('Inna operacja trwa: poczekaj, aż się skończy.');
      if (trip.step === 'koszyk' || trip.step === 'platnosc') return refuse(ALREADY_IN_CART);
      const lockFile = d.fillDeps.lockFile ?? LOCK_PATH;
      let region: string | null;
      let wanted: string[];
      try {
        if (lockHeld(lockFile)) return refuse(BUSY);
        const block = withStore((s) => s.searchBlock(d.now()));
        if (block !== null) return refuse(searchBlockText(block));
        region = withStore((s) => s.latestOrderRegion());
        const plan = terms === undefined ? searchPlan() : null;
        // Only terms the plan offers can be searched; anything else a caller sends is dropped.
        const offered = searchPlan();
        const allowed = new Set([...offered.terms, ...offered.recent].map(normaliseTerm));
        const given = plan !== null ? (opts.force ? [...plan.terms, ...plan.recent] : plan.terms) : [...new Map((terms ?? []).map((x) => x.trim()).filter((x) => x !== '' && allowed.has(normaliseTerm(x))).map((x) => [normaliseTerm(x), x])).values()];
        wanted = opts.force || terms === undefined ? given : withStore((s) => given.filter((x) => !s.searchedRecently(x, d.now())));
        if (terms !== undefined && !opts.force && wanted.length < given.length && wanted.length === 0) return refuse('Te hasła były szukane niedawno (w ostatnich 7 dniach). Kliknij ponownie, jeśli chcesz szukać jeszcze raz.');
      } catch (e) {
        return refuse(`Nie udało się przygotować szukania: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (region === null) return refuse('Najpierw zsynchronizuj zamówienia: wyszukiwanie potrzebuje Twojego regionu dostawy.');
      wanted = wanted.slice(0, MAX_SEARCH_TERMS);
      if (wanted.length === 0) return refuse('Nie ma czego szukać.');
      const token = acquireLock(lockFile);
      if (!token) return refuse(BUSY);
      busy = 'search';
      lastSearch = null;
      try {
        d.emit({ type: 'state' });
      } catch (e) {
        busy = null;
        releaseLock(lockFile, token);
        return refuse(`Nie udało się uruchomić szukania: ${e instanceof Error ? e.message : String(e)}`);
      }
      void runSearch(wanted, region, lockFile, token).catch((e) => {
        console.error(`Błąd szukania: ${e instanceof Error ? e.message : String(e)}`);
        busy = null;
      });
      return { started: true };
    },

    async sync(): Promise<Start> {
      if (busy !== null) return refuse('Inna operacja trwa: poczekaj, aż się skończy.');
      busy = 'sync';
      try {
        d.emit({ type: 'state' });
      } catch (e) {
        busy = null;
        return refuse(`Nie udało się uruchomić synchronizacji: ${e instanceof Error ? e.message : String(e)}`);
      }
      void (async () => {
        let code = 1;
        try {
          code = await syncAll(d.syncDeps, (text) => safeEmit({ type: 'log', text }), (e) => { for (const text of syncMessages(e)) safeEmit({ type: 'log', text }); });
        } catch (e) {
          safeEmit({ type: 'log', text: `Synchronizacja nie powiodła się: ${e instanceof Error ? e.message : String(e)}` });
        } finally {
          busy = null;
          safeEmit({ type: 'state' });
          safeEmit({ type: 'done', code });
        }
      })().catch((e) => {
        console.error(`Błąd synchronizacji: ${e instanceof Error ? e.message : String(e)}`);
        busy = null;
      });
      return { started: true };
    },

    rules(): IntentRule[] {
      return withStore((s) => s.intentRules());
    },
    blockedProducts() {
      return withStore((s) => s.blockedProducts());
    },
    searchProducts(query: string) {
      return withStore((s) => s.searchProducts(query));
    },
    blockProduct(productId: string): boolean {
      return editBlacklist((s) => s.blockProduct(productId));
    },
    unblockProduct(productId: string): boolean {
      return editBlacklist((s) => s.unblockProduct(productId));
    },
    deleteRule(term: string): void {
      withStore((s) => s.deleteRule(term));
    },
    clearBrand(term: string): void {
      withStore((s) => s.setBrandFixed(term, null));
    },

    shutdown(): void {
      if (busy === 'search') {
        stopped = true;
        const s = activeSearch;
        if (s) { void s.close().catch(() => {}); try { s.release(); } catch { /* exiting matters more */ } }
        return;
      }
      if (busy !== 'fill') return;
      stopped = true;
      try {
        active?.markFailed();
        active?.release();
      } catch {
        // Exiting matters more than a tidy record.
      }
    },

    reset(): Trip {
      if (busy === 'fill' || busy === 'search') return trip;
      generation++;
      lastSearch = null;
      trip = emptyTrip(d.now());
      rmSync(d.tripFile, { force: true });
      d.emit({ type: 'state' });
      return trip;
    },
  };

  async function runSearch(terms: string[], region: string, lockFile: string, token: string): Promise<void> {
    const announce = (e: SearchEvent) => { lastSearch = e; safeEmit(e); };
    let results: SearchResult[] = [];
    let failed = false;
    let failedReason: string | undefined;
    let stoppedReason: string | undefined;
    const search = createBrowserSearch({
      ...d.searchTuning,
      openPage: d.openSearchPage,
      onStatus: (s) => {
        if (s.kind === 'login') announce({ type: 'search', status: 'login' });
        else if (s.kind === 'captcha') announce({ type: 'search', status: 'captcha', term: cleanText(s.term) });
        else if (s.kind === 'stopped') {
          stoppedReason ??= cleanText(s.reason);
          // Auchan said no: searching stays off for a day, whatever happens after this.
          if (s.status === 403 || s.status === 429) {
            try { withStore((st) => st.blockSearch(s.status!, d.now())); } catch (e) { console.error(`Nie udało się zapisać blokady szukania: ${e instanceof Error ? e.message : String(e)}`); }
          }
          safeEmit({ type: 'log', text: s.reason });
        }
        else announce({ type: 'search', status: 'searching', term: cleanText(s.term), index: s.index, total: s.total });
      },
    });
    let released = false;
    const release = () => { if (!released) { released = true; releaseLock(lockFile, token); } };
    activeSearch = { close: () => search.close(), release };
    try {
      try {
        results = await search.search(terms);
      } catch (e) {
        failed = true;
        if (e instanceof ProfileBusy) failedReason = PROFILE_BUSY_TEXT;
        safeEmit({ type: 'log', text: failedReason ?? `Szukanie nie powiodło się: ${cleanText(e instanceof Error ? e.message : String(e))}` });
      } finally {
        await search.close().catch(() => {});
        activeSearch = null;
        release();
      }
      if (stopped) return;
      const found: string[] = [];
      withStore((s) => {
        for (const r of results) {
          if (r.status === 'stopped') { failed = true; continue; }
          try {
            if (r.status === 'none') {
              s.saveSearchResults(r.term, { regionId: region, products: [], prices: [] }, d.now());
              continue;
            }
            const parsed = parseSearchState(r.state, r.term, d.now().toISOString());
            if (parsed.regionId !== region) throw new Error('strona wyników jest dla innego regionu niż Twoje zamówienia');
            s.saveSearchResults(r.term, parsed, d.now());
            found.push(r.term);
          } catch (e) {
            failed = true;
            safeEmit({ type: 'log', text: `${cleanText(r.term)}: ${cleanText(e instanceof Error ? e.message : String(e))}` });
          }
        }
      });
      let next = trip;
      if (found.length > 0) {
        const r = redraft(trip, found);
        next = r.trip;
        if (r.fresh.length > 0) {
          const chosen = next.mode === 'claude' ? await askClaude(d.spawn, 'choose', { ...next, lines: r.fresh }, next.note) : null;
          if (stopped) return;
          if (chosen === null) next = askEveryDoubtfulLine({ ...next, mode: 'fallback', messages: next.mode === 'claude' ? [...next.messages, FALLBACK_MESSAGE] : next.messages });
          else {
            const held = holdProposal(next, chosen.ops, chosen.dropped);
            const before = next.proposal;
            next = before !== null && held.proposal !== null && held.proposal !== before ? { ...held, proposal: { ...held.proposal, ops: [...before.ops, ...held.proposal.ops] } } : held;
          }
        }
      }
      failedReason ??= stoppedReason;
      const line = failedReason !== undefined ? `${failedReason} Znaleziono produkty dla ${found.length} z ${terms.length} haseł.` : failed
        ? `${SEARCH_STOPPED} Znaleziono produkty dla ${found.length} z ${terms.length} haseł.`
        : `Szukanie w Auchan: znaleziono produkty dla ${found.length} z ${terms.length} haseł.`;
      commit(settle({ ...next, messages: [...next.messages, line] }));
      busy = null;
      announce({ type: 'search', status: failed ? 'stopped' : 'done', found: found.length, total: terms.length, ...(failedReason !== undefined ? { reason: failedReason } : {}) });
    } catch (e) {
      const text = `Nie udało się zapisać wyników szukania: ${cleanText(e instanceof Error ? e.message : String(e))}`;
      console.error(`Błąd zapisu po szukaniu: ${e instanceof Error ? e.message : String(e)}`);
      busy = null;
      announce({ type: 'search', status: 'stopped', reason: text });
      safeEmit({ type: 'log', text });
    } finally {
      release();
      busy = null;
      safeEmit({ type: 'state' });
    }
  }

  async function runInBackground(startedGeneration: number): Promise<void> {
    const problems: string[] = [];
    let result: Awaited<ReturnType<typeof runFill>> | null = null;
    try {
      result = await runFill(d.fillDeps, {
        log: (text) => safeEmit({ type: 'log', text }),
        report: () => {},
        progress: (sent, total) => safeEmit({ type: 'progress', sent, total }),
        error: (text) => { problems.push(text); safeEmit({ type: 'log', text }); },
        loginPrompt: { text: LOGIN_PROMPT, say: (text) => safeEmit({ type: 'log', text }) },
        failed: (err) => {
          const text = failureText(err) ?? describeError(err, 'dodawanie');
          problems.push(text);
          safeEmit({ type: 'log', text });
        },
        onLocked: ({ lockFile, token, markFailed }) => {
          active = { markFailed, release: () => releaseLock(lockFile, token) };
          return () => { active = null; };
        },
      });
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    const code = result?.code ?? 1;
    try {
      const mine = !stopped && startedGeneration === generation;
      if (result !== null && result.report !== null) {
        const { report, substitutes } = result;
        const text = result.text ?? formatReport(report, trip.unmatched.map((u) => u.term), substitutes);
        safeEmit({ type: 'report', report: { ...report, substitutes, text, structured: result.structured } });
        busy = null;
        if (mine) commit({ ...trip, step: 'platnosc', reportText: text, reportData: result.structured });
      } else {
        busy = null;
        const polish = failureText(result?.failure);
        const text = polish ?? (problems.join(' ') || 'nieznany błąd');
        const stopped403 = result?.failure instanceof Blocked && !(result.failure instanceof Refused) && !(result.failure instanceof RateLimited);
        if (mine) commit({ ...trip, step: 'zatwierdzenie', ...(stopped403 ? { blocked: true } : {}), messages: [...trip.messages, `Wypełnianie nie powiodło się: ${text}`] });
      }
    } catch (e) {
      console.error(`Błąd zapisu po wypełnianiu: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      busy = null;
      safeEmit({ type: 'done', code });
    }
  }

  return view;
}
