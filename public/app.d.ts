export const STEPS: string[];
export function progressLine(stepIndex: number): string;
export function zl(grosze: number): string;
export function viewModel(state: any): any;
export function describeOp(op: any, linesByKey: Map<string, any>): string;
export function start(): void;
