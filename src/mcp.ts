import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openStore, type Store, type SyncKind } from './store.ts';
import { DB_PATH } from './dbpath.ts';

// Read-only: this file must never import the worker or anything that can reach Auchan.

const NEED_SYNC = 'No data yet: run npm run sync first.';

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const json = (v: unknown) => text(JSON.stringify(v, null, 2));

/** Opens the store read-only for one call. Missing file or no successful sync gives the run-sync hint. */
function withData(dbPath: string, kind: SyncKind, fn: (store: Store, freshness: { lastSyncAt: string; ageHours: number }) => unknown) {
  if (!existsSync(dbPath)) return text(NEED_SYNC);
  let store: Store | undefined;
  try {
    store = openStore(dbPath, { readOnly: true });
    const lastSyncAt = store.lastSyncFinishedAt(kind);
    if (!lastSyncAt) return text(NEED_SYNC);
    const ageHours = Math.round(((Date.now() - Date.parse(lastSyncAt)) / 3_600_000) * 10) / 10;
    return json(fn(store, { lastSyncAt, ageHours }));
  } catch (e) {
    // Busy, corrupt, unreadable or mismatched database: say so, do not suggest a sync.
    return { isError: true, content: [{ type: 'text' as const, text: `Database error: ${e instanceof Error ? e.message : String(e)}` }] };
  } finally {
    store?.close();
  }
}

export function createServer(dbPath: string = DB_PATH): McpServer {
  const server = new McpServer({ name: 'auchan-data', version: '1.0.0' });

  server.registerTool(
    'recent_orders',
    {
      description: 'Most recent completed Auchan orders (date, total in grosze, line count) from the local sync. Includes how old the data is.',
      inputSchema: { limit: z.number().int().min(1).max(100).default(10) },
    },
    ({ limit }) =>
      withData(dbPath, 'orders', (s, fresh) => ({
        ...fresh,
        orders: s.recentOrders(limit).map((o) => ({
          orderId: o.orderId, deliveredAt: o.deliveredAt, totalGrosze: o.totalGrosze, lineCount: o.lineCount,
        })),
      })),
  );

  server.registerTool(
    'product_history',
    {
      description: 'Products whose name contains the query: how often ordered, when last, and the last price paid (grosze).',
      inputSchema: { query: z.string().min(1).max(100) },
    },
    ({ query }) => withData(dbPath, 'orders', (s, fresh) => ({ ...fresh, products: s.productHistory(query) })),
  );

  server.registerTool(
    'current_promotions',
    {
      description: 'Promotions seen in the latest promotions sync, optionally only products bought before. Includes how old the data is.',
      inputSchema: { bought_before: z.boolean().default(false), limit: z.number().int().min(1).max(200).default(50) },
    },
    ({ bought_before, limit }) =>
      withData(dbPath, 'promotions', (s, fresh) => ({
        ...fresh,
        promotions: s.currentPromotions({ boughtBefore: bought_before, limit }),
      })),
  );

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await createServer().connect(new StdioServerTransport());
}
