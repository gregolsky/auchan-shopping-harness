import { fileURLToPath } from 'node:url';

/** Resolved from this file, not the working directory: Claude Code may start the MCP server from anywhere. */
export const DB_PATH = fileURLToPath(new URL('../.state/harness.db', import.meta.url));
export const SESSION_PATH = fileURLToPath(new URL('../.state/session.json', import.meta.url));
export const LOCK_PATH = fileURLToPath(new URL('../.state/fill.lock', import.meta.url));
