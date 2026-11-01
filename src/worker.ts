import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { ShapeError } from './parse.ts';

export const ORIGIN = 'https://zakupy.auchan.pl';
const HOST = new URL(ORIGIN).host;
const EXECUTABLE = '/usr/sbin/chromium';
const PROFILE = '/home/gregolsky/.cache/chrome-devtools-mcp/zakupy';
const ALLOWED_OPERATION = 'GetCompletedOrders';

// The only GraphQL document the worker will ever send.
export const GET_COMPLETED_ORDERS_QUERY = readFileSync(
  new URL('./queries/GetCompletedOrders.graphql', import.meta.url),
  'utf8',
);

export class LoginRequired extends Error {
  constructor(message = 'login required: sign in to zakupy.auchan.pl in the harness browser profile') {
    super(message);
    this.name = 'LoginRequired';
  }
}
export class Blocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Blocked';
  }
}
/** Auchan said to slow down. Stops the run like Blocked; retrySeconds comes from Retry-After when sent. */
export class RateLimited extends Blocked {
  retrySeconds?: number;
  constructor(status: number, retrySeconds?: number) {
    super(`rate limited by site (HTTP ${status}); stopping, not retrying`);
    this.name = 'RateLimited';
    this.retrySeconds = retrySeconds;
  }
}
export class ProfileBusy extends Error {
  constructor(message = 'browser profile is in use: close the other browser first') {
    super(message);
    this.name = 'ProfileBusy';
  }
}

// Anchored, matched against the normalised pathname only.
export const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/orders$/,
  /^\/promotions$/,
  /^\/promotions\/[^/]+\/\d+$/,
  /^\/api\/order\/v6\/orders\/[\w-]+\/decorated$/,
  /^\/graphql$/,
];

const CONTROL = /[\u0000-\u001f\u007f]/;

function slugIsSafe(slug: string): boolean {
  let cur = slug;
  for (let i = 0; i < 10; i++) {
    if (cur.includes('/') || cur.includes('\\') || cur.includes('..') || CONTROL.test(cur)) return false;
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return false;
    }
    if (next === cur) return true;
    cur = next;
  }
  return false; // still changing after 10 decodes
}

export function assertAllowed(path: string): void {
  // Must be a site-relative path; reject absolute URLs, protocol-relative, backslash and control chars.
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || CONTROL.test(path)) {
    throw new Error(`path not allowed: ${path}`);
  }
  const url = new URL(path, ORIGIN);
  if (url.host !== HOST || !ALLOWED_PATHS.some((re) => re.test(url.pathname))) {
    throw new Error(`path not allowed: ${path}`);
  }
  const cat = /^\/promotions\/([^/]+)\/\d+$/.exec(url.pathname);
  if (cat && !slugIsSafe(cat[1])) throw new Error(`path not allowed: ${path}`);
}

/** Paths that may be fetched with GET / navigated to. /graphql is POST-only via graphql(). */
export function normaliseGet(path: string): string {
  assertAllowed(path);
  const url = new URL(path, ORIGIN);
  if (url.pathname === '/graphql') throw new Error(`path not allowed for GET: ${path}`);
  return url.pathname + url.search;
}

/** Turns GraphQL errors into exceptions; a customer error means the session is not logged in. */
export function checkGraphql(json: any): unknown {
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    const codes = json.errors.map((e: any) => e?.extensions?.code ?? e?.code);
    if (codes.includes('missing-customer-error')) throw new LoginRequired();
    throw new ShapeError(`graphql returned errors: ${codes.filter(Boolean).join(',') || 'unknown'}`);
  }
  return json;
}

export function assertGraphqlOperation(operationName: string, query?: string): void {
  if (operationName !== ALLOWED_OPERATION) {
    throw new Error(`graphql operation not allowed: ${operationName}`);
  }
  if (query !== undefined && query !== GET_COMPLETED_ORDERS_QUERY) {
    throw new Error('graphql query text does not match the pinned GetCompletedOrders document');
  }
}

export function classifyResponse(status: number, finalUrl: string): void {
  if (status === 403 || status === 429) {
    throw new Blocked(`blocked by site (HTTP ${status}); stopping, not retrying`);
  }
  const u = new URL(finalUrl);
  if (status === 401 || u.host !== HOST || /^\/(login|logowanie|zaloguj|signin)(\/|$)/i.test(u.pathname)) {
    throw new LoginRequired();
  }
}

export function mapLaunchError(err: unknown): unknown {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ProcessSingleton|SingletonLock|profile.*in use|already running/i.test(msg)) return new ProfileBusy();
  return err;
}

