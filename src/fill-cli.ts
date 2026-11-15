import { fileURLToPath } from 'node:url';
import type { Store } from './store.ts';
import { browserLogin, Blocked, type Worker } from './worker.ts';
import { createHttpWorker, type CartAccess } from './http-worker.ts';
import { describeFailure, ensureStateDir, liveDeps as syncDeps, withLogin } from './cli.ts';
import { fillCart } from './fill.ts';
import { cleanText } from './parse.ts';
import { zl } from './money.ts';
import { buildDraft } from './draft.ts';
import { parseCart, type FillReport, type PriceNote } from './cart.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { LOCK_PATH, SESSION_PATH } from './dbpath.ts';

export interface FillDeps {
  openWorker(): Promise<Worker & CartAccess>;
  openStore(): Store;
  lockFile?: string;
}

const CHECKOUT = 'https://zakupy.auchan.pl/checkout';
const NO_BASKET = 'Brak zatwierdzonego koszyka z ostatnich 24 godzin: zatwierdź koszyk (approve_basket) i uruchom ponownie';
const LOG_IN = 'Log in in the browser window and leave it open; the fill continues on its own';
export const BUSY = 'Inny fill już trwa: poczekaj, aż się skończy. Jeśli żaden nie działa, usuń plik .state/fill.lock i uruchom ponownie';
const RERUN_SAFE = 'Ponowne uruchomienie jest bezpieczne: wczyta koszyk od nowa i doda tylko to, czego jeszcze brakuje.';

const liveDeps: FillDeps = {
  openStore: syncDeps.openStore,
  async openWorker() {
    ensureStateDir(SESSION_PATH);
    return createHttpWorker({ sessionFile: SESSION_PATH, login: () => browserLogin(SESSION_PATH) });
  },
};

export { zl };
const qty = (n: number): string => String(Math.round(n * 1000) / 1000).replace('.', ',');

function note(n: PriceNote): string {
  return `${cleanText(n.name)}: ${zl(n.approvedGrosze)} -> ${zl(n.nowGrosze)} (+${n.risePercent.toFixed(1).replace('.', ',')}%)`;
}

