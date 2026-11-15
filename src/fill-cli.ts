import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from './store.ts';
import { browserLogin, Blocked, type Worker } from './worker.ts';
import { createHttpWorker, type CartAccess } from './http-worker.ts';
import { describeFailure, ensureStateDir, liveDeps as syncDeps, withLogin } from './cli.ts';
import { fillCart } from './fill.ts';
import { buildDraft } from './draft.ts';
import type { FillReport, PriceNote } from './cart.ts';
import { lockHeld } from './lock.ts';
import { LOCK_PATH, SESSION_PATH } from './dbpath.ts';

export interface FillDeps {
  openWorker(): Promise<Worker & CartAccess>;
  openStore(): Store;
  lockFile?: string;
}

const CHECKOUT = 'https://zakupy.auchan.pl/checkout';
const NO_BASKET = 'Brak zatwierdzonego koszyka z ostatnich 24 godzin: zatwierdź koszyk (approve_basket) i uruchom ponownie';
const LOG_IN = 'Log in in the browser window and leave it open; the fill continues on its own';
const BUSY = 'Inny fill już trwa (blokada .state/fill.lock): poczekaj, aż się skończy';
const RERUN_SAFE = 'Ponowne uruchomienie jest bezpieczne: wczyta koszyk od nowa i doda tylko to, czego jeszcze brakuje.';

const liveDeps: FillDeps = {
  openStore: syncDeps.openStore,
  async openWorker() {
    ensureStateDir(SESSION_PATH);
    return createHttpWorker({ sessionFile: SESSION_PATH, login: () => browserLogin(SESSION_PATH) });
  },
};

export const zl = (grosze: number): string => `${(grosze / 100).toFixed(2).replace('.', ',')} zł`.replace(/\B(?=(\d{3})+(?=,))/g, ' ');
const qty = (n: number): string => String(Math.round(n * 1000) / 1000).replace('.', ',');

function note(n: PriceNote): string {
  return `${n.name}: ${zl(n.approvedGrosze)} -> ${zl(n.nowGrosze)} (+${Math.round(n.risePercent)}%)`;
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
    const subs = (substitutes[l.productId] ?? []).slice(0, 2);
    return `${l.name} x ${qty(l.quantity)}${subs.length ? ` (zamiast tego: ${subs.join('; ')})` : ''}`;
  };
  section('Sprawdź przed zapłatą', r.checkBeforePaying.map(note));
  section('Brak w sklepie', r.outOfStock.map(withSubs));
  section('Nie dodano', r.missing.map(withSubs));
  section('Dodaj sam na Auchan', unmatched);
  section('Było już w koszyku', [
    ...r.alreadyEnough.map((l) => `${l.name} x ${qty(l.quantity)}`),
    ...r.extras.map((l) => `${names[l.productId] ?? `produkt spoza koszyka ${l.productId}`} x ${qty(l.quantity)}`),
  ]);
  section('Niewielkie podwyżki', r.smallRises.map(note));
  out.push(`Dodano produktów: ${r.added.length}`);
  out.push(`Razem w koszyku: ${r.cartTotalGrosze === null ? 'nieznana kwota' : zl(r.cartTotalGrosze)}`);
  out.push(`Zapłać na ${CHECKOUT}`);
  return out.join('\n');
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

export async function main(args: string[], deps: FillDeps = liveDeps): Promise<number> {
  if (args.length) {
    console.error('usage: npm run fill');
    return 2;
  }
  const lockFile = deps.lockFile ?? LOCK_PATH;
  let store: Store | undefined;
  let worker: (Worker & CartAccess) | undefined;
  let locked = false;
  let runId: number | undefined;
  try {
    store = deps.openStore();
    if (lockHeld(lockFile)) {
      console.error(BUSY);
      return 1;
    }
    const basket = store.latestApprovedBasket();
    if (!basket) {
      console.error(NO_BASKET);
      return 1;
    }
    // Held for the whole run, so the guard hook keeps browser tools away from the shared profile.
    mkdirSync(dirname(lockFile), { recursive: true });
    writeFileSync(lockFile, String(process.pid), { mode: 0o600 });
    locked = true;
    runId = store.startFill(basket.basketId);
    worker = await deps.openWorker();
    const cart = worker;
    // A rerun after login starts from a fresh read, so nothing is added twice.
    const report = await withLogin(
      cart,
      () => fillCart(cart, basket.lines, { onProgress: (sent, total) => console.log(`Dodawanie do koszyka: ${sent}/${total}`) }),
      LOG_IN,
    );
    if (!report) {
      store.finishFill(runId, { status: 'failed', sent: 0, missing: 0, checkBeforePaying: 0 });
      return 1;
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
    console.log(formatReport(report, basket.unmatched, subs, names));
    return 0;
  } catch (err) {
    if (runId !== undefined) store?.finishFill(runId, { status: 'failed', sent: 0, missing: 0, checkBeforePaying: 0 });
    console.error(describeFailure(err, 'fill'));
    if (!(err instanceof Blocked)) console.error(RERUN_SAFE);
    return 1;
  } finally {
    try {
      if (locked) rmSync(lockFile, { force: true });
    } finally {
      try {
        await worker?.close();
      } finally {
        store?.close();
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