export interface Worker {
  getJson(path: string): Promise<unknown>;
  graphql(operationName: string, query: string, variables: object): Promise<unknown>;
  pageState(path: string): Promise<unknown>;
  /** Same-origin pathname+search of links on an allowlisted page that start with prefix. */
  pageLinks(path: string, prefix: string): Promise<string[]>;
  close(): Promise<void>;
  /** Watches the open window without navigating it: true once logged in, false if the window closes first. */
  waitForLogin(): Promise<boolean>;
}

/** The slice of Playwright's Page the worker uses; lets tests supply a fake. */
export interface PageLike {
  url(): string;
  goto(url: string): Promise<{ status(): number } | null>;
  evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

type InPageResult =
  | { kind: 'ok'; status: number; url: string; text: string }
  | { kind: 'redirect' }
  | { kind: 'nocsrf' }
  | { kind: 'neterror' }
  | { kind: 'timeout' };

interface InPageRequest {
  url: string;
  body?: unknown;
}

/** Subscribe as soon as the context exists, so a window closed before anyone waits is not missed. */
export function whenClosed(context: { once(event: 'close', listener: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => context.once('close', () => resolve()));
}

export function createWorker(
  page: PageLike,
  closeFn: () => Promise<void> = async () => {},
  waitForCloseFn: () => Promise<void> = async () => {},
  loginPollMs = 3000,
): Worker {
  // Navigate to an allowlisted path, then verify status, final host/path and login state.
  const navigate = async (path: string): Promise<void> => {
    const resp = await page.goto(new URL(normaliseGet(path), ORIGIN).toString());
    if (!resp) throw new Error('navigation produced no response');
    const status = resp.status();
    const finalUrl = page.url();
    classifyResponse(status, finalUrl);
    if (status < 200 || status >= 300) throw new Error(`unexpected HTTP ${status}`);
    const f = new URL(finalUrl);
    try {
      normaliseGet(f.pathname + f.search);
    } catch {
      throw new Error(`navigation ended on a path that is not allowed: ${f.pathname}`);
    }
  };

  const ensureOnSite = async () => {
    let onSite = false;
    try {
      onSite = new URL(page.url()).host === HOST;
    } catch {}
    if (!onSite) await navigate('/orders');
  };

  const send = async (req: InPageRequest): Promise<unknown> => {
    await ensureOnSite();
    const r = await page.evaluate(async (rq: InPageRequest): Promise<InPageResult> => {
      try {
        const init: RequestInit = {
          credentials: 'same-origin',
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
          headers: { 'ecom-request-source-version': '2.0.0' },
        };
        if (rq.body !== undefined) {
          // CSRF token is read here at call time and never leaves the page.
          const token = (window as any).__INITIAL_STATE__?.session?.csrf?.token;
          if (typeof token !== 'string' || !token) return { kind: 'nocsrf' };
          init.method = 'POST';
          init.headers = {
            'content-type': 'application/json',
            'x-csrf-token': token,
            'ecom-request-source': 'web',
            'ecom-request-source-version': '2.0.0',
          };
          init.body = JSON.stringify(rq.body);
        }
        const res = await fetch(rq.url, init);
        if (res.type === 'opaqueredirect' || res.redirected) return { kind: 'redirect' };
        return { kind: 'ok', status: res.status, url: res.url, text: await res.text() };
      } catch (e) {
        return { kind: (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'neterror' };
      }
    }, req);
    if (r.kind === 'nocsrf') throw new LoginRequired('no CSRF token in page state: session not logged in');
    if (r.kind === 'redirect') {
      throw new LoginRequired('request was redirected and not followed (target unknown, most likely login)');
    }
    if (r.kind === 'neterror') throw new Error('request failed in page');
    if (r.kind === 'timeout') throw new Error('request timed out after 30 s');
    classifyResponse(r.status, r.url);
    if (r.status < 200 || r.status >= 300) throw new Error(`unexpected HTTP ${r.status}`);
    try {
      return JSON.parse(r.text);
    } catch {
      throw new ShapeError('response was not JSON'); // the parser's message can quote the body
    }
  };

  return {
    async getJson(path) {
      return send({ url: normaliseGet(path) });
    },

    async graphql(operationName, query, variables) {
      assertGraphqlOperation(operationName, query);
      assertAllowed('/graphql');
      return checkGraphql(await send({ url: '/graphql', body: { operationName, query, variables } }));
    },

    async pageState(path) {
      await navigate(path);
      const state = (await page.evaluate((_: null) => {
        const raw = (window as any).__INITIAL_STATE__;
        if (raw === undefined || raw === null) return null;
        const copy = JSON.parse(JSON.stringify(raw));
        if (copy?.session) delete copy.session.csrf; // token never leaves the page
        return copy;
      }, null)) as any;
      const pathname = new URL(path, ORIGIN).pathname;
      if (/^\/orders(\/|$)/.test(pathname) && state?.session?.isLoggedIn === false) throw new LoginRequired();
      return state;
    },

    async pageLinks(path, prefix) {
      if (!prefix.startsWith('/') || prefix.startsWith('//')) throw new Error(`bad link prefix: ${prefix}`);
      await navigate(path);
      // Only strings that are same-origin pathname+search and start with prefix leave the page.
      const links = (await page.evaluate((pre: string) => {
        const out: string[] = [];
        for (const a of Array.from(document.querySelectorAll('a[href]'))) {
          try {
            const u = new URL((a as HTMLAnchorElement).href, window.location.href);
            const v = u.pathname + u.search;
            if (u.origin === window.location.origin && v.startsWith(pre)) out.push(v);
          } catch {}
        }
        return out;
      }, prefix)) as unknown;
      if (!Array.isArray(links) || links.some((l) => typeof l !== 'string')) {
        throw new ShapeError('page links have an unexpected shape');
      }
      return links as string[];
    },

    close: closeFn,
    async waitForLogin() {
      let closed = false;
      void waitForCloseFn().then(() => (closed = true));
      await new Promise((r) => setTimeout(r)); // an already closed window is seen before the first look
      while (!closed) {
        try {
          if (new URL(page.url()).host === HOST) {
            const loggedIn = await page.evaluate(() => (window as any).__INITIAL_STATE__?.session?.isLoggedIn === true, undefined);
            if (loggedIn) return true;
          }
        } catch {} // the user's own navigation can interrupt a look; the next one retries
        await new Promise((r) => setTimeout(r, loginPollMs));
      }
      return false;
    },
  };
}

/**
 * Chromium keeps session cookies across restarts only with "continue where you left off" (1) set.
 * The login then stays in the profile; the harness itself still never reads cookies.
 */
export function keepSessionOnRestart(prefsFile: string): void {
  if (!existsSync(prefsFile)) return;
  const prefs = JSON.parse(readFileSync(prefsFile, 'utf8'));
  if (prefs.session?.restore_on_startup === 1) return;
  prefs.session = { ...prefs.session, restore_on_startup: 1 };
  writeFileSync(prefsFile, JSON.stringify(prefs));
}

export interface SessionCookie {
  name: string;
  value: string;
}

export function saveCookies(file: string, cookies: SessionCookie[]): void {
  writeFileSync(file, JSON.stringify(cookies.map(({ name, value }) => ({ name, value }))), { mode: 0o600 });
  chmodSync(file, 0o600); // the mode above only applies when the file is created
}

/** The only browser step left: the user logs in (or is still logged in) and the session is saved to sessionFile. */
export async function browserLogin(sessionFile: string): Promise<boolean> {
  let context: BrowserContext;
  try {
    if (!existsSync(join(PROFILE, 'SingletonLock'))) keepSessionOnRestart(join(PROFILE, 'Default', 'Preferences'));
    context = await chromium.launchPersistentContext(PROFILE, { executablePath: EXECUTABLE, headless: false, chromiumSandbox: true });
  } catch (err) {
    throw mapLaunchError(err);
  }
  const closed = whenClosed(context);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(new URL('/orders', ORIGIN).toString()).catch(() => {}); // a login redirect is expected here
  const worker = createWorker(page as unknown as PageLike, () => context.close(), () => closed);
  const loggedIn = await worker.waitForLogin();
  if (loggedIn) saveCookies(sessionFile, await context.cookies(ORIGIN));
  await worker.close();
  return loggedIn;
}

export async function openWorker(): Promise<Worker> {
  let context: BrowserContext;
  try {
    if (!existsSync(join(PROFILE, 'SingletonLock'))) keepSessionOnRestart(join(PROFILE, 'Default', 'Preferences'));
    context = await chromium.launchPersistentContext(PROFILE, { executablePath: EXECUTABLE, headless: false, chromiumSandbox: true });
  } catch (err) {
    throw mapLaunchError(err);
  }
  const closed = whenClosed(context);
  const page = context.pages()[0] ?? (await context.newPage());
  return createWorker(page as unknown as PageLike, () => context.close(), () => closed);
}
