import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verdict } from '../tools/checkout-guard.ts';

const script = fileURLToPath(new URL('../tools/checkout-guard.ts', import.meta.url));
const run = (input: string) => spawnSync(process.execPath, [script], { input, encoding: 'utf8' });

test('navigating or scripting checkout and payment pages is blocked', () => {
  const nav = (url: string) => verdict({ tool_name: 'mcp__chrome-devtools__navigate_page', tool_input: { url } });
  assert.equal(nav('https://zakupy.auchan.pl/checkout').block, true);
  assert.equal(nav('https://zakupy.auchan.pl/checkout/summary?x=1').block, true);
  assert.equal(nav('https://secure.przelewy24.pl/trnRequest/abc').block, true);
  assert.equal(verdict({ tool_name: 'mcp__chrome-devtools__new_page', tool_input: { url: 'https://zakupy.auchan.pl/payment' } }).block, true);
  assert.equal(verdict({ tool_name: 'mcp__chrome-devtools__evaluate_script', tool_input: { function: "() => location.href = '/checkout'" } }).block, true);
  assert.equal(verdict({ tool_name: 'mcp__chrome-devtools__click', tool_input: { uid: '1_2', dblClick: false, label: 'Zapłać' } }).block, true);
});

test('ordinary browsing and other tools are allowed', () => {
  assert.equal(verdict({ tool_name: 'mcp__chrome-devtools__navigate_page', tool_input: { url: 'https://zakupy.auchan.pl/orders' } }).block, false);
  assert.equal(verdict({ tool_name: 'mcp__chrome-devtools__navigate_page', tool_input: { url: 'https://zakupy.auchan.pl/products/00781527/details' } }).block, false);
  assert.equal(verdict({ tool_name: 'mcp__chrome-devtools__take_snapshot', tool_input: {} }).block, false);
  assert.equal(verdict({ tool_name: 'mcp__chrome-devtools__list_pages', tool_input: {} }).block, false);
});

test('the hook script exits 2 on a blocked call, 0 on an allowed one, and blocks unreadable input', () => {
  assert.equal(run(JSON.stringify({ tool_name: 'mcp__chrome-devtools__navigate_page', tool_input: { url: 'https://zakupy.auchan.pl/checkout' } })).status, 2);
  assert.equal(run(JSON.stringify({ tool_name: 'mcp__chrome-devtools__navigate_page', tool_input: { url: 'https://zakupy.auchan.pl/' } })).status, 0);
  assert.equal(run('not json').status, 2);
});
