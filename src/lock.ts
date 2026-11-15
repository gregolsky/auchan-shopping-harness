import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** True when the lock file names a live process. A missing, unreadable or stale lock is not held. */
export function lockHeld(file: string): boolean {
  if (!existsSync(file)) return false;
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(file, 'utf8'), 10);
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Takes the lock atomically; false when a live process holds it. A stale lock is replaced once. */
export function acquireLock(file: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (lockHeld(file)) return false;
      rmSync(file, { force: true });
    }
  }
  return false;
}
