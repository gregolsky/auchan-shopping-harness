import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

/** A lock older than this is stale whatever its pid says: the pid may have been reused after a reboot. */
export const LOCK_MAX_AGE_MS = 6 * 3600_000;

const heldRaw = (raw: string, now: number): boolean => {
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
};

const readRaw = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8'); // any other failure is an error, not a free lock; callers decide
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

/** True when the lock file names a live process and is younger than LOCK_MAX_AGE_MS. A missing, damaged or stale lock is not held; one that cannot be read throws. */
export function lockHeld(file: string, now = Date.now()): boolean {
  const raw = readRaw(file);
  return raw !== null && heldRaw(raw, now);
}

/** Publishes the lock with its content already complete: the JSON goes to a private temp file, which is then hard-linked to the lock path (EEXIST = held). A reader never sees an empty or partial lock. */
const write = (file: string): string | false => {
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
  try {
    linkSync(temp, file);
    return content;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally {
    rmSync(temp, { force: true });
  }
};

/** Removes the lock only if it still holds what this process wrote (the token acquireLock returned). */
export function releaseLock(file: string, token: string): void {
  try {
    if (readFileSync(file, 'utf8') === token) rmSync(file, { force: true });
  } catch {
    // gone or unreadable: not ours to remove
  }
}

/** Replaces a lock judged stale (its exact content is `judged`). The lock is renamed aside and re-read: if it is no longer what was judged, another starter replaced it with a fresh lock in between, so it is put back and we refuse. Exported for tests. */
export function takeOverStale(file: string, judged: string): string | false {
  const aside = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.aside`;
  try {
    renameSync(file, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // someone else already cleared it
    return write(file);
  }
  if (readFileSync(aside, 'utf8') !== judged) {
    try {
      linkSync(aside, file); // put the fresh lock back; if the path is taken again, that holder wins
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return write(file);
}

/** Takes the lock atomically and returns what it wrote (the token for releaseLock); false when a live process holds it. A stale lock is moved aside and replaced once. */
export function acquireLock(file: string): string | false {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const first = write(file);
  if (first !== false) return first;
  const raw = readRaw(file);
  if (raw === null) return write(file); // released between our attempts
  if (heldRaw(raw, Date.now())) return false;
  return takeOverStale(file, raw);
}
