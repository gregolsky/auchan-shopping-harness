import { LOCK_PATH } from '../src/dbpath.ts';
import { lockHeld } from '../src/lock.ts';

// PreToolUse hook: while `npm run fill` holds the lock, the browser profile is not ours to touch.
if (lockHeld(process.env.FILL_LOCK_FILE ?? LOCK_PATH)) {
  console.error('cart fill in progress: browser tools are blocked');
  process.exit(2);
}
