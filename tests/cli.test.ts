import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, main, type Deps } from '../src/cli.ts';
import { openStore, type Store } from '../src/store.ts';
import { Blocked, LoginRequired, type Worker } from '../src/worker.ts';
import { parseDecoratedOrder, ShapeError } from '../src/parse.ts';
import { readFileSync } from 'node:fs';

const page = (ids: string[]) => ({
  data: { customer: { ordersCompleted: {
    pageInfo: { endCursor: null, hasNextPage: false },
    edges: ids.map((orderId) => ({ node: { orderId } })),
  } } },
});

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));
const promotions = fx('promotions-state.json');

function seedOrder(regionId: string) {
  return (s: Store) => {
    const parsed = parseDecoratedOrder(fx('order-decorated.json'));
    s.saveOrder({ ...parsed, order: { ...parsed.order, regionId } });
  };
}

function promotionsWorker(sessionRegion: string, seen: string[] = []): Partial<Worker> {
  return {
    async pageState(path) {
      seen.push(path);
      return { ...promotions, session: { metadata: { regionId: sessionRegion } } };
    },
    async pageLinks() {
      return ['/promotions/a/1'];
    },
  };
}

function setup(overrides: Partial<Worker> = {}, seed?: (s: Store) => void) {
  const log = { closed: 0, storeClosed: 0, waited: 0, requests: [] as string[], out: [] as string[], err: [] as string[] };
  const worker: Worker = {
    async graphql() {
      log.requests.push('graphql');
      return page([]);
    },
    async getJson(path) {
      log.requests.push(path);
      return {};
    },
    async pageState(path) {
      log.requests.push(path);
      return {};
    },
    async pageLinks() {
      return [];
    },
    async close() {
      log.closed++;
    },
    async waitForLogin() {
      log.waited++;
      return false;
    },
    ...overrides,
  };
  const store = openStore(':memory:');
  seed?.(store);
  const deps: Deps = {
    paceMs: 0,
    openWorker: async () => worker,
    openStore: () => ({
      ...store,
      close() {
        log.storeClosed++; // left open so a test can look at what was saved
      },
    }),
  };
  return { log, deps, store };
}

function quiet(t: { mock: { method: Function } }, log: { out: string[]; err: string[] }) {
  t.mock.method(console, 'log', (s: string) => void log.out.push(s));
  t.mock.method(console, 'error', (s: string) => void log.err.push(s));
}

test('a usage error returns 2 and opens nothing', async (t) => {
  const { log } = setup();
  quiet(t, log);
  let opened = 0;
  const code = await main(['nonsense'], { openWorker: async () => (opened++, null as never), openStore: () => (opened++, null as never) });
  assert.equal(code, 2);
  assert.equal(opened, 0);
  assert.match(log.err[0], /usage/);
});

const LOG_IN = 'Log in in the browser window and leave it open; the sync continues on its own';

test('LoginRequired keeps the window open and stops if it is closed without a login', async (t) => {
  let closedBeforeWait = false;
  let attempts = 0;
  const { log, deps } = setup({
    async graphql() {
      attempts++;
      throw new LoginRequired();
    },
    async waitForLogin() {
      closedBeforeWait = log.closed > 0;
      log.waited++;
      return false;
    },
  });
  quiet(t, log);
  assert.equal(await main(['orders'], deps), 1);
  assert.equal(log.waited, 1);
  assert.equal(attempts, 1);
  assert.equal(closedBeforeWait, false);
  assert.deepEqual(log.err, [LOG_IN]);
  assert.equal(log.closed, 1);
  assert.equal(log.storeClosed, 1);
});

test('after a login the work is retried once in the same window', async (t) => {
  let attempts = 0;
  const { log, deps } = setup({
    async graphql() {
      attempts++;
      throw new LoginRequired();
    },
    async waitForLogin() {
      log.waited++;
      return true;
    },
  });
  quiet(t, log);
  assert.equal(await main(['orders'], deps), 1);
  assert.equal(attempts, 2);
  assert.equal(log.waited, 1);
  assert.deepEqual(log.err, [LOG_IN, 'Auchan still reports no login: log in and rerun']);
  assert.equal(log.closed, 1);
});

test('after a login a Blocked retry stops with no further attempt', async (t) => {
  let attempts = 0;
  const { log, deps } = setup({
    async graphql() {
      attempts++;
      throw attempts === 1 ? new LoginRequired() : new Blocked('HTTP 403');
    },
    async waitForLogin() {
      return true;
    },
  });
  quiet(t, log);
  assert.equal(await main(['orders'], deps), 1);
  assert.equal(attempts, 2);
  assert.match(log.err[1], /Auchan refused the request/);
});

test('Blocked closes the browser without waiting and returns 1', async (t) => {
  const { log, deps } = setup({
    async graphql() {
      throw new Blocked('HTTP 403');
    },
  });
  quiet(t, log);
  assert.equal(await main(['orders'], deps), 1);
  assert.equal(log.waited, 0);
  assert.equal(log.closed, 1);
  assert.equal(log.storeClosed, 1);
});

test('the store is closed when the worker cannot open', async (t) => {
  const { log, deps } = setup();
  quiet(t, log);
  const code = await main(['orders'], {
    ...deps,
    openWorker: async () => {
      throw new Error('no browser');
    },
  });
  assert.equal(code, 1);
  assert.equal(log.storeClosed, 1);
});

