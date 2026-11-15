import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { buildDraft } from '../draft.ts';
import type { Draft } from '../draft.ts';
import { syncAll } from '../cli.ts';
import type { Deps } from '../cli.ts';
import { BUSY, formatReport, runFill } from '../fill-cli.ts';
import type { FillDeps } from '../fill-cli.ts';
import { acquireLock, lockHeld, releaseLock } from '../lock.ts';
import { LOCK_PATH } from '../dbpath.ts';
import { zl } from '../money.ts';
import { normaliseTerm } from '../store.ts';
import type { IntentRule, Store } from '../store.ts';
import { askClaude } from './claude.ts';
import type { Spawn } from './claude.ts';
import { parseNote } from './fallback.ts';
import type { Op } from './ops.ts';
import {
  answer as answerLine, applyOps, approvedLines, emptyTrip, loadTrip, needsQuestion, openQuestions, saveTrip, setIncluded, tripFromDraft,
} from './trip.ts';
import type { Correction, Trip, TripLine } from './trip.ts';

export type AppEvent =
  | { type: 'log'; text: string }
  | { type: 'progress'; sent: number; total: number }
  | { type: 'report'; report: unknown }
  | { type: 'state' }
  | { type: 'done'; code: number };

export interface ServiceDeps {
  openStore(): Store;
  spawn: Spawn;
  fillDeps: FillDeps;
  syncDeps: Deps;
  tripFile: string;
  now(): Date;
  emit(e: AppEvent): void;
}

export type Busy = 'sync' | 'fill' | null;
type Start = { started: boolean; reason?: string };

const FALLBACK_MESSAGE = 'Tryb bez Claude: pytam o każdą niepewną pozycję.';
const INTERRUPTED = 'Wypełnianie przerwane — uruchom ponownie; doda tylko brakujące.';
const MAX_MESSAGES = 200;
const MAX_MESSAGE = 2000;
const CONF_RANK = { high: 0, medium: 1, low: 2 };

const ALREADY_IN_CART = 'Te zakupy są już w koszyku. Zacznij nowe zakupy, żeby dodać coś jeszcze.';
const FROZEN = 'Trwa dodawanie do koszyka — poczekaj na koniec.';

const refuse = (reason: string): Start => ({ started: false, reason });
const dropped = (n: number) => `pominięto ${n} nieprawidłowych zmian`;

