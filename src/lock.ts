import { existsSync, readFileSync } from 'node:fs';

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
