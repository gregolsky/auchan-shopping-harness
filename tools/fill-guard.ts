import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// PreToolUse hook: while `npm run fill` holds the lock, the browser profile is not ours to touch.
// The path is fixed; only the test passes another one, as the first argument.
// Fails closed: any crash (an import error included) while a lock file exists blocks, exit 2.
const file = process.argv[2] ?? fileURLToPath(new URL('../.state/fill.lock', import.meta.url));
try {
  const { lockHeld } = await import('../src/lock.ts');
  if (lockHeld(file)) {
    console.error('cart fill in progress: browser tools are blocked');
    process.exit(2);
  }
} catch {
  let present = true; // when even the check breaks, assume the lock is there
  try { present = existsSync(file); } catch { /* keep blocking */ }
  if (present) {
    console.error('cart fill in progress: browser tools are blocked');
    process.exit(2);
  }
}
