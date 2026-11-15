import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOps, OPS_JSON_SCHEMA } from '../src/app/ops.ts';
import type { LineView } from '../src/app/ops.ts';

const lines: LineView[] = [{ lineKey: 't:ser zolty', candidateIds: ['A', 'B'] }];
const L = 't:ser zolty';

test('validateOps keeps valid operations of every kind', () => {
  const raw = {
    ops: [
      { op: 'add', term: 'mleko', quantity: 2, note: 'bez laktozy' },
      { op: 'add', term: 'ryz', quantity: 1 },
      { op: 'choose', lineKey: L, productId: 'A' },
      { op: 'remove', lineKey: L },
      { op: 'setQuantity', lineKey: L, quantity: 20 },
      { op: 'ask', lineKey: L, question: 'Ktory?', options: ['A', 'B'] },
      { op: 'unmatched', term: 'kawior', hint: 'brak w historii' },
      { op: 'say', text: 'Gotowe' },
    ],
  };
  const r = validateOps(raw, lines);
  assert.equal(r.dropped, 0);
  assert.deepEqual(r.ops, raw.ops);
});

const dropCases: [string, unknown][] = [
  ['unknown op', { op: 'explode' }],
  ['choose with a non-candidate', { op: 'choose', lineKey: L, productId: 'Z' }],
  ['unknown lineKey', { op: 'remove', lineKey: 't:nic' }],
  ['setQuantity 0', { op: 'setQuantity', lineKey: L, quantity: 0 }],
  ['setQuantity 21', { op: 'setQuantity', lineKey: L, quantity: 21 }],
  ['setQuantity 1.5', { op: 'setQuantity', lineKey: L, quantity: 1.5 }],
  ['add quantity 0', { op: 'add', term: 'a', quantity: 0 }],
  ['add quantity 21', { op: 'add', term: 'a', quantity: 21 }],
  ['add quantity 1.5', { op: 'add', term: 'a', quantity: 1.5 }],
  ['add empty term', { op: 'add', term: '  ', quantity: 1 }],
  ['add long term', { op: 'add', term: 'x'.repeat(101), quantity: 1 }],
  ['ask with 4 options', { op: 'ask', lineKey: L, question: 'q', options: ['A', 'B', 'A', 'B'] }],
  ['ask with a non-candidate option', { op: 'ask', lineKey: L, question: 'q', options: ['A', 'Z'] }],
  ['say too long', { op: 'say', text: 'x'.repeat(2001) }],
  ['non-object item', 'add'],
  ['null item', null],
];
for (const [name, item] of dropCases) {
  test(`validateOps drops ${name}`, () => {
    assert.deepEqual(validateOps({ ops: [item] }, lines), { ops: [], dropped: 1 });
  });
}

test('validateOps drops only the bad ones and counts them', () => {
  const r = validateOps({ ops: [{ op: 'say', text: 'ok' }, { op: 'nope' }, { op: 'remove', lineKey: 'x' }] }, lines);
  assert.deepEqual(r, { ops: [{ op: 'say', text: 'ok' }], dropped: 2 });
});

test('validateOps returns nothing for non-object input or missing ops array', () => {
  assert.deepEqual(validateOps(null, lines), { ops: [], dropped: 0 });
  assert.deepEqual(validateOps('x', lines), { ops: [], dropped: 0 });
  assert.deepEqual(validateOps({}, lines), { ops: [], dropped: 0 });
  assert.deepEqual(validateOps({ ops: 'x' }, lines), { ops: [], dropped: 0 });
});

test('validateOps trims strings and cleans control characters', () => {
  const r = validateOps({ ops: [{ op: 'say', text: '  \u001b[31mhej‮  ' }, { op: 'add', term: ' mleko ', quantity: 1, note: ' x ' }] }, lines);
  assert.deepEqual(r.ops, [{ op: 'say', text: '[31mhej' }, { op: 'add', term: 'mleko', quantity: 1, note: 'x' }]);
  assert.ok(!JSON.stringify(r.ops).includes('\\u001b'));
});

test('OPS_JSON_SCHEMA is an object schema with one closed branch per op', () => {
  const s = OPS_JSON_SCHEMA as any;
  assert.equal(s.type, 'object');
  assert.deepEqual(s.required, ['ops']);
  const branches = s.properties.ops.items.anyOf;
  assert.equal(branches.length, 7);
  for (const b of branches) {
    assert.equal(b.type, 'object');
    assert.equal(b.additionalProperties, false);
    assert.ok(b.required.includes('op'));
    for (const k of b.required) assert.ok(k in b.properties);
  }
  assert.deepEqual(branches.map((b: any) => b.properties.op.const).sort(),
    ['add', 'ask', 'choose', 'remove', 'say', 'setQuantity', 'unmatched']);
});

test('validateOps keeps words apart across a tab and dedupes ask options', () => {
  const r = validateOps({ ops: [
    { op: 'add', term: 'cukier\tbialy', quantity: 1 },
    { op: 'ask', lineKey: L, question: 'Ktory?', options: ['A', 'A', 'B'] },
  ] }, lines);
  assert.deepEqual(r.ops, [
    { op: 'add', term: 'cukier bialy', quantity: 1 },
    { op: 'ask', lineKey: L, question: 'Ktory?', options: ['A', 'B'] },
  ]);
});
