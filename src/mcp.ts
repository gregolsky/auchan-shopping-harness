import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openStore, type Store, type SyncKind } from './store.ts';
import { DB_PATH } from './dbpath.ts';
import { buildDraft } from './draft.ts';

// This file must never import the worker or anything that can reach Auchan. Only the planner write tools open the store writable.

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

const DB_ERROR = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: `Database error: ${e instanceof Error ? e.message : String(e)}` }] });
const fail = (msg: string) => ({ isError: true, content: [{ type: 'text' as const, text: msg }] });
const NEVER_AUCHAN = ' Money is in grosze (1 zł = 100 grosze). Reads only the local database; never contacts Auchan.';

/** Opens the store writable for one call. A missing file is never created. */
function withWritable(dbPath: string, fn: (store: Store) => unknown) {
  if (!existsSync(dbPath)) return text(NEED_SYNC);
  let store: Store | undefined;
  try {
    store = openStore(dbPath);
    return json(fn(store));
  } catch (e) {
    return DB_ERROR(e);
  } finally {
    store?.close();
  }
}

/** Opens writable once so the planner tables exist, since the read-only connection cannot create them. */
function ensureSchema(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  try { openStore(dbPath).close(); return true; } catch { return false; /* the read path reports it */ }
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

  let schemaReady = false;
  const ready = () => { if (!schemaReady) schemaReady = ensureSchema(dbPath); };

  server.registerTool(
    'draft_basket',
    {
      description: 'Builds a draft basket from shopping terms using order history, promotions and learned preferences. Returns groups (items, stockUps, promotions, addOns), unmatched terms, totals in grosze, and when orders (lastSyncAt) and promotions (promotionsLastSyncAt) were last synced; budget is only a warning. Does not fill any cart.' + NEVER_AUCHAN,
      inputSchema: {
        items: z.array(z.object({ term: z.string().min(1).max(100), quantity: z.number().min(0.01).max(100).default(1) })).max(100),
        includeUsual: z.boolean().default(false),
        budgetGrosze: z.number().int().min(0).optional(),
      },
    },
    ({ items, includeUsual, budgetGrosze }) => {
      ready();
      return withData(dbPath, 'orders', (s, fresh) => ({
        ...fresh,
        promotionsLastSyncAt: s.lastSyncFinishedAt('promotions'),
        ...buildDraft({ items, includeUsual, budgetGrosze }, s.productFacts(), s.intentRules(), new Date()),
      }));
    },
  );

  server.registerTool(
    'record_correction',
    {
      description: 'Records that the user changed a draft line for a term, so later drafts learn it. Needs a term and proposedProductId and/or chosenProductId (omit chosen to record a removal). Writes the local database only.' + NEVER_AUCHAN,
      inputSchema: {
        term: z.string().min(1).max(100),
        proposedProductId: z.string().min(1).max(100).optional(),
        chosenProductId: z.string().min(1).max(100).optional(),
        reason: z.string().max(300).optional(),
      },
    },
    ({ term, proposedProductId, chosenProductId, reason }) => {
      if (!proposedProductId && !chosenProductId) return fail('Give proposedProductId or chosenProductId.');
      return withWritable(dbPath, (s) => {
        try {
          s.recordCorrection({ term, proposedProductId: proposedProductId ?? null, chosenProductId: chosenProductId ?? null, reason });
        } catch (e) {
          if (chosenProductId && /FOREIGN KEY/i.test(String(e))) throw new Error('Unknown chosenProductId: no such product in the local data.');
          throw e;
        }
        return { ok: true };
      });
    },
  );

  server.registerTool(
    'list_rules',
    {
      description: 'Lists learned term rules (fixed brand; preferred, accepted, learned and replaced product ids). Includes how old the synced data is.' + NEVER_AUCHAN,
      inputSchema: {},
    },
    () => { ready(); return withData(dbPath, 'orders', (s, fresh) => ({ ...fresh, rules: s.intentRules() })); },
  );

  server.registerTool(
    'set_brand',
    {
      description: 'Limits a term to one brand in later drafts; a null brand frees it. Call when the user names a brand, or with null when the user swaps across a fixed brand. Writes the local database only.' + NEVER_AUCHAN,
      inputSchema: { term: z.string().min(1).max(100), brand: z.string().min(1).max(100).nullable() },
    },
    ({ term, brand }) => withWritable(dbPath, (s) => { s.setBrandFixed(term, brand); return { ok: true }; }),
  );

  server.registerTool(
    'delete_rule',
    {
      description: 'Forgets the learned rule for a term; the correction history is kept. Writes the local database only.' + NEVER_AUCHAN,
      inputSchema: { term: z.string().min(1).max(100) },
    },
    ({ term }) => withWritable(dbPath, (s) => { s.deleteRule(term); return { ok: true }; }),
  );

  server.registerTool(
    'approve_basket',
    {
      description: 'Saves the approved basket (lines with term, productId, quantity) in the local database at the products\' latest prices; returns basketId and totalGrosze. Fails naming the product id if one is unknown or out of the catalogue, and then stores nothing. Does not touch the Auchan cart; npm run fill does that. Writes the local database only and never contacts Auchan. Money is in grosze (1 zł = 100 grosze).',
      inputSchema: {
        lines: z.array(z.object({
          term: z.string().min(1).max(100).nullable(),
          productId: z.string().min(1).max(100),
          quantity: z.number().min(0.01).max(100),
        })).min(1).max(150),
        unmatched: z.array(z.string().max(100)).max(100).default([]),
      },
    },
    ({ lines, unmatched }) => withWritable(dbPath, (s) => s.approveBasket(lines, unmatched)),
  );

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await createServer().connect(new StdioServerTransport());
}
