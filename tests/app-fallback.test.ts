import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNote } from '../src/app/fallback.ts';

test('parseNote reads bullets, quantities and blank lines', () => {
  const note = '- cukier 2 \n- mąka 2\n\n- ryż  \n• ser żółty  duża paczka gouda albo edam\nkoncentrat pomidorowy 3';
  assert.deepEqual(parseNote(note), [
    { term: 'cukier', quantity: 2, note: '' },
    { term: 'mąka', quantity: 2, note: '' },
    { term: 'ryż', quantity: 1, note: '' },
    { term: 'ser żółty duża paczka gouda albo edam', quantity: 1, note: '' },
    { term: 'koncentrat pomidorowy', quantity: 3, note: '' },
  ]);
});

test('parseNote accepts x3 and 3x and * bullets', () => {
  assert.deepEqual(parseNote('* jajka x3\nmasło 4x'), [
    { term: 'jajka', quantity: 3, note: '' },
    { term: 'masło', quantity: 4, note: '' },
  ]);
});

test('parseNote keeps a trailing number above 20 in the term', () => {
  assert.deepEqual(parseNote('woda 50'), [{ term: 'woda 50', quantity: 1, note: '' }]);
  assert.deepEqual(parseNote('woda 20'), [{ term: 'woda', quantity: 20, note: '' }]);
  assert.deepEqual(parseNote('woda 0'), [{ term: 'woda 0', quantity: 1, note: '' }]);
});

test('parseNote of an empty note is empty and caps at 100 items', () => {
  assert.deepEqual(parseNote(' \n\n'), []);
  assert.equal(parseNote(Array.from({ length: 150 }, (_, i) => `rzecz${i}`).join('\n')).length, 100);
});

test('parseNote keeps words apart when a tab separates them', () => {
  assert.deepEqual(parseNote('cukier\t2'), [{ term: 'cukier', quantity: 2, note: '' }]);
});

test('parseNote skips terms longer than 100 characters', () => {
  assert.deepEqual(parseNote(`${'a'.repeat(101)}\nmleko`).map((x) => x.term), ['mleko']);
});
