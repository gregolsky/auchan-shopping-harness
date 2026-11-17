// Browser tests of the local app: run with `npm run test:e2e` (needs Chromium; CHROMIUM_PATH overrides /usr/sbin/chromium).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { devices, type Browser, type BrowserContextOptions, type Page } from 'playwright-core';
import { launch, P, startApp, type App } from './harness.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

/** A page in a fresh profile that records every page error, console error and failed request. */
async function open(url: string, options: BrowserContextOptions = { viewport: { width: 1280, height: 900 } }) {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], ...options });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`); });
  await page.goto(url);
  await settle(page);
  return { page, problems, close: () => context.close() };
}

/** Waits until the page is not working on a request and has rendered. */
async function settle(page: Page) {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#working')?.hidden !== false && document.querySelector<HTMLElement>('#search-status')?.hidden !== false);
  await page.waitForTimeout(300);
}
const step = async (page: Page, name: string) => { await page.locator('#steps button', { hasText: name }).click(); await settle(page); };
const card = (page: Page, term: string) => page.locator('.line-card').filter({ has: page.locator('.from-list', { hasText: `z Twojej listy: ${term}` }) });
const noHorizontalScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);

/** Pastes the list and drafts it. */
async function draft(page: Page, note = 'mleko 2\nchleb\nmasło') {
  await page.getByRole('button', { name: 'Dalej: lista →' }).click(); await settle(page);
  await page.locator('textarea').first().fill(note);
  await page.getByRole('button', { name: 'Ułóż szkic →' }).click(); await settle(page);
}

test('a whole trip: list, review, question, approval, cart and payment hand-off', async () => {
  const app = await startApp();
  const { page, problems, close } = await open(app.url);
  try {
    await draft(page);
    await step(page, 'Przegląd');
    assert.equal(await card(page, 'mleko').count(), 1);
    assert.equal(await card(page, 'chleb').count(), 1);
    assert.equal(await card(page, 'masło').count(), 1);

    // Wybierz inny shows the other milks; picking one changes the product.
    const milk = card(page, 'mleko');
    assert.ok(await milk.locator('.others').isHidden(), 'alternatives stay folded until asked for');
    await milk.getByRole('button', { name: 'Wybierz inny', exact: true }).click();
    assert.ok(await milk.locator('.others').isVisible());
    assert.equal(await milk.getByRole('button', { name: 'Wybierz inny', exact: true }).getAttribute('aria-expanded'), 'true');
    await milk.locator('.others .option', { hasText: 'Łaciate' }).click(); await settle(page);
    assert.match(await card(page, 'mleko').locator('.line-name').first().innerText(), /Łaciate/);

    // On a card with a question, Wybierz inny moves to the question's options.
    await card(page, 'chleb').getByRole('button', { name: 'Wybierz inny', exact: true }).click();
    assert.ok(await page.evaluate(() => document.activeElement?.closest('.ask') !== null), 'focus is on an option of the question');

    // The stepper changes the quantity both ways.
    const quantity = () => card(page, 'masło').locator('.quantity').innerText();
    await card(page, 'masło').getByRole('button', { name: 'Więcej' }).click(); await settle(page);
    assert.equal(await quantity(), '2 szt.');
    await card(page, 'masło').getByRole('button', { name: 'Mniej' }).click(); await settle(page);
    assert.equal(await quantity(), '1 szt.');

    // Doprecyzowanie: answering the question clears it.
    await step(page, 'Doprecyzowanie');
    await card(page, 'chleb').locator('.ask .option', { hasText: 'żytni' }).click(); await settle(page);
    assert.equal(await page.locator('.ask').count(), 0);

    // Ad hoc change through (scripted) Claude: the proposal applies only after Przyjmij.
    await page.locator('textarea[placeholder^="Na przykład"]').fill('dodaj jogurt');
    await page.getByRole('button', { name: 'Zaproponuj zmianę' }).click(); await settle(page);
    await page.getByRole('button', { name: /Przyjmij wszystkie/ }).click(); await settle(page);

    // Approve, watch the fill, read the report.
    await step(page, 'Zatwierdzenie');
    assert.match(await page.locator('#content').innerText(), /Szacowana kwota/);
    await page.getByRole('button', { name: '✓ Zatwierdź i dodaj do koszyka' }).click();
    await page.locator('#steps .step.active', { hasText: 'Płatność' }).waitFor({ timeout: 15000 });
    await settle(page);
    assert.deepEqual(app.cart.quantities, { [P.milkLaciate]: 2, [P.breadRye]: 1, [P.butter]: 1, [P.yogurt]: 2 });
    assert.match(await page.locator('#content').innerText(), /Dodano produktów: 4/);
    assert.equal(await page.getByRole('link', { name: /Zapłać na Auchan/ }).getAttribute('href'), 'https://zakupy.auchan.pl/checkout', 'the app only links to payment');
    assert.ok(await noHorizontalScroll(page));
    assert.deepEqual(problems, []);
  } finally { await close(); await app.close(); }
});

test('the phone hand-off: QR code, link to the Wi-Fi address, copy, Escape', async () => {
  const app = await startApp();
  const { page, problems, close } = await open(app.url);
  try {
    const trigger = page.locator('#phone-trigger');
    await trigger.waitFor();
    await trigger.click();
    assert.ok(await page.locator('#phone-dialog').evaluate((d: HTMLDialogElement) => d.open));
    assert.ok(await page.locator('#phone-qr').evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0), 'the QR code loads');
    const link = await page.locator('#phone-link').innerText();
    assert.equal(link, app.phoneUrl);
    await page.locator('#phone-copy').click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), app.phoneUrl);
    await page.keyboard.press('Escape');
    assert.ok(!(await page.locator('#phone-dialog').evaluate((d: HTMLDialogElement) => d.open)));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'phone-trigger');
    assert.deepEqual(problems, []);
  } finally { await close(); await app.close(); }
});

for (const device of ['Pixel 7', 'iPhone 14', 'iPhone SE'] as const) {
  test(`on a phone (${device}) over the Wi-Fi address the trip continues and taps work`, async () => {
    const app = await startApp();
    const desk = await open(app.url);
    await draft(desk.page);
    await desk.close();
    const { page, problems, close } = await open(app.phoneUrl, { ...devices[device] });
    try {
      assert.ok(await page.locator('#phone-trigger').isHidden(), 'no hand-off offer on the phone itself');
      await step(page, 'Przegląd');
      assert.equal(await card(page, 'mleko').count(), 1, 'the same trip as on the computer');
      await card(page, 'masło').getByRole('button', { name: 'Więcej' }).tap(); await settle(page);
      assert.equal(await card(page, 'masło').locator('.quantity').innerText(), '2 szt.', 'a POST from the phone is accepted');
      await card(page, 'mleko').getByRole('button', { name: 'Wybierz inny', exact: true }).tap();
      assert.ok(await card(page, 'mleko').locator('.others').isVisible());
      assert.ok(await page.locator('#steps .step.active').evaluate((a) => {
        const r = a.getBoundingClientRect(); const s = a.parentElement!.getBoundingClientRect();
        return r.left >= s.left - 1 && r.right <= s.right + 1;
      }), 'the active step is scrolled into the step bar');
      assert.ok(await noHorizontalScroll(page));
      assert.deepEqual(problems, []);
    } finally { await close(); await app.close(); }
  });
}

test('every step renders at phone, tablet and desktop width in both themes', async () => {
  const app = await startApp();
  const seed = await open(app.url);
  await draft(seed.page);
  await seed.close();
  try {
    for (const width of [375, 768, 1280]) for (const colorScheme of ['light', 'dark'] as const) {
      const { page, problems, close } = await open(app.url, { viewport: { width, height: 900 }, colorScheme });
      try {
        for (const name of ['Dane', 'Lista', 'Przegląd', 'Doprecyzowanie', 'Zatwierdzenie', 'Moje reguły']) {
          const tab = page.locator('#steps button', { hasText: name });
          if (!(await tab.isEnabled())) continue;
          await tab.click(); await settle(page);
          assert.ok((await page.locator('#content').innerText()).trim().length > 20, `${width} ${colorScheme} ${name}: content`);
          assert.ok(await noHorizontalScroll(page), `${width} ${colorScheme} ${name}: no horizontal scroll`);
          const broken = await page.evaluate(() => [...document.images].filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0 && !i.closest('dialog:not([open]), [hidden]')).length);
          assert.equal(broken, 0, `${width} ${colorScheme} ${name}: broken images`);
        }
        assert.deepEqual(problems, [], `${width} ${colorScheme}`);
      } finally { await close(); }
    }
  } finally { await app.close(); }
});

test('the theme switch sets the theme and aria-pressed', async () => {
  const app = await startApp();
  const { page, problems, close } = await open(app.url);
  try {
    for (const [name, theme] of [['Ciemny', 'dark'], ['Jasny', 'light']] as const) {
      await page.getByRole('button', { name, exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.equal(await page.getByRole('button', { name, exact: true }).getAttribute('aria-pressed'), 'true');
    }
    assert.deepEqual(problems, []);
  } finally { await close(); await app.close(); }
});

test('without Claude the app says so, still drafts one product per line and refuses ad hoc changes', async () => {
  const app = await startApp({ parse: null, choose: null, adhoc: null });
  const { page, problems, close } = await open(app.url);
  try {
    await draft(page, 'mleko 2\nmasło x3');
    assert.equal(await page.locator('#mode').innerText(), 'Tryb bez Claude');
    await step(page, 'Przegląd');
    assert.equal(await card(page, 'mleko').locator('.quantity').innerText(), '2 szt.');
    assert.equal(await card(page, 'masło').locator('.quantity').innerText(), '3 szt.');
    await page.locator('textarea[placeholder^="Na przykład"]').fill('weź większe mleko');
    await page.getByRole('button', { name: 'Zaproponuj zmianę' }).click(); await settle(page);
    assert.match(await page.locator('body').innerText(), /Claude jest niedostępny/);
    assert.deepEqual(problems, []);
  } finally { await close(); await app.close(); }
});

test('blocking a product in Moje reguły and lifting the block', async () => {
  const app = await startApp();
  const { page, problems, close } = await open(app.url);
  try {
    await page.getByRole('button', { name: /Moje reguły/ }).click(); await settle(page);
    const unblock = page.getByRole('button', { name: 'Odblokuj' });
    const before = await unblock.count();
    await page.locator('input[placeholder*="mąka"]').fill('jogurt');
    await page.getByRole('button', { name: 'Szukaj produktów' }).click(); await settle(page);
    await page.getByRole('button', { name: 'Zablokuj' }).first().click(); await settle(page);
    assert.equal(await unblock.count(), before + 1);
    await unblock.last().click(); await settle(page);
    assert.equal(await unblock.count(), before);
    assert.deepEqual(problems, []);
  } finally { await close(); await app.close(); }
});
