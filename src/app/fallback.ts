import { cleanText } from '../parse.ts';

const MAX_ITEMS = 100;

/** Splits a pasted note into shopping lines without Claude: one item per line. */
export function parseNote(note: string): { term: string; quantity: number; note: string }[] {
  const out: { term: string; quantity: number; note: string }[] = [];
  for (const rawLine of note.split(/\r?\n/)) {
    let line = cleanText(rawLine).replace(/^\s*[-*•]\s*/, '').replace(/\s+/g, ' ').trim();
    let quantity = 1;
    const m = /^(.*?)\s+(?:x\s*(\d+)|(\d+)\s*x|(\d+))$/i.exec(line);
    if (m) {
      const n = Number(m[2] ?? m[3] ?? m[4]);
      if (n >= 1 && n <= 20 && m[1].trim() !== '') {
        quantity = n;
        line = m[1].trim();
      }
    }
    if (line === '') continue;
    out.push({ term: line, quantity, note: '' });
    if (out.length === MAX_ITEMS) break;
  }
  return out;
}
