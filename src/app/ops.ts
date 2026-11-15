import { cleanText } from '../parse.ts';

export type Op =
  | { op: 'add'; term: string; quantity: number; note?: string }
  | { op: 'choose'; lineKey: string; productId: string }
  | { op: 'remove'; lineKey: string }
  | { op: 'setQuantity'; lineKey: string; quantity: number }
  | { op: 'ask'; lineKey: string; question: string; options: string[] }
  | { op: 'unmatched'; term: string; hint: string }
  | { op: 'say'; text: string };

export interface LineView { lineKey: string; candidateIds: string[] }

const MAX_TERM = 100;
const MAX_SHORT = 500;
const MAX_SAY = 2000;
const MAX_OPTIONS = 3;
const MAX_KEY = 200;

function str(v: unknown, max: number, allowEmpty = false): string | null {
  if (typeof v !== 'string') return null;
  const s = cleanText(v.replace(/[\t\r\n]+/g, ' ')).trim();
  if (s.length > max || (s === '' && !allowEmpty)) return null;
  return s;
}

function qty(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 20 ? v : null;
}

function one(item: unknown, lines: Map<string, string[]>): Op | null {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const lineKey = () => {
    const k = typeof o.lineKey === 'string' ? cleanText(o.lineKey).trim() : null;
    return k !== null && lines.has(k) ? k : null;
  };
  switch (o.op) {
    case 'add': {
      const term = str(o.term, MAX_TERM);
      const quantity = qty(o.quantity);
      if (term === null || quantity === null) return null;
      if (o.note === undefined) return { op: 'add', term, quantity };
      const note = str(o.note, MAX_SHORT, true);
      return note === null ? null : { op: 'add', term, quantity, note };
    }
    case 'choose': {
      const k = lineKey();
      const productId = str(o.productId, MAX_KEY);
      if (k === null || productId === null || !lines.get(k)!.includes(productId)) return null;
      return { op: 'choose', lineKey: k, productId };
    }
    case 'remove': {
      const k = lineKey();
      return k === null ? null : { op: 'remove', lineKey: k };
    }
    case 'setQuantity': {
      const k = lineKey();
      const quantity = qty(o.quantity);
      return k === null || quantity === null ? null : { op: 'setQuantity', lineKey: k, quantity };
    }
    case 'ask': {
      const k = lineKey();
      const question = str(o.question, MAX_SHORT);
      if (k === null || question === null || !Array.isArray(o.options)) return null;
      if (o.options.length < 1 || o.options.length > MAX_OPTIONS) return null;
      const options: string[] = [];
      for (const raw of o.options) {
        const id = str(raw, MAX_KEY);
        if (id === null || !lines.get(k)!.includes(id)) return null;
        if (!options.includes(id)) options.push(id);
      }
      return { op: 'ask', lineKey: k, question, options };
    }
    case 'unmatched': {
      const term = str(o.term, MAX_TERM);
      const hint = str(o.hint, MAX_SHORT, true);
      return term === null || hint === null ? null : { op: 'unmatched', term, hint };
    }
    case 'say': {
      const text = str(o.text, MAX_SAY);
      return text === null ? null : { op: 'say', text };
    }
    default:
      return null;
  }
}

/** Keeps only well-formed operations that refer to known lines and candidates; counts the rest. */
export function validateOps(raw: unknown, lines: LineView[]): { ops: Op[]; dropped: number } {
  if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as { ops?: unknown }).ops)) {
    return { ops: [], dropped: 0 };
  }
  const known = new Map(lines.map((l) => [l.lineKey, l.candidateIds]));
  const ops: Op[] = [];
  let dropped = 0;
  for (const item of (raw as { ops: unknown[] }).ops) {
    const op = one(item, known);
    if (op === null) dropped++;
    else ops.push(op);
  }
  return { ops, dropped };
}

const s = (maxLength: number, minLength = 1) => ({ type: 'string', minLength, maxLength });
const q = { type: 'integer', minimum: 1, maximum: 20 };
const branch = (op: string, properties: Record<string, object>, required: string[]) => ({
  type: 'object',
  properties: { op: { const: op }, ...properties },
  required: ['op', ...required],
  additionalProperties: false,
});

export const OPS_JSON_SCHEMA: object = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        anyOf: [
          branch('add', { term: s(MAX_TERM), quantity: q, note: s(MAX_SHORT, 0) }, ['term', 'quantity']),
          branch('choose', { lineKey: s(MAX_KEY), productId: s(MAX_KEY) }, ['lineKey', 'productId']),
          branch('remove', { lineKey: s(MAX_KEY) }, ['lineKey']),
          branch('setQuantity', { lineKey: s(MAX_KEY), quantity: q }, ['lineKey', 'quantity']),
          branch('ask', {
            lineKey: s(MAX_KEY), question: s(MAX_SHORT),
            options: { type: 'array', items: s(MAX_KEY), minItems: 1, maxItems: MAX_OPTIONS },
          }, ['lineKey', 'question', 'options']),
          branch('unmatched', { term: s(MAX_TERM), hint: s(MAX_SHORT, 0) }, ['term', 'hint']),
          branch('say', { text: s(MAX_SAY) }, ['text']),
        ],
      },
    },
  },
  required: ['ops'],
  additionalProperties: false,
};
