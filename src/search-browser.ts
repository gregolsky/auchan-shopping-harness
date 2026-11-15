import { launchProfile, ORIGIN } from './worker.ts';

/** The slice of Playwright's Page the search needs; lets tests supply a fake. */
export interface PageLike {
  goto(url: string): Promise<{ status(): number } | null>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  title(): Promise<string>;
  url(): string;
  close(): Promise<void>;
  /** Resolves when the page has finished loading (or its limit passed). Optional: a page that cannot say is treated as loaded. */
  waitForLoad?(): Promise<void>;
  /** True once the user has closed the window. Optional: a page that cannot tell is treated as open. */
  isClosed?(): boolean;
}

export type SearchStatus =
  | { kind: 'login' }
  | { kind: 'captcha'; term: string }
  | { kind: 'stopped'; reason: string; /** The HTTP status that ended the run, when it was one. */ status?: number }
  | { kind: 'searching'; term: string; index: number; total: number };

export interface SearchResult {
  term: string;
  status: 'found' | 'none' | 'stopped';
  state?: unknown;
}

export interface BrowserSearchOptions {
  openPage(): Promise<PageLike>;
  /** Pause before every navigation after the first. Human pace. */
  paceMs?: number;
  captchaWaitMs?: number;
  loginWaitMs?: number;
  /** After a captcha clears: how long to wait for the page's state to appear. It only waits, never reloads. */
  stateWaitMs?: number;
  onStatus(s: SearchStatus): void;
  /** Poll interval while waiting for the user. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const MAX_SEARCH_TERMS = 10;
export const PROFILE_BUSY_TEXT = 'Zamknij inne okno przeglądarki z profilem zakupów i spróbuj ponownie.';
const CAPTCHA_TITLE = /confirm you are human/i;

/** Runs in the page: AWS WAF's challenge, a captcha iframe, or any element whose id or class names a captcha. */
function hasCaptchaMarker(): boolean {
  const doc = (globalThis as any).document;
  return !!doc?.querySelector('iframe[src*="captcha" i], [id*="captcha" i], [class*="captcha" i], #challenge-container, [id*="awswafcaptcha" i]');
}

export const WINDOW_CLOSED = 'Okno przeglądarki zostało zamknięte.';
/** What the user is told while searching is held back after a refusal. */
export function searchBlockText(block: { until: string; status: number }): string {
  const when = new Date(block.until).toLocaleString('pl-PL', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return `Auchan odmówił wyszukiwania (${block.status}). Wyszukiwanie wstrzymane do ${when}.`;
}

const WRONG_PAGE = 'Okno przeglądarki pokazuje inną stronę — przerwano wyszukiwanie.';

/** Whether the window shows the search page for exactly this term; anything else (the user navigated, a redirect) is not read. */
function onSearchPage(p: PageLike, term: string): boolean {
  try {
    const u = new URL(p.url());
    return u.pathname === '/search' && u.searchParams.get('q') === term;
  } catch {
    return false;
  }
}

const stopReason = (status: number): string =>
  status === 403 ? 'Auchan odmówił dostępu (403) — przerywam bez ponawiania.'
    : status === 429 ? 'Auchan prosi o zwolnienie tempa (429) — przerywam bez ponawiania.'
    : `Auchan odpowiedział błędem (${status}) — przerywam bez ponawiania.`;

/**
 * Searches in a visible browser window. It never works around bot protection: a captcha is solved by the user,
 * and a refusal (HTTP 403) or an unexpected page stops the run with no retry. Terms beyond the first 10 are ignored.
 */
export function createBrowserSearch(o: BrowserSearchOptions): { search(terms: string[]): Promise<SearchResult[]>; close(): Promise<void> } {
  const paceMs = o.paceMs ?? 5_000;
  const captchaWaitMs = o.captchaWaitMs ?? 300_000;
  const loginWaitMs = o.loginWaitMs ?? 300_000;
  const stateWaitMs = o.stateWaitMs ?? 15_000;
  const pollMs = o.pollMs ?? 2_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  let page: PageLike | undefined;
  let navigated = false;

  const navigate = async (p: PageLike, url: string): Promise<number | null> => {
    if (navigated) await sleep(paceMs);
    navigated = true;
    try {
      const res = await p.goto(url);
      return res ? res.status() : 0;
    } catch {
      windowClosed(p);
      return null; // window closed or navigation failed: no retry
    }
  };

  /** A captcha is told by its title or by a captcha element in the page; a title that cannot be read counts as one (fail-safe: keep waiting). */
  const isCaptcha = async (p: PageLike): Promise<boolean> => {
    try {
      if (CAPTCHA_TITLE.test(await p.title())) return true;
    } catch {
      return true; // mid-navigation by the user: keep waiting
    }
    try {
      return (await p.evaluate(hasCaptchaMarker)) === true;
    } catch {
      return false; // the title already said this is no captcha
    }
  };

  /** After a captcha clears the page may still be loading or reloading itself: wait for load, then for the state. Never navigates. */
  const settleAfterCaptcha = async (p: PageLike, ready: () => Promise<boolean>): Promise<void> => {
    try {
      await p.waitForLoad?.();
    } catch {
      // keep going: the state poll below decides
    }
    await waitUntil(p, ready, stateWaitMs);
  };

  /** True once the user has closed the window; reported once. A page that cannot tell is treated as open. */
  let closedReported = false;
  const windowClosed = (p: PageLike): boolean => {
    let closed = false;
    try {
      closed = p.isClosed?.() === true;
    } catch {
      closed = true;
    }
    if (closed && !closedReported) {
      closedReported = true;
      o.onStatus({ kind: 'stopped', reason: WINDOW_CLOSED });
    }
    return closed;
  };

  /** Polls until cond holds; gives up at the deadline, or at once when the user closes the window. */
  const waitUntil = async (p: PageLike, cond: () => Promise<boolean>, limitMs: number): Promise<boolean> => {
    const deadline = now() + limitMs;
    while (!windowClosed(p) && !(await cond())) {
      if (windowClosed(p) || now() >= deadline) return false;
      await sleep(pollMs);
    }
    return !windowClosed(p);
  };

  const loggedIn = async (p: PageLike): Promise<boolean> => {
    try {
      return await p.evaluate(() => (globalThis as any).__INITIAL_STATE__?.session?.isLoggedIn === true);
    } catch {
      return false;
    }
  };

  const readState = async (p: PageLike): Promise<unknown> => {
    try {
      return await p.evaluate(() => (globalThis as any).__INITIAL_STATE__);
    } catch {
      return undefined;
    }
  };

  const entityCount = (state: unknown): number | null => {
    const e = (state as any)?.data?.products?.productEntities;
    return e && typeof e === 'object' && !Array.isArray(e) ? Object.keys(e).length : null;
  };

  return {
    async search(allTerms) {
      const terms = allTerms.slice(0, MAX_SEARCH_TERMS);
      const results: SearchResult[] = [];
      const stopRest = () => {
        for (const term of terms.slice(results.length)) results.push({ term, status: 'stopped' });
        return results;
      };
      if (terms.length === 0) return results;
      page = await o.openPage();
      const p = page;

      // A refusal on any navigation stops the run: the captcha page (checked by title) is the only non-2xx the user may solve.
      const refused = async (status: number | null): Promise<boolean> => {
        if (status === null) return true;
        if (status >= 200 && status < 300) return false;
        if (status !== 403 && status !== 429 && (await isCaptcha(p))) return false;
        o.onStatus({ kind: 'stopped', reason: stopReason(status), status });
        return true;
      };

      const home = await navigate(p, `${ORIGIN}/`);
      if (home === null) return stopRest();
      if (await refused(home)) return stopRest();
      if (await isCaptcha(p)) {
        o.onStatus({ kind: 'captcha', term: terms[0] });
        if (!(await waitUntil(p, async () => !(await isCaptcha(p)), captchaWaitMs))) return stopRest();
        await settleAfterCaptcha(p, async () => (await readState(p)) != null);
        if (windowClosed(p)) return stopRest();
      }
      if (!(await loggedIn(p))) {
        o.onStatus({ kind: 'login' });
        if (!(await waitUntil(p, () => loggedIn(p), loginWaitMs))) return stopRest();
      }

      for (let i = 0; i < terms.length; i++) {
        const term = terms[i];
        o.onStatus({ kind: 'searching', term, index: i + 1, total: terms.length });
        const status = await navigate(p, `${ORIGIN}/search?q=${encodeURIComponent(term)}`);
        if (status === null) return stopRest();
        if (await refused(status)) return stopRest();
        if (await isCaptcha(p)) {
          o.onStatus({ kind: 'captcha', term });
          if (!(await waitUntil(p, async () => !(await isCaptcha(p)), captchaWaitMs))) return stopRest();
          await settleAfterCaptcha(p, async () => entityCount(await readState(p)) !== null);
          if (windowClosed(p)) return stopRest();
        }
        if (!onSearchPage(p, term)) {
          o.onStatus({ kind: 'stopped', reason: WRONG_PAGE });
          return stopRest();
        }
        const state = await readState(p);
        const n = entityCount(state);
        if (n === null) return stopRest();
        results.push(n === 0 ? { term, status: 'none' } : { term, status: 'found', state });
      }
      return results;
    },
    async close() {
      const p = page;
      page = undefined;
      if (p) await p.close().catch(() => {});
    },
  };
}

interface PwPage { goto(url: string): Promise<{ status(): number } | null>; evaluate<R>(fn: () => R | Promise<R>): Promise<R>; title(): Promise<string>; url(): string; isClosed(): boolean; waitForLoadState(state: 'load', o: { timeout: number }): Promise<void> }
interface PwContext { pages(): PwPage[]; newPage(): Promise<PwPage>; close(): Promise<void> }

/** Wraps an open browser context as a page; if no page can be had the context is closed again, so no window is left behind. Exported for tests. */
export async function pageFromContext(context: PwContext): Promise<PageLike> {
  let page: PwPage;
  try {
    page = context.pages()[0] ?? (await context.newPage());
  } catch (e) {
    await context.close().catch(() => {});
    throw e;
  }
  return {
    goto: (url) => page.goto(url),
    evaluate: (fn) => page.evaluate(fn),
    title: () => page.title(),
    url: () => page.url(),
    waitForLoad: () => page.waitForLoadState('load', { timeout: 15_000 }),
    isClosed: () => page.isClosed(),
    close: () => context.close(),
  };
}

/** The live page: the dedicated profile in a visible, sandboxed Chromium. Closing the page closes the window. */
export async function openSearchPage(): Promise<PageLike> {
  return pageFromContext((await launchProfile()) as unknown as PwContext);
}
