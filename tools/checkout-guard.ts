// PreToolUse hook for the chrome-devtools browser tools: the harness never pays or places orders, so Claude's
// browser tools must not open or script Auchan's checkout, payment or order-submission pages. A product name with an
// injected instruction could otherwise steer the chat planner there. Exit 2 blocks the call; anything unreadable blocks too.
import { readFileSync } from 'node:fs';

/** URL paths and words that belong to paying or placing an order. */
export const PAYMENT_PATTERN = /checkout|payment|platnos|płatnoś|zaplac|zapłać|order-?confirm|place-?order|submit-?order|summary|podsumowanie|przelewy24|payu|blik|\/pay\b/i;

/** The browser actions whose input says where they go or what they run. */
const INSPECTED = /__(navigate_page|new_page|evaluate_script|fill|fill_form|click|press_key)$/;

export function verdict(input: unknown): { block: boolean; reason?: string } {
  if (typeof input !== 'object' || input === null) return { block: true, reason: 'unreadable hook input' };
  const { tool_name: tool, tool_input: args } = input as { tool_name?: unknown; tool_input?: unknown };
  if (typeof tool !== 'string') return { block: true, reason: 'unreadable hook input' };
  if (!INSPECTED.test(tool)) return { block: false };
  const text = JSON.stringify(args ?? {});
  if (PAYMENT_PATTERN.test(text)) return { block: true, reason: 'the harness never opens or scripts checkout or payment pages' };
  return { block: false };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  let result: { block: boolean; reason?: string };
  try {
    result = verdict(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    result = { block: true, reason: 'unreadable hook input' };
  }
  if (result.block) {
    console.error(`blocked: ${result.reason}`);
    process.exit(2);
  }
}
