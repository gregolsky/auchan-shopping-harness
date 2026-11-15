export const STEPS: string[];
export function progressLine(stepIndex: number): string;
export function zl(grosze: number): string;
export function viewModel(state: any): any;
export function describeOp(op: any, linesByKey: Map<string, any>): string;
export function start(): void;
export function describeQuestions(model: any): { intro: string | null; empty: string | null; canContinue: boolean };
export function unmatchedText(item: { term: string; hint?: string }): string;
export function parseBudget(text: string): { ok: true; grosze: number | undefined } | { ok: false; error: string };
