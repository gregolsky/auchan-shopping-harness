// Throwaway (stage 3, Task 1): prints method, status, host and path of the site's API requests while the user opens the cart.
// Never prints headers or bodies, and replaces every query value with "…": they can carry session data.
import { launchProfile, ORIGIN } from '../src/worker.ts';

const context = await launchProfile();
const closed = new Promise<void>((r) => context.once('close', () => r()));
const seen = new Set<string>();
context.on('response', (res) => {
  const req = res.request();
  let u: URL;
  try {
    u = new URL(req.url());
  } catch {
    return;
  }
  if (!/auchan/i.test(u.hostname) || !/\/api\/|graphql|cart|basket|koszyk/i.test(u.pathname)) return;
  const keys = [...u.searchParams.keys()].map((k) => `${k}=…`).join('&');
  const line = `${req.method()} ${res.status()} ${u.host}${u.pathname}${keys ? '?' + keys : ''}`;
  if (!seen.has(line)) { seen.add(line); console.log(line); }
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(ORIGIN + '/').catch(() => {});
console.log('Open your cart in this window, then close the window.');
await closed;
