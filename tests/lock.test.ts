import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, takeOverStale, lockHeld, releaseLock, LOCK_MAX_AGE_MS } from '../src/lock.ts';

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-'));
  return { dir, file: join(dir, 'fill.lock') };
};
const plant = (file: string, pid: number, ageMs: number) => writeFileSync(file, JSON.stringify({ pid, startedAt: Date.now() - ageMs }));

test('the lock holds the pid and a start time', () => {
  const { file } = tmp();
  const token = acquireLock(file);
  assert.equal(token, readFileSync(file, 'utf8'));
  const { pid, startedAt } = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(pid, process.pid);
  assert.ok(Math.abs(Date.now() - startedAt) < 5000);
});

test('a lock is held only while its pid is alive and it is younger than 6 hours', () => {
  const { file } = tmp();
  assert.equal(LOCK_MAX_AGE_MS, 6 * 3600_000);
  plant(file, process.pid, 60_000);
  assert.equal(lockHeld(file), true);
  plant(file, process.pid, LOCK_MAX_AGE_MS + 1000); // PID reuse after a reboot
  assert.equal(lockHeld(file), false);
  plant(file, 999999999, 1000); // dead pid
  assert.equal(lockHeld(file), false);
  writeFileSync(file, 'garbage');
  assert.equal(lockHeld(file), false);
  writeFileSync(file, String(process.pid)); // the old format has no start time
  assert.equal(lockHeld(file), false);
});

test('a process we may not signal (EPERM) counts as alive only inside the window', () => {
  const { file } = tmp();
  plant(file, 1, 60_000); // pid 1 exists; EPERM unless we are root
  if (process.getuid?.() !== 0) assert.equal(lockHeld(file), true); // as root pid 1 is signalable too, and also alive
  plant(file, 1, LOCK_MAX_AGE_MS + 1000);
  assert.equal(lockHeld(file), false);
});

test('a planted lock for pid 1 older than 6 hours is taken over, and no stale copy is left behind', () => {
  const { dir, file } = tmp();
  plant(file, 1, LOCK_MAX_AGE_MS + 60_000);
  assert.ok(acquireLock(file));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  assert.deepEqual(readdirSync(dir), ['fill.lock']);
});

test('a live fresh lock is refused and left alone', () => {
  const { file } = tmp();
  plant(file, process.pid, 1000);
  const before = readFileSync(file, 'utf8');
  assert.equal(acquireLock(file), false);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('releaseLock removes the lock only while it still holds what this process wrote', () => {
  const { file } = tmp();
  const token = acquireLock(file) as string;
  releaseLock(file, token);
  assert.equal(existsSync(file), false);

  const mine = acquireLock(file) as string;
  plant(file, 4242, 1000); // someone took over after we went stale
  const foreign = readFileSync(file, 'utf8');
  releaseLock(file, mine);
  assert.equal(readFileSync(file, 'utf8'), foreign);
  releaseLock(file, mine); // and a missing lock is no error
  rmSync(file);
  releaseLock(file, mine);
});

test('acquire publishes a complete lock at once: never an empty file, no temp files left', () => {
  const { dir, file } = tmp();
  const token = acquireLock(file) as string;
  assert.ok(token.length > 0);
  assert.equal(readFileSync(file, 'utf8'), token);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['fill.lock']);
});

test('a takeover whose lock changed between judgement and rename refuses and keeps the fresh lock', () => {
  const { dir, file } = tmp();
  plant(file, 1, LOCK_MAX_AGE_MS + 60_000);
  const judged = readFileSync(file, 'utf8');
  rmSync(file);
  plant(file, process.pid, 100); // the other starter's fresh lock lands first
  const fresh = readFileSync(file, 'utf8');
  assert.equal(takeOverStale(file, judged), false);
  assert.equal(readFileSync(file, 'utf8'), fresh);
  assert.deepEqual(readdirSync(dir), ['fill.lock']);
});

test('a takeover of a lock that is unchanged since judgement succeeds', () => {
  const { dir, file } = tmp();
  plant(file, 1, LOCK_MAX_AGE_MS + 60_000);
  const token = takeOverStale(file, readFileSync(file, 'utf8'));
  assert.ok(token);
  assert.equal(readFileSync(file, 'utf8'), token);
  assert.deepEqual(readdirSync(dir), ['fill.lock']);
});

test('a lock directory created for the lock is owner-only', () => {
  const { dir } = tmp();
  const file = join(dir, 'nested', 'fill.lock');
  assert.ok(acquireLock(file));
  assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
});
