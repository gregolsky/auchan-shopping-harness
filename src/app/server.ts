import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import qrcode from 'qrcode-generator';
import { liveDeps as syncDeps } from '../cli.ts';
import { liveDeps as fillDeps } from '../fill-cli.ts';
import { openSearchPage } from '../search-browser.ts';
import { realSpawn } from './claude.ts';
import { createService } from './service.ts';
import type { AppEvent } from './service.ts';

const MAX_BODY = 64 * 1024;
const PING_MS = 25_000;
const HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' https://zakupy.auchan.pl; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/theme.js': { file: 'theme.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/icon.svg': { file: 'icon.svg', type: 'image/svg+xml' },
  '/shopping.svg': { file: 'shopping.svg', type: 'image/svg+xml' },
};

export type AppService = ReturnType<typeof createService>;

export interface Broadcaster {
  subscribe(fn: (e: AppEvent) => void): () => void;
  emit(e: AppEvent): void;
  size(): number;
}

export function createBroadcaster(): Broadcaster {
  const subs = new Set<(e: AppEvent) => void>();
  return {
    subscribe(fn) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    emit(e) {
      for (const fn of [...subs]) fn(e);
    },
    size: () => subs.size,
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const bad = () => new HttpError(400, 'Niepoprawne dane');

type Body = Record<string, unknown>;
const str = (v: unknown, max: number, min = 1): string => {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad();
  return v;
};
const key = (v: unknown) => str(v, 200);
const qty = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 20) throw bad();
  return v;
};

interface Route {
  get?: boolean;
  /** `query`: token comes from `?t=`; otherwise from the x-app-token header. */
  query?: boolean;
  run(s: AppService, b: Body): unknown;
}

const post = (run: Route['run']): Route => ({ run });
const ROUTES: Record<string, Route> = {
  '/api/state': { get: true, run: (s) => s.state() },
  '/api/rules': { get: true, run: (s) => s.rules() },
  '/api/blocked': { get: true, run: (s) => s.blockedProducts() },
  '/api/blocked/search': post((s, b) => s.searchProducts(str(b.query, 100, 2))),
  '/api/blocked/add': post((s, b) => {
    if (!s.blockProduct(key(b.productId))) throw new HttpError(409, 'Poczekaj na zakończenie trwającej operacji.');
    return { changed: true };
  }),
  '/api/blocked/remove': post((s, b) => {
    if (!s.unblockProduct(key(b.productId))) throw new HttpError(409, 'Poczekaj na zakończenie trwającej operacji.');
    return { changed: true };
  }),
  '/api/sync': post((s) => s.sync()),
  '/api/search': post((s, b) => {
    let terms: string[] | undefined;
    if (b.terms !== undefined) {
      if (!Array.isArray(b.terms) || b.terms.length > 10) throw bad();
      terms = b.terms.map((t) => str(t, 100));
    }
    if (b.force !== undefined && typeof b.force !== 'boolean') throw bad();
    return s.searchAuchan(terms, { force: b.force === true });
  }),
  '/api/note': post((s, b) => {
    const note = str(b.note, 10_000, 0);
    if (typeof b.includeUsual !== 'boolean') throw bad();
    const input: { note: string; includeUsual: boolean; budgetGrosze?: number } = { note, includeUsual: b.includeUsual };
    if (b.budgetGrosze !== undefined) {
      if (typeof b.budgetGrosze !== 'number' || !Number.isInteger(b.budgetGrosze) || b.budgetGrosze < 0 || b.budgetGrosze > 100_000_000) throw bad();
      input.budgetGrosze = b.budgetGrosze;
    }
    return s.note(input);
  }),
  '/api/ask': post((s, b) => s.ask(str(b.text, 2000))),
  '/api/apply': post((s, b) => s.apply(key(b.proposalId))),
  '/api/reject': post((s, b) => s.reject(key(b.proposalId))),
  '/api/proposal/op': post((s, b) => {
    if (typeof b.index !== 'number' || !Number.isInteger(b.index) || b.index < 0 || b.index > 1000 || typeof b.accept !== 'boolean') throw bad();
    return s.proposalOp(key(b.proposalId), b.index, b.accept);
  }),
  '/api/unmatched/remove': post((s, b) => s.dropUnmatched(str(b.term, 200))),
  '/api/answer': post((s, b) => {
    if (b.productId !== null && typeof b.productId !== 'string') throw bad();
    return s.answer(key(b.lineKey), b.productId === null ? null : key(b.productId));
  }),
  '/api/line/by-hand': post((s, b) => s.addByHand(key(b.lineKey))),
  '/api/line': post((s, b) => {
    const lineKey = key(b.lineKey);
    if (b.productId !== undefined) {
      if (Object.keys(b).length !== 2) throw bad();
      return s.chooseProduct(lineKey, key(b.productId));
    }
    const change: { quantity?: number; remove?: true; included?: boolean } = {};
    if (b.quantity !== undefined) change.quantity = qty(b.quantity);
    if (b.remove !== undefined) {
      if (b.remove !== true) throw bad();
      change.remove = true;
    }
    if (b.included !== undefined) {
      if (typeof b.included !== 'boolean') throw bad();
      change.included = b.included;
    }
    if (Object.keys(change).length === 0) throw bad();
    return s.line(lineKey, change);
  }),
  '/api/approve': post((s) => s.approve()),
  '/api/rules/delete': post((s, b) => {
    s.deleteRule(str(b.term, 200));
    return {};
  }),
  '/api/rules/brand': post((s, b) => {
    if (b.brand !== null) throw bad();
    s.clearBrand(str(b.term, 200));
    return {};
  }),
  '/api/trip/reset': post((s) => s.reset()),
  '/api/events': { get: true, query: true, run: () => undefined },
};

