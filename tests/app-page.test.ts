import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { STEPS, progressLine, zl, viewModel, describeOp } from '../public/app.js';

const line = { lineKey: 't:maka', term: 'mąka', name: 'Mąka pszenna', productId: 'a', quantity: 2, lineCostGrosze: 1259,
  reason: 'bought before', confidence: 'medium', confidenceReason: 'not bought before', included: true, kind: 'item',
  question: { text: 'Która?', options: ['a'] }, candidates: [{ productId: 'a', name: 'Mąka pszenna' }] };

test('the six steps and money formatter are stable', () => {
  assert.equal(STEPS.length, 6);
  assert.equal(progressLine(2), '[1 Dane ✓] → [2 Szkic ✓] → [3 Doprecyzowanie •] → [4 Zatwierdzenie] → [5 Koszyk] → [6 Płatność]');
  assert.equal(zl(1259), '12,59 zł');
});

test('review stays disabled until questions are answered and totals use included lines', () => {
  const model = viewModel({ trip: { step: 'doprecyzowanie', lines: [line, { ...line, lineKey: 'x', kind: 'suggestion', lineCostGrosze: 1000, included: false }], proposal: null, unmatched: [], messages: [] }, freshness: { ageHours: 2 } });
  assert.equal(model.canApprove, false);
  assert.equal(model.total, 1259);
  assert.equal(model.lines.length, 1);
  assert.equal(model.suggestions.length, 1);
});

test('proposal operations have readable descriptions', () => {
  const byKey = new Map([['t:maka', line]]);
  assert.match(describeOp({ op: 'choose', lineKey: 't:maka', productId: 'a' }, byKey), /Mąka pszenna/);
  assert.match(describeOp({ op: 'setQuantity', lineKey: 't:maka', quantity: 3 }, byKey), /3/);
  assert.match(describeOp({ op: 'remove', lineKey: 't:maka' }, byKey), /Usuń/);
});

test('page loads same-origin assets and never injects untrusted HTML', () => {
  const html = readFileSync('public/index.html', 'utf8');
  const js = readFileSync('public/app.js', 'utf8');
  assert.match(html, /src="\/app.js/);
  assert.match(html, /href="\/app.css/);
  assert.match(html, /href="\/icon.svg\?t=__APP_TOKEN__/);
  assert.match(html, /src="\/shopping.svg\?t=__APP_TOKEN__/);
  assert.match(html, /__APP_TOKEN__/);
  assert.doesNotMatch(html, /<script(?![^>]*src=)|<style|\son\w+=/i);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
