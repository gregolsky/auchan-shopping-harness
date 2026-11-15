import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// PreToolUse hook: while `npm run fill` holds the lock, the browser profile is not ours to touch.
const lock = process.env.FILL_LOCK_FILE ?? fileURLToPath(new URL('../.state/fill.lock', import.meta.url));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

if (existsSync(lock)) {
  const pid = Number.parseInt(readFileSync(lock, 'utf8'), 10);
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    console.error('cart fill in progress: browser tools are blocked');
    process.exit(2);
  }
}