/** substitutes: product id -> names of up to 2 alternatives. The cart has no names; lines are named from the basket. */
export function formatReport(
  r: FillReport & { sent: number }, unmatched: string[], substitutes: Record<string, string[]> = {}, names: Record<string, string> = {},
): string {
  const out: string[] = [];
  const section = (title: string, rows: string[]) => {
    if (rows.length) out.push(`${title}:`, ...rows.map((x) => `  - ${x}`), '');
  };
  const withSubs = (l: { productId: string; name: string; quantity: number }) => {
    const subs = (substitutes[l.productId] ?? []).slice(0, 2).map(cleanText);
    const lim = r.limits?.[l.productId];
    const limit = lim ? ` — dodano ${qty(lim.added)} z ${qty(lim.requested)} (powód: ${cleanText(lim.reason)})` : '';
    return `${cleanText(l.name)} x ${qty(l.quantity)}${limit}${subs.length ? ` (zamiast tego: ${subs.join('; ')})` : ''}`;
  };
  section('Sprawdź przed zapłatą', r.checkBeforePaying.map(note));
  section('Brak w sklepie', r.outOfStock.map(withSubs));
  section('Nie dodano', r.missing.map(withSubs));
  section('Dodaj sam na Auchan', unmatched.map(cleanText));
  section('Było już w koszyku', [
    ...r.alreadyEnough.map((l) => `${cleanText(l.name)} x ${qty(l.quantity)}`),
    ...r.extras.map((l) => `${cleanText(names[l.productId] ?? `produkt spoza koszyka ${l.productId}`)} x ${qty(l.quantity)}`),
  ]);
  section('Niewielkie podwyżki', r.smallRises.map(note));
  out.push(`Dodano produktów: ${r.added.length}`);
  out.push(`Razem w koszyku: ${r.cartTotalGrosze === null ? 'nieznana kwota' : zl(r.cartTotalGrosze)}`);
  out.push(`Zapłać na ${CHECKOUT}`);
  return out.join('\n');
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** What a fill does when it is killed: free the lock if we hold it, record the failure, exit 130. */
export function interruptHandler(
  h: { lockFile: string; token: string; owns(): boolean; markFailed(): void },
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  return () => {
    try {
      if (h.owns()) releaseLock(h.lockFile, h.token);
      h.markFailed();
    } catch {
      // Exiting matters more than a tidy record.
    } finally {
      exit(130);
    }
  };
}

/** Names of cart lines outside the basket, where the store knows them. */
function extraNames(store: Store, ids: string[]): Record<string, string> {
  const want = new Set(ids);
  const out: Record<string, string> = {};
  if (!want.size) return out;
  for (const f of store.productFacts()) if (want.has(f.productId)) out[f.productId] = f.name;
  return out;
}

function substitutesFor(store: Store, lines: { term: string | null; productId: string; quantity: number }[]): Record<string, string[]> {
  const facts = store.productFacts();
  const rules = store.intentRules();
  const result: Record<string, string[]> = {};
  for (const l of lines) {
    if (l.term === null) continue;
    const draft = buildDraft({ items: [{ term: l.term, quantity: l.quantity }], includeUsual: false }, facts, rules, new Date());
    result[l.productId] = (draft.items[0]?.alternatives ?? []).filter((a) => a.productId !== l.productId).slice(0, 2).map((a) => a.name);
  }
  return result;
}

export interface FillHooks {
  log(line: string): void;
  progress(sent: number, total: number): void;
  /** Failure lines; the CLI prints them on stderr. Defaults to log. */
  error?(line: string): void;
  /** Called once the lock is held; returns a cleanup run when the fill ends. The CLI installs its signal handlers here. */
  onLocked?(h: { lockFile: string; token: string; markFailed(): void }): () => void;
}

export interface FillResult {
  code: number;
  report: (FillReport & { sent: number }) | null;
  substitutes: Record<string, string[]>;
  /** The printable report, when there is one. */
  text: string | null;
}

export async function runFill(deps: FillDeps, hooks: FillHooks): Promise<FillResult> {
  const error = hooks.error ?? hooks.log;
  const lockFile = deps.lockFile ?? LOCK_PATH;
  let store: Store | undefined;
  let worker: (Worker & CartAccess) | undefined;
  let token: string | false = false;
  let runId: number | undefined;
  const tally = { sent: 0 };
  let cleanup = () => {};
  const fail = (code: number): FillResult => ({ code, report: null, substitutes: {}, text: null });
  try {
    store = deps.openStore();
    // Taken atomically before the basket is read and held for the whole run, so two fills never overlap
    // and the guard hook keeps browser tools away from the shared profile.
    token = acquireLock(lockFile);
    if (!token) {
      error(BUSY);
      return fail(1);
    }
    const markFailed = () => {
      if (runId !== undefined) store?.finishFill(runId, { status: 'failed', sent: tally.sent, missing: 0, checkBeforePaying: 0 });
    };
    if (hooks.onLocked) cleanup = hooks.onLocked({ lockFile, token, markFailed });
    const basket = store.latestApprovedBasket();
    if (!basket) {
      error(NO_BASKET);
      return fail(1);
    }
    runId = store.startFill(basket.basketId);
    worker = await deps.openWorker();
    const cart = worker;
    // A rerun after login plans from a fresh read, so nothing is added twice; the report still compares with the cart
    // as it was at the start, and the sent count carries over.
    let baseline: ReturnType<typeof parseCart> | undefined;
    let planShown = false;
    const report = await withLogin(
      cart,
      async () => {
        const start = parseCart(await cart.readCart());
        baseline ??= start;
        return fillCart(cart, basket.lines, {
          start, baseline, tally,
          onPlan: (p) => {
            if (planShown) return;
            planShown = true;
            hooks.log(`Do dodania: ${p.count} produktów, ok. ${zl(p.totalGrosze)}`);
          },
          onProgress: (sent, total) => hooks.progress(sent, total),
        });
      },
      LOG_IN,
      error,
    );
    if (!report) {
      error('Nie zalogowano: wypełnianie przerwane. Część produktów mogła już trafić do koszyka; ponowne uruchomienie doda tylko to, czego brakuje.');
      store.finishFill(runId, { status: 'failed', sent: tally.sent, missing: 0, checkBeforePaying: 0 });
      return fail(1);
    }
    store.finishFill(runId, {
      status: 'ok', sent: report.sent, missing: report.missing.length + report.outOfStock.length, checkBeforePaying: report.checkBeforePaying.length,
    });
    runId = undefined;
    const lines = [...report.missing, ...report.outOfStock];
    let subs: Record<string, string[]> = {};
    let names: Record<string, string> = {};
    try {
      subs = substitutesFor(store, lines);
      names = extraNames(store, report.extras.map((e) => e.productId));
    } catch {
      // The report is worth more than its extras.
    }
    const text = formatReport(report, basket.unmatched, subs, names);
    hooks.log(text);
    return { code: 0, report, substitutes: subs, text };
  } catch (err) {
    if (runId !== undefined) store?.finishFill(runId, { status: 'failed', sent: tally.sent, missing: 0, checkBeforePaying: 0 });
    error(describeFailure(err, 'fill'));
    if (!(err instanceof Blocked)) error(RERUN_SAFE); // Refused is a Blocked: its own text says what to do
    return fail(1);
  } finally {
    cleanup();
    try {
      if (token) releaseLock(lockFile, token);
    } finally {
      try {
        await worker?.close();
      } finally {
        store?.close();
      }
    }
  }
}

export async function main(args: string[], deps: FillDeps = liveDeps): Promise<number> {
  if (args.length) {
    console.error('usage: npm run fill');
    return 2;
  }
  return (await runFill(deps, {
    log: (line) => console.log(line),
    progress: (sent, total) => console.log(`Dodawanie do koszyka: ${sent}/${total}`),
    error: (line) => console.error(line),
    onLocked({ lockFile, token, markFailed }) {
      const onInterrupt = interruptHandler({ lockFile, token, owns: () => true, markFailed });
      for (const sig of SIGNALS) process.on(sig, onInterrupt);
      return () => SIGNALS.forEach((sig) => process.off(sig, onInterrupt));
    },
  })).code;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
