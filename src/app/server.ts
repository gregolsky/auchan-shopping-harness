import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { liveDeps as syncDeps } from '../cli.ts';
import { liveDeps as fillDeps } from '../fill-cli.ts';
import { realSpawn } from './claude.ts';
import { createService } from './service.ts';
import type { AppEvent } from './service.ts';

const MAX_BODY = 64 * 1024;
const PING_MS = 25_000;
const HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
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
  '/api/answer': post((s, b) => {
    if (b.productId !== null && typeof b.productId !== 'string') throw bad();
    return s.answer(key(b.lineKey), b.productId === null ? null : key(b.productId));
  }),
  '/api/line': post((s, b) => {
    const lineKey = key(b.lineKey);
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

export function createAppServer(o: { service: AppService; token: string; publicDir: string; broadcaster: Broadcaster }): http.Server {
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
    const base = `http://127.0.0.1:${port}`;
    if (req.headers.host !== `127.0.0.1:${port}`) return json(403, { error: 'Brak dostępu' });
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Niedozwolona metoda' });
    const url = new URL(req.url ?? '/', base);
    const stat = req.method === 'GET' ? STATIC[url.pathname] : undefined;
    const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
    const fromQuery = stat !== undefined || route?.query === true;
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

export async function main(): Promise<void> {
  const token = randomBytes(16).toString('hex');
  const broadcaster = createBroadcaster();
  const service = createService({
    openStore: syncDeps.openStore,
    spawn: realSpawn,
    fillDeps,
    syncDeps,
    tripFile: '.state/trip.json',
    now: () => new Date(),
    emit: broadcaster.emit,
  });
  const publicDir = fileURLToPath(new URL('../../public', import.meta.url));
  const server = createAppServer({ service, token, publicDir, broadcaster });
  const requested = process.env.APP_PORT;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requested ? Number(requested) : 0, '127.0.0.1', resolve);
  });
  console.log(`Zakupy: http://127.0.0.1:${(server.address() as AddressInfo).port}/?t=${token}`);
  const stop = createStop(service, server);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
