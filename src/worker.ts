import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
/** Auchan refused a cart change (or several); the fill stopped. Carries the product, for the message to the user. */
export class Refused extends Blocked {
  productId: string;
  productName: string;
  constructor(productId: string, productName: string) {
    super('Auchan refused several cart changes; stopping');
    this.name = 'Refused';
    this.productId = productId;
    this.productName = productName;
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

export const CART_READ_PATH = '/api/cart/v1/carts/active';
export const APPLY_QUANTITY_PATH = '/api/cart/v1/carts/active/apply-quantity';

// Anchored, matched against the normalised pathname only.
export const ALLOWED_PATHS: readonly RegExp[] = [
  /^\/orders$/,
  /^\/promotions$/,
  /^\/promotions\/[^/]+\/\d+$/,
  /^\/api\/order\/v6\/orders\/[\w-]+\/decorated$/,
  /^\/graphql$/,
  /^\/api\/cart\/v1\/carts\/active$/, // read only; apply-quantity is built by the HTTP worker, never allowlisted
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

/** The slice of Playwright's Page the login watcher uses; lets tests supply a fake. */
export interface PageLike {
  url(): string;
  evaluate<A, R>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/** Subscribe as soon as the context exists, so a window closed before anyone waits is not missed. */
export function whenClosed(context: { once(event: 'close', listener: () => void): unknown }): Promise<void> {
  return new Promise((resolve) => context.once('close', () => resolve()));
}

/** How long a login window may stay open without a login before the wait gives up. */
export const LOGIN_TIMEOUT_MS = 3_600_000;

/** Watches the open login window without navigating it. */
export function createLoginWatcher(
  page: PageLike,
  closeFn: () => Promise<void> = async () => {},
  waitForCloseFn: () => Promise<void> = async () => {},
  loginPollMs = 3000,
  timeoutMs = LOGIN_TIMEOUT_MS,
): { waitForLogin(): Promise<boolean>; close(): Promise<void> } {
  return {
    close: closeFn,
    async waitForLogin() {
      const deadline = Date.now() + timeoutMs;
      let closed = false;
      void waitForCloseFn().then(() => (closed = true));
      await new Promise((r) => setTimeout(r)); // an already closed window is seen before the first look
      while (!closed && Date.now() < deadline) {
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

/** Written to a new file beside the target and renamed over it, so a symlink at the target is replaced, never followed. */
export function saveCookies(file: string, cookies: SessionCookie[]): void {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(cookies.map(({ name, value }) => ({ name, value }))), { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
}

/** Opens the dedicated, logged-in profile in a visible, sandboxed Chromium. */
export async function launchProfile(): Promise<BrowserContext> {
  try {
    if (!existsSync(join(PROFILE, 'SingletonLock'))) keepSessionOnRestart(join(PROFILE, 'Default', 'Preferences'));
    return await chromium.launchPersistentContext(PROFILE, { executablePath: EXECUTABLE, headless: false, chromiumSandbox: true });
  } catch (err) {
    throw mapLaunchError(err);
  }
}

/** The only browser step left: the user logs in (or is still logged in) and the session is saved to sessionFile. */
export async function browserLogin(sessionFile: string): Promise<boolean> {
  const context = await launchProfile();
  const closed = whenClosed(context);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(new URL('/orders', ORIGIN).toString()).catch(() => {}); // a login redirect is expected here
  const watcher = createLoginWatcher(page as unknown as PageLike, () => context.close(), () => closed);
  const loggedIn = await watcher.waitForLogin();
  if (loggedIn) saveCookies(sessionFile, await context.cookies(ORIGIN));
  await watcher.close();
  return loggedIn;
}
