import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const guard = new URL('../tools/fill-guard.ts', import.meta.url).pathname;
const run = (lock: string) => spawnSync('node', [guard, lock], { input: '{}', encoding: 'utf8' });

test('fill-guard blocks while a live pid holds the lock and allows a stale one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const lock = join(dir, 'fill.lock');
  assert.equal(run(lock).status, 0); // no lock

  const child = spawn('node', ['-e', 'setTimeout(()=>{},30000)']);
  try {
    writeFileSync(lock, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
    const blocked = run(lock);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /cart fill in progress: browser tools are blocked/);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  assert.equal(run(lock).status, 0); // the pid is gone now
  writeFileSync(lock, 'garbage');
  assert.equal(run(lock).status, 0);
});

test('fill-guard fails closed when the lock file exists but cannot be read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const lock = join(dir, 'fill.lock');
  mkdirSync(lock); // exists, but reading it throws
  const r = run(lock);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /browser tools are blocked/);
});