function sameToken(given: string | null | undefined, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c); // keep draining an oversized body so the 413 can be delivered
    });
    req.on('error', reject);
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'Za duże żądanie'));
      if (type !== 'application/json') return reject(bad());
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return resolve({});
      try {
        const v: unknown = JSON.parse(text);
        if (typeof v !== 'object' || v === null || Array.isArray(v)) return reject(bad());
        resolve(v as Body);
      } catch {
        reject(bad());
      }
    });
  });
}

/** Private IPv4 addresses of this machine: the ones a phone on the same Wi-Fi can reach. */
export function lanAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  return Object.values(ifaces).flat().filter((a) => a !== undefined && a.family === 'IPv4' && !a.internal && priv.test(a.address)).map((a) => a!.address);
}

function qrCode(text: string) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  return q;
}
/** The QR code of text as a self-contained, scalable SVG. */
export const qrSvg = (text: string): string => qrCode(text).createSvgTag({ cellSize: 4, margin: 4, scalable: true });
/** The QR code of text drawn with block characters, for the terminal. */
export const qrTerminal = (text: string): string => qrCode(text).createASCII(1, 2);

/**
 * lanHosts: this machine's LAN addresses the page may also be opened on (a phone on the same Wi-Fi).
 * The token stays the guard; the Host and Origin checks still stop DNS rebinding and other sites.
 */
export function createAppServer(o: { service: AppService; token: string; publicDir: string; broadcaster: Broadcaster; lanHosts?: string[] }): http.Server {
  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
    const json = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    };
    const fail = (e: unknown) => {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error('Błąd aplikacji:', e instanceof Error ? e.name : 'unknown'); // never the message or a request body
      json(500, { error: 'Błąd aplikacji' });
    };
    void handle(req, res, json).catch(fail);
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse, json: (s: number, b: unknown) => void): Promise<void> {
    const port = (server.address() as AddressInfo | null)?.port;
    const hosts = ['127.0.0.1', ...(o.lanHosts ?? [])].map((h) => `${h}:${port}`);
    const host = req.headers.host;
    if (host === undefined || !hosts.includes(host)) return json(403, { error: 'Brak dostępu' });
    const base = `http://${host}`;
    const phoneUrl = o.lanHosts?.length ? `http://${o.lanHosts[0]}:${port}/?t=${o.token}` : null;
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Niedozwolona metoda' });
    const url = new URL(req.url ?? '/', base);
    const stat = req.method === 'GET' ? STATIC[url.pathname] : undefined;
    const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
    const phone = req.method === 'GET' && (url.pathname === '/api/phone' || url.pathname === '/phone-qr.svg');
    const fromQuery = stat !== undefined || phone || route?.query === true;
    const given = fromQuery ? url.searchParams.get('t') : (req.headers['x-app-token'] as string | undefined);
    if (!sameToken(given, o.token)) return json(403, { error: 'Brak dostępu' });

    if (stat) {
      let data: Buffer;
      try {
        data = readFileSync(join(o.publicDir, stat.file));
      } catch {
        return json(404, { error: 'Nie znaleziono' });
      }
      const content = url.pathname === '/' ? Buffer.from(data.toString('utf8').replaceAll('__APP_TOKEN__', o.token)) : data;
      res.writeHead(200, { 'Content-Type': stat.type, 'Content-Length': content.length });
      return void res.end(content);
    }
    if (url.pathname === '/api/phone' && phone) return json(200, { url: phoneUrl });
    if (url.pathname === '/phone-qr.svg' && phone) {
      if (phoneUrl === null) return json(404, { error: 'Nie znaleziono' });
      const svg = Buffer.from(qrSvg(phoneUrl));
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': svg.length });
      return void res.end(svg);
    }
    if (!route) return json(404, { error: 'Nie znaleziono' });
    if ((req.method === 'GET') !== (route.get === true)) return json(405, { error: 'Niedozwolona metoda' });

    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const ok = origin !== undefined ? origin === base : req.headers['sec-fetch-site'] === 'same-origin';
      if (!ok) return json(403, { error: 'Brak dostępu' });
    }
    if (url.pathname === '/api/events') return stream(req, res);
    const body = req.method === 'POST' ? await readBody(req) : {};
    json(200, await route.run(o.service, body) ?? {});
  }

  function stream(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    const off = o.broadcaster.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    ping.unref();
    const done = () => {
      clearInterval(ping);
      off();
    };
    req.on('close', done);
    res.on('close', done);
  }

  return server;
}

