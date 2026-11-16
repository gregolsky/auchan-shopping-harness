import { cleanText } from './parse.ts';

/** Where the details of an unexpected failure go: stderr only, as the error's name and message, cleaned. Users see fixed text instead. */
export function logDetail(label: string, err: unknown): void {
  const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(cleanText(`${label}: ${detail}`).slice(0, 1000));
}

/** A refusal whose text was written for the user (a blocked product, an unknown id): it may be shown as it is. Every other error is shown as fixed text. */
export class UserError extends Error {}

/** The text to show for a failure: a UserError's own message, else the fixed one (with the details going to stderr). */
export function shownText(label: string, err: unknown, fixed: string): string {
  if (err instanceof UserError) return err.message;
  logDetail(label, err);
  return fixed;
}