export function createService(d: ServiceDeps) {
  let trip: Trip = loadTrip(d.tripFile) ?? emptyTrip(d.now());
  let busy: Busy = null;
  let generation = 0;
  let stopped = false;
  let active: { markFailed(): void; release(): void } | null = null;

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

  const frozen = () => busy === 'fill' || trip.step === 'koszyk';
  /** While the cart is being filled the trip stays as it is; the page is told why. */
  function hold(): Trip {
    if (trip.messages.at(-1) !== FROZEN) commit({ ...trip, messages: [...trip.messages, FROZEN] });
    return trip;
  }

  if (trip.step === 'koszyk') commit({ ...trip, step: 'zatwierdzenie', messages: [...trip.messages, INTERRUPTED] });

  const draftTerms = (store: Store, items: { term: string; quantity: number }[], includeUsual: boolean, budgetGrosze?: number): Draft =>
    buildDraft({ items, includeUsual, budgetGrosze }, store.productFacts(), store.intentRules(), d.now(), store.blockedProducts());

  const noteMap = (items: { term: string; note: string }[]): Record<string, string> =>
    Object.fromEntries(items.flatMap((i) => (i.note === '' ? [] : [[i.term, i.note], [normaliseTerm(i.term), i.note]])));

  const isAskOrSay = (o: Op) => o.op === 'ask' || o.op === 'say';

  /** Asking and saying change nothing; everything else waits as a proposal. */
  function holdProposal(t: Trip, ops: Op[], drop: number): Trip {
    const now = applyOps(t, ops.filter(isAskOrSay)).trip;
    const rest = ops.filter((o) => !isAskOrSay(o));
    const messages = drop > 0 ? [...now.messages, dropped(drop)] : now.messages;
    const proposal = rest.length > 0 ? { id: randomUUID(), ops: rest, dropped: drop, source: 'claude' as const } : now.proposal;
    return { ...now, messages, proposal };
  }

  function askEveryDoubtfulLine(t: Trip): Trip {
    const lines = t.lines.map((l): TripLine => {
      if (!l.included || l.question !== null || !needsQuestion(l)) return l;
      const options = l.candidates
        .map((c, i) => ({ c, i }))
        .sort((a, b) => CONF_RANK[a.c.confidence] - CONF_RANK[b.c.confidence] || a.i - b.i)
        .slice(0, 3)
        .map((x) => x.c.productId);
      return { ...l, question: { text: `Który produkt wybrać dla „${l.term ?? l.name}”?`, options } };
    });
    return { ...t, lines };
  }

  const record = (corrections: Correction[]) => {
    if (corrections.length) withStore((s) => corrections.forEach((c) => s.recordCorrection(c)));
  };

  function invalidateDraft(): void {
    generation++;
    if (['szkic', 'doprecyzowanie', 'zatwierdzenie'].includes(trip.step)) {
      commit({ ...emptyTrip(d.now()), note: trip.note, step: 'szkic', messages: ['Lista blokowanych produktów zmieniła się. Ułóż szkic ponownie.'] });
    } else safeEmit({ type: 'state' });
  }

  const view = {
    state() {
      const { ordersAt, promotionsAt } = withStore((s) => ({ ordersAt: s.lastSyncFinishedAt('orders'), promotionsAt: s.lastSyncFinishedAt('promotions') }));
      const oldest = ordersAt !== null && promotionsAt !== null ? (ordersAt < promotionsAt ? ordersAt : promotionsAt) : null;
      const ageHours = oldest === null ? null : Math.max(0, Math.round(((d.now().getTime() - new Date(oldest).getTime()) / 3600_000) * 10) / 10);
      return { trip, freshness: { ordersAt, promotionsAt, ageHours }, busy };
    },

    async note(input: { note: string; includeUsual: boolean; budgetGrosze?: number }): Promise<Trip> {
      if (frozen()) return hold();
      const mine = ++generation;
      const stale = () => frozen() || mine !== generation;
      let t: Trip = { ...emptyTrip(d.now()), note: input.note };
      const parsed = await askClaude(d.spawn, 'parse', t, input.note);
      if (stale()) return frozen() ? hold() : trip;
      const mode: Trip['mode'] = parsed === null ? 'fallback' : 'claude';
      const items = parsed === null
        ? parseNote(input.note)
        : parsed.ops.flatMap((o) => (o.op === 'add' ? [{ term: o.term, quantity: o.quantity, note: o.note ?? '' }] : []));
      t = { ...t, mode, messages: mode === 'fallback' ? [FALLBACK_MESSAGE] : [] };
      const draft = withStore((s) => draftTerms(s, items, input.includeUsual, input.budgetGrosze));
      t = tripFromDraft(t, draft, noteMap(items));
      if (draft.blocked?.length) t = { ...t, messages: [...t.messages, `Pominięto zablokowane produkty: ${draft.blocked.join(', ')}.`] };
      let drop = 0;
      if (parsed !== null) {
        drop += parsed.dropped;
        const matched = new Set(t.lines.flatMap((l) => (l.term === null ? [] : [normaliseTerm(l.term)])));
        const blocked = new Set((draft.blocked ?? []).map(normaliseTerm));
        const extra = parsed.ops.filter((o) => o.op === 'say' || (o.op === 'unmatched' && !matched.has(normaliseTerm(o.term)) && !blocked.has(normaliseTerm(o.term))));
        t = applyOps(t, extra).trip;
      }
      if (draft.overBudgetGrosze !== null) t = { ...t, messages: [...t.messages, `Przekroczono budżet o ${zl(draft.overBudgetGrosze)}.`] };
      if (t.lines.length === 0 && t.unmatched.length === 0 && !draft.blocked?.length) t = { ...t, messages: [...t.messages, 'Nie rozpoznano żadnych pozycji.'] };

      if (mode === 'claude' && t.lines.length > 0) {
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
      return commit(settle({ ...t, step: 'szkic' }));
    },

    async ask(text: string): Promise<Trip> {
      if (frozen()) return hold();
      const before = generation;
      const r = await askClaude(d.spawn, 'adhoc', trip, text);
      if (frozen()) return hold();
      if (before !== generation) return trip;
      if (r === null) return commit({ ...trip, messages: [...trip.messages, 'Claude jest niedostępny — nie mogę wykonać polecenia.'] });
      return commit(settle(holdProposal(trip, r.ops, r.dropped)));
    },

    apply(proposalId: string): Trip {
      if (frozen()) return hold();
      const p = trip.proposal;
      if (p === null || p.id !== proposalId) return trip;
      const r = applyOps({ ...trip, proposal: null }, p.ops);
      record(r.corrections);
      let next = r.trip;
      if (r.addTerms.length > 0) {
        const draft = withStore((s) => draftTerms(s, r.addTerms, false));
        next = tripFromDraft(next, draft, noteMap(r.addTerms));
        if (draft.blocked?.length) next = { ...next, messages: [...next.messages, `Pominięto zablokowane produkty: ${draft.blocked.join(', ')}.`] };
      }
      return commit(settle(next));
    },

    reject(proposalId: string): Trip {
      if (frozen()) return hold();
      if (trip.proposal === null || trip.proposal.id !== proposalId) return trip;
      return commit(settle({ ...trip, proposal: null }));
    },

    answer(lineKey: string, productId: string | null): Trip {
      if (frozen()) return hold();
      const r = answerLine(trip, lineKey, productId);
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
      if (trip.proposal !== null) return refuse('Najpierw zastosuj albo odrzuć propozycję zmian.');
      if (openQuestions(trip).length > 0) return refuse('Najpierw odpowiedz na pytania o produkty.');
      let lines;
      try {
        lines = approvedLines(trip);
      } catch (e) {
        return refuse(`Lista zakupów jest niepoprawna: ${e instanceof Error ? e.message : String(e)}`);
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
          code = await syncAll(d.syncDeps, (text) => safeEmit({ type: 'log', text }));
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
      if (busy === 'fill') return trip;
      generation++;
      trip = emptyTrip(d.now());
      rmSync(d.tripFile, { force: true });
      d.emit({ type: 'state' });
      return trip;
    },
  };

  async function runInBackground(startedGeneration: number): Promise<void> {
    const problems: string[] = [];
    let result: Awaited<ReturnType<typeof runFill>> | null = null;
    try {
      result = await runFill(d.fillDeps, {
        log: (text) => safeEmit({ type: 'log', text }),
        report: () => {},
        progress: (sent, total) => safeEmit({ type: 'progress', sent, total }),
        error: (text) => { problems.push(text); safeEmit({ type: 'log', text }); },
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
        safeEmit({ type: 'report', report: { ...report, substitutes, text } });
        busy = null;
        if (mine) commit({ ...trip, step: 'platnosc', reportText: text });
      } else {
        busy = null;
        if (mine) commit({ ...trip, step: 'zatwierdzenie', messages: [...trip.messages, `Wypełnianie nie powiodło się: ${problems.join(' ') || 'nieznany błąd'}`] });
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
