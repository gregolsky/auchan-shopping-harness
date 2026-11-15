import { existsSync } from 'node:fs';
import { LOCK_PATH } from '../src/dbpath.ts';
import { lockHeld } from '../src/lock.ts';

// PreToolUse hook: while `npm run fill` holds the lock, the browser profile is not ours to touch.
// The path is fixed; only the test passes another one, as the first argument. If anything goes wrong while a lock exists, block.
const file = process.argv[2] ?? LOCK_PATH;
let blocked: boolean;
try {
  blocked = lockHeld(file);
} catch {
  blocked = existsSync(file);
}
if (blocked) {
  console.error('cart fill in progress: browser tools are blocked');
  process.exit(2);
}
