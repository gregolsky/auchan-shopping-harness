import { launchProfile, ORIGIN } from './worker.ts';

/** The slice of Playwright's Page the search needs; lets tests supply a fake. */
export interface PageLike {
  goto(url: string): Promise<{ status(): number } | null>;
  evaluate<R>(fn: () => R | Promise<R>): Promise<R>;
  title(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

export type SearchStatus =
  | { kind: 'login' }
  | { kind: 'captcha'; term: string }
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
  onStatus(s: SearchStatus): void;
  /** Poll interval while waiting for the user. */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export const MAX_SEARCH_TERMS = 10;
const CAPTCHA_TITLE = /confirm you are human/i;

/**
 * Searches in a visible browser window. It never works around bot protection: a captcha is solved by the user,
 * and a refusal (HTTP 403) or an unexpected page stops the run with no retry. Terms beyond the first 10 are ignored.
 */
export function createBrowserSearch(o: BrowserSearchOptions): { search(terms: string[]): Promise<SearchResult[]>; close(): Promise<void> } {
  const paceMs = o.paceMs ?? 5_000;
  const captchaWaitMs = o.captchaWaitMs ?? 300_000;
  const loginWaitMs = o.loginWaitMs ?? 300_000;
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
      return null; // window closed or navigation failed: no retry
    }
  };

  const isCaptcha = async (p: PageLike): Promise<boolean> => {
    try {
      return CAPTCHA_TITLE.test(await p.title());
    } catch {
      return true; // mid-navigation by the user: keep waiting
    }
  };

  const waitUntil = async (cond: () => Promise<boolean>, limitMs: number): Promise<boolean> => {
    const deadline = now() + limitMs;
    while (!(await cond())) {
      if (now() >= deadline) return false;
      await sleep(pollMs);
    }
    return true;
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

      if ((await navigate(p, `${ORIGIN}/`)) === null) return stopRest();
      if (!(await loggedIn(p))) {
        o.onStatus({ kind: 'login' });
        if (!(await waitUntil(() => loggedIn(p), loginWaitMs))) return stopRest();
      }

      for (let i = 0; i < terms.length; i++) {
        const term = terms[i];
        o.onStatus({ kind: 'searching', term, index: i + 1, total: terms.length });
        const status = await navigate(p, `${ORIGIN}/search?q=${encodeURIComponent(term)}`);
        if (status === null || status === 403) return stopRest();
        if (await isCaptcha(p)) {
          o.onStatus({ kind: 'captcha', term });
          if (!(await waitUntil(async () => !(await isCaptcha(p)), captchaWaitMs))) return stopRest();
        } else if (status < 200 || status >= 300) {
          return stopRest(); // an error page that is not the captcha: stop, no retry
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

/** The live page: the dedicated profile in a visible, sandboxed Chromium. Closing the page closes the window. */
export async function openSearchPage(): Promise<PageLike> {
  const context = await launchProfile();
  const page = context.pages()[0] ?? (await context.newPage());
  return {
    goto: (url) => page.goto(url),
    evaluate: (fn) => page.evaluate(fn),
    title: () => page.title(),
    url: () => page.url(),
    close: () => context.close(),
  };
}