test('a successful run closes the store and worker and returns 0', async (t) => {
  const { log, deps } = setup();
  quiet(t, log);
  assert.equal(await main(['orders'], deps), 0);
  assert.equal(log.waited, 0);
  assert.equal(log.closed, 1);
  assert.equal(log.storeClosed, 1);
});

test('a session region differing from the latest order is refused and nothing is saved', async (t) => {
  const seen: string[] = [];
  const { log: out, deps, store } = setup(promotionsWorker('session-region', seen), seedOrder('order-region'));
  quiet(t, out);
  assert.equal(await main(['promotions'], deps), 1);
  assert.equal(store.lastSyncStatus('promotions'), 'failed');
  assert.deepEqual(store.currentPromotions({ limit: 10 }), []);
  assert.deepEqual(seen, ['/promotions'], 'region is not read from the /orders session');
  assert.match(out.err[0], /region/);
});

test('promotions run when the session matches the latest order', async (t) => {
  const { log: out, deps } = setup(promotionsWorker('same'), seedOrder('same'));
  quiet(t, out);
  assert.equal(await main(['promotions'], deps), 0);
  assert.equal(out.closed, 1);
});

test('promotions with no stored order fail with the fixed message before any request', async (t) => {
  const seen: string[] = [];
  const { log: out, deps, store } = setup(promotionsWorker('any', seen));
  quiet(t, out);
  assert.equal(await main(['promotions'], deps), 1);
  assert.deepEqual(out.err, ['Sync orders first: promotions need your delivery region']);
  assert.deepEqual(seen, []);
  assert.equal(store.lastSyncStatus('promotions'), null);
  assert.equal(out.closed, 1);
  assert.equal(out.storeClosed, 1);
});

test('orders output prints the skip and substitute counts', async (t) => {
  const order = fx('order-decorated.json');
  const id = order.result;
  const grouped = order.entities.order[id].groupedProducts;
  grouped.products[0].quantity = 0;
  Object.assign(grouped, { substitutes: [{}], missings: [{}, {}], returns: [{}, {}, {}] });
  const { log, deps } = setup({ graphql: async () => page([id]), getJson: async () => order });
  quiet(t, log);
  assert.equal(await main(['orders'], deps), 0);
  assert.match(log.out[0], /zero-quantity lines 1, substitutes 1, missings 2, returns 3/);
});

function checkDeps(deps: Deps): Deps {
  return {
    ...deps,
    openStore() {
      throw new Error('check must not open the database');
    },
  };
}

test('check fetches one page and one order, prints ok with the page count, opens no database', async (t) => {
  const order = fx('order-decorated.json');
  const graphqlVars: unknown[] = [];
  const { log, deps } = setup({
    async graphql(_op, _query, variables) {
      graphqlVars.push(variables);
      return page([order.result, 'other-order']);
    },
    async getJson(path) {
      log.requests.push(path);
      return order;
    },
  });
  quiet(t, log);
  assert.equal(await main(['check'], checkDeps(deps)), 0);
  assert.equal(graphqlVars.length, 1);
  assert.deepEqual(log.requests, [`/api/order/v6/orders/${order.result}/decorated`]);
  assert.deepEqual(log.out, ['ok: 2 orders on the page']);
  assert.equal(log.closed, 1);
});

test('check says so when the page has no order to check', async (t) => {
  const { log, deps } = setup();
  quiet(t, log);
  assert.equal(await main(['check'], checkDeps(deps)), 0);
  assert.equal(log.requests.length, 1);
  assert.match(log.out[0], /^ok: 0 orders on the page/);
  assert.match(log.out[0], /no order/);
});

test('check stops at the first failure with the fixed Blocked message', async (t) => {
  const { log, deps } = setup({
    async graphql() {
      log.requests.push('graphql');
      throw new Blocked('HTTP 403');
    },
  });
  quiet(t, log);
  assert.equal(await main(['check'], checkDeps(deps)), 1);
  assert.deepEqual(log.requests, ['graphql']);
  assert.deepEqual(log.err, ['Auchan refused the request. Do not rerun; the request format may need review.']);
  assert.equal(log.closed, 1);
});

test('check fails on an order it cannot parse and leaks no response content', async (t) => {
  const { log, deps } = setup({
    graphql: async () => page(['1']),
    getJson: async () => ({ secret: 'leaky-content' }),
  });
  quiet(t, log);
  assert.equal(await main(['check'], checkDeps(deps)), 1);
  assert.equal(log.out.length, 0);
  assert.doesNotMatch(log.err[0], /leaky-content|secret/);
});

test('check waits for the window on LoginRequired', async (t) => {
  const { log, deps } = setup({
    async graphql() {
      throw new LoginRequired();
    },
  });
  quiet(t, log);
  assert.equal(await main(['check'], checkDeps(deps)), 1);
  assert.equal(log.waited, 1);
});

test('describeFailure output carries no control or bidi characters', () => {
  const dirty = 'boom\u001b]52;c;ZXZpbA==\u0007\u202e';
  assert.doesNotMatch(describeFailure(new Error(dirty)), /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  assert.doesNotMatch(describeFailure(new ShapeError(dirty)), /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  assert.match(describeFailure(new Error(dirty), 'fill'), /boom/);
});