/** What the app does when it is killed: stop a running fill cleanly, close the server, exit. */
export function createStop(service: Pick<AppService, 'shutdown'>, server: http.Server, exit: (code: number) => void = (code) => process.exit(code)): () => void {
  return () => {
    service.shutdown();
    server.close(() => exit(0));
    server.closeAllConnections();
  };
}

export const DEFAULT_PORT = 47474;
const TOKEN_RE = /^[0-9a-f]{32}$/;

/** The page token survives restarts so the URL can be bookmarked; owner-only file, replaced if damaged. A symlink at the path is never followed. */
export function loadOrCreateToken(file: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const saved = readFileSync(fd, 'utf8').trim();
    if (TOKEN_RE.test(saved)) {
      if ((fstatSync(fd).mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      return saved;
    }
  } catch { /* missing, a symlink or unreadable: make a new one */ } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const token = randomBytes(16).toString('hex');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // A new file beside the path, renamed over it: a symlink at the path is replaced, not written through.
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, token + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch (e) {
    rmSync(temp, { force: true });
    throw e;
  }
  return token;
}

export function appPort(env: Record<string, string | undefined>): number {
  const n = Number(env.APP_PORT);
  return env.APP_PORT !== undefined && env.APP_PORT.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : DEFAULT_PORT;
}

export const portBusyMessage = (port: number, url: string): string =>
  `Port ${port} jest zajęty — aplikacja już działa pod: ${url} (albo port zajmuje inny program)`;

export async function main(): Promise<void> {
  const token = loadOrCreateToken('.state/app-token');
  const port = appPort(process.env);
  const url = (p: number) => `http://127.0.0.1:${p}/?t=${token}`;
  const broadcaster = createBroadcaster();
  const service = createService({
    openStore: syncDeps.openStore,
    spawn: realSpawn,
    fillDeps,
    syncDeps,
    tripFile: '.state/trip.json',
    now: () => new Date(),
    emit: broadcaster.emit,
    openSearchPage,
  });
  const publicDir = fileURLToPath(new URL('../../public', import.meta.url));
  // shortcut: LAN addresses are read once at start; restart the app after changing networks.
  const lanHosts = lanAddresses();
  const server = createAppServer({ service, token, publicDir, broadcaster, lanHosts });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, lanHosts.length > 0 ? '0.0.0.0' : '127.0.0.1', resolve);
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
    // Another copy already serves this port: one app at a time, so just point at it.
    console.log(portBusyMessage(port, url(port)));
    service.shutdown();
    process.exit(0);
  }
  service.recover();
  const bound = (server.address() as AddressInfo).port;
  console.log(`Zakupy: ${url(bound)}`);
  if (lanHosts.length > 0) {
    const phone = `http://${lanHosts[0]}:${bound}/?t=${token}`;
    console.log(`Na telefonie (ta sama sieć Wi-Fi): ${phone}\n${qrTerminal(phone)}`);
  }
  const stop = createStop(service, server);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
