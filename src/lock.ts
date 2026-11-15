import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A lock older than this is stale whatever its pid says: the pid may have been reused after a reboot. */
export const LOCK_MAX_AGE_MS = 6 * 3600_000;

/** True when the lock file names a live process and is younger than LOCK_MAX_AGE_MS. A missing, damaged or stale lock is not held; one that cannot be read throws. */
export function lockHeld(file: string, now = Date.now()): boolean {
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, 'utf8'); // an unreadable lock is an error, not a free lock; callers decide
  let pid: unknown, startedAt: unknown;
  try {
    ({ pid, startedAt } = JSON.parse(raw));
  } catch {
    return false;
  }
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || now - startedAt >= LOCK_MAX_AGE_MS) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // alive, just not ours, and inside the window
  }
}

const write = (file: string): string => {
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  return content;
};

/** Removes the lock only if it still holds what this process wrote (the token acquireLock returned). */
export function releaseLock(file: string, token: string): void {
  try {
    if (readFileSync(file, 'utf8') === token) rmSync(file, { force: true });
  } catch {
    // gone or unreadable: not ours to remove
  }
}

/** Takes the lock atomically and returns what it wrote (the token for releaseLock); false when a live process holds it. A stale lock is moved aside and replaced once. */
export function acquireLock(file: string): string | false {
  mkdirSync(dirname(file), { recursive: true });
  try {
    return write(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (lockHeld(file)) return false;
  const aside = `${file}.${process.pid}.${Date.now()}`;
  try {
    renameSync(file, aside);
    rmSync(aside, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // someone else already cleared it
  }
  try {
    return write(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}
