import { existsSync, readFileSync } from 'node:fs';
import { ShapeError } from './parse.ts';
import { APPLY_QUANTITY_PATH, assertAllowed, assertGraphqlOperation, Blocked, CART_READ_PATH, checkGraphql, LoginRequired, normaliseGet, ORIGIN, RateLimited, type SessionCookie, type Worker } from './worker.ts';

/** One request at a time, at most one per this many ms, enforced here so no caller can skip it. */
const MIN_GAP_MS = 1500;
const VERSION = { 'ecom-request-source-version': '2.0.0' };

export function cookieHeader(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, 'utf8'); // an unreadable file is a real error, not a missing login; its message names only the path
  try {
    const cookies = JSON.parse(raw) as SessionCookie[];
    if (!Array.isArray(cookies)) return undefined;
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return undefined; // the parser's message quotes the file; a damaged session just needs a new login
  }
}

/** Retry-After as seconds from now; undefined when absent or unreadable. It may be seconds or a date. */
export function retrySeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header.trim())) return Number(header);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

export function extractState(html: string): any {
  const marker = 'window.__INITIAL_STATE__=';
  const start = html.indexOf(marker);
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) throw new ShapeError('page has no state');
  try {
    return JSON.parse(html.slice(start + marker.length, end).replace(/;\s*$/, ''));
  } catch {
    throw new ShapeError('page state was not JSON'); // the parser's message can quote the page
  }
}

/** Same-origin pathname+search of every link starting with prefix. */
export function extractLinks(html: string, prefix: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
    try {
      const u = new URL(m[1].replaceAll('&amp;', '&'), ORIGIN);
      const v = u.pathname + u.search;
      if (u.origin === ORIGIN && v.startsWith(prefix)) out.push(v);
    } catch {}
  }
  return out;
}

export interface HttpOptions {
  sessionFile: string;
  /** Gets a fresh login into sessionFile; false if the user gave up. */
  login(): Promise<boolean>;
  fetchFn?: typeof fetch;
  gapMs?: number;
}

export interface CartChange {
  productId: string;
  quantity: number;
}
/** A product Auchan could not add in full; it still answers HTTP 200. */
export interface LimitedItem {
  productId: string;
  reason: string;
  requestedAmount: number;
  addedAmount: number;
}
export interface CartAccess {
  readCart(): Promise<unknown>;
  /** Sends at most MAX_BATCH changes in one POST; throws on a non-2xx. Returns the products Auchan limited. */
  applyQuantities(changes: CartChange[]): Promise<LimitedItem[]>;
}
export const MAX_BATCH = 10;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A 4xx other than 401, 403 and 429: Auchan refused the request itself. */
export class Rejected extends Error {
  status: number;
  constructor(status: number) {
    super(`rejected by site (HTTP ${status})`);
    this.name = 'Rejected';
    this.status = status;
  }
}

export function createHttpWorker(o: HttpOptions): Worker & CartAccess {
  const fetchFn = o.fetchFn ?? fetch;
  const gapMs = o.gapMs ?? MIN_GAP_MS;
  let last = 0;
  let csrf: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const request = (path: string, init: RequestInit): Promise<{ status: number; text: string }> => {
    const run = async () => {
      const cookie = cookieHeader(o.sessionFile);
      if (!cookie) throw new LoginRequired();
      const wait = last + gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      let res: Response;
      try {
        res = await fetchFn(ORIGIN + path, {
          ...init,
          redirect: 'manual', // a redirect here means login; following it would leave the allowlist
          signal: AbortSignal.timeout(30000),
          headers: { ...(init.headers as object), cookie },
        });
      } catch (e) {
        throw new Error((e as Error)?.name === 'TimeoutError' ? 'request timed out after 30 s' : 'request failed');
      }
      const { status } = res;
      const retryAfter = res.headers.get('retry-after');
      if (status === 429 || (status === 503 && retryAfter)) throw new RateLimited(status, retrySeconds(retryAfter));
      if (status === 403) throw new Blocked(`blocked by site (HTTP ${status}); stopping, not retrying`);
      if (status === 401 || (status >= 300 && status < 400)) throw new LoginRequired();
      if (status >= 400 && status < 500) throw new Rejected(status);
      if (status < 200 || status >= 300) throw new Error(`unexpected HTTP ${status}`);
      return { status, text: await res.text() };
    };
    const result = queue.then(run, run);
    queue = result.catch(() => {});
    return result;
  };

  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new ShapeError('response was not JSON'); // the parser's message can quote the body
    }
  };

  const page = async (path: string): Promise<string> => (await request(normaliseGet(path), {})).text;

  const loadState = async (path: string): Promise<any> => {
    const state = extractState(await page(path));
    const token = state?.session?.csrf?.token;
    if (typeof token === 'string' && token) csrf = token;
    if (state?.session) delete state.session.csrf; // the token stays in this closure
    return state;
  };

  return {
    async getJson(path) {
      return parse((await request(normaliseGet(path), { headers: VERSION })).text);
    },

    async graphql(operationName, query, variables) {
      assertGraphqlOperation(operationName, query);
      assertAllowed('/graphql');
      if (!csrf) await loadState('/orders');
      if (!csrf) throw new LoginRequired('no CSRF token in page state: session not logged in');
      const { text } = await request('/graphql', {
        method: 'POST',
        headers: { ...VERSION, 'content-type': 'application/json', 'x-csrf-token': csrf, 'ecom-request-source': 'web' },
        body: JSON.stringify({ operationName, query, variables }),
      });
      return checkGraphql(parse(text));
    },

    async pageState(path) {
      const state = await loadState(path);
      if (/^\/orders(\/|$)/.test(new URL(path, ORIGIN).pathname) && state?.session?.isLoggedIn === false) throw new LoginRequired();
      return state;
    },

    async pageLinks(path, prefix) {
      if (!prefix.startsWith('/') || prefix.startsWith('//')) throw new Error(`bad link prefix: ${prefix}`);
      return extractLinks(await page(path), prefix);
    },

    async readCart() {
      return parse((await request(normaliseGet(CART_READ_PATH), { headers: VERSION })).text);
    },

    async applyQuantities(changes) {
      if (changes.length === 0 || changes.length > MAX_BATCH) throw new Error(`a batch must have 1 to ${MAX_BATCH} changes`);
      for (const c of changes) {
        if (typeof c.productId !== 'string' || !UUID.test(c.productId)) throw new Error('product id is not a UUID');
        if (typeof c.quantity !== 'number' || !Number.isFinite(c.quantity) || c.quantity <= 0 || c.quantity > 100) {
          throw new Error('quantity must be above 0 and at most 100');
        }
      }
      csrf = undefined; // a stale token must not survive a page that has none (an expired session)
      const state = await loadState('/orders'); // a fresh token for every batch
      if (state?.session?.isLoggedIn === false) throw new LoginRequired();
      if (!csrf) throw new LoginRequired('no CSRF token in page state: session not logged in');
      const meta = { itemListName: 'search', favorite: false, pageViewId: crypto.randomUUID(), pageType: 'search' };
      const { text } = await request(APPLY_QUANTITY_PATH, {
        method: 'POST',
        headers: { ...VERSION, 'content-type': 'application/json', 'x-csrf-token': csrf, 'ecom-request-source': 'web' },
        body: JSON.stringify(changes.map((c) => ({ productId: c.productId, quantity: c.quantity, meta }))),
      });
      const limited = (parse(text) as any)?.limitedItems;
      if (limited === undefined) return [];
      if (!Array.isArray(limited)) throw new ShapeError('limitedItems was not an array');
      return limited.map((l: any): LimitedItem => {
        if (typeof l?.productId !== 'string') throw new ShapeError('a limited item has no product id');
        return { productId: l.productId, reason: String(l.reason), requestedAmount: Number(l.requestedAmount), addedAmount: Number(l.addedAmount) };
      });
    },

    async close() {},

    async waitForLogin() {
      csrf = undefined;
      return o.login();
    },
  };
}
