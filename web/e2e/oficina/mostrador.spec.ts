// Oficina · Mostrador at 1180×820 with touch (criterion 6): a cash payment from search to
// "Siguiente cliente", counted in taps and timed. Typing on the on-screen keyboard is not a tap.
// Also walks the counter edge cases of the seed (empty search, buyer with no payments, plan on
// hold, late inside grace, pending cash reference).
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });

async function openCounter(page: Page) {
  await page.goto('/?reset=1#/oficina/mostrador');
  await expect(page.getByTestId('mostrador')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('shift-total-usd')).toBeVisible();
}

test('cash payment from search to next customer: ≤ 6 taps, ≤ 90 s', async ({ page }) => {
  await page.goto('/?reset=1#/oficina');
  // The device decides: a narrow landscape touch screen opens the counter.
  await expect(page.getByTestId('mostrador')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('shift-total-usd')).toHaveText(/USD 0[.,]00/);
  let taps = 0;
  const tap = async (testId: string) => {
    taps += 1;
    await page.getByTestId(testId).tap();
  };
  const t0 = Date.now();

  await tap('counter-search');
  const searchStart = Date.now();
  await page.keyboard.type('7035550187');
  await expect(page.getByTestId('buyer-card')).toBeVisible();
  const searchMs = Date.now() - searchStart;
  await expect(page.getByTestId('buyer-card')).toContainText('Roxana Beatriz Hernández');
  await expect(page.getByTestId('buyer-card-pending-ref')).toBeVisible();

  const charge = page.getByTestId('charge-5');
  await expect(charge).toHaveText(/Cobrar USD 750[.,]00/);
  const box = await charge.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(56);
  await tap('charge-5');

  await expect(page.getByTestId('pay-due')).toHaveText(/USD 750[.,]00/);
  await tap('quick-80000');
  await expect(page.getByTestId('pay-change')).toHaveText(/USD 50[.,]00/);
  await tap('pay-confirm');

  await expect(page.getByTestId('counter-receipt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('counter-ticket')).toContainText('USD 800');
  await expect(page.getByTestId('counter-ticket-delivered')).toContainText(/USD 750[.,]00/);
  await expect(page.getByTestId('shift-cash')).toHaveText(/USD 750[.,]00/);
  const ticket = await page.getByTestId('counter-ticket').boundingBox();
  expect(Math.round(ticket!.width)).toBeLessThanOrEqual(303); // 80 mm at 96 dpi = 302.4 px

  await tap('receipt-whatsapp');
  await expect(page.getByTestId('receipt-whatsapp-preview')).toContainText('+17035550187');
  // No template text in this build: the template's name and its parameters, not the raw body.
  await expect(page.getByTestId('receipt-whatsapp-preview').getByTestId('message-summary')).toContainText('Pago recibido');
  await expect(page.getByTestId('receipt-whatsapp-preview')).not.toContainText('[es]');

  await tap('next-customer');
  await expect(page.getByTestId('counter-search')).toHaveValue('');
  await expect(page.getByTestId('counter-search')).toBeFocused();
  const totalMs = Date.now() - t0;

  console.log(`[mostrador] taps=${taps} total=${(totalMs / 1000).toFixed(1)}s search=${searchMs}ms`);
  expect(taps).toBeLessThanOrEqual(6);
  expect(totalMs).toBeLessThan(90_000);
  expect(searchMs).toBeLessThan(2_000);
});

test('counter edge cases are reachable', async ({ page }) => {
  await openCounter(page);
  const search = page.getByTestId('counter-search');

  // Empty office search.
  await search.fill('5550000');
  await expect(page.getByTestId('counter-empty')).toBeVisible();

  // Buyer with no payments yet: nothing due today, first payment ahead.
  await search.fill('3185550144');
  await expect(page.getByTestId('buyer-card-nothing-due')).toBeVisible();
  await expect(page.getByTestId('buyer-card-nothing-due')).toContainText(/primera cuota/);
  await page.getByTestId('buyer-card-back').tap();

  // Plan on hold after the CNR alert: no payment can be taken.
  await page.getByTestId('counter-search').fill('7135550163');
  await expect(page.getByTestId('buyer-card-blocked')).toBeVisible();
  await expect(page.getByTestId('buyer-card-gate')).toBeVisible();
  await page.getByTestId('buyer-card-back').tap();

  // Late inside grace, payable at the counter.
  await page.getByTestId('counter-search').fill('3015550129');
  await expect(page.getByTestId('buyer-card')).toContainText(/Atrasada, en periodo de gracia/);
  await expect(page.getByTestId('buyer-card-gate')).toBeVisible(); // seller in payout-account cooling-off

  // Name search: accent and case insensitive, lists instead of opening.
  await page.getByTestId('buyer-card-back').tap();
  await page.getByTestId('counter-search').fill('HERNANDEZ');
  await expect(page.getByTestId('counter-result-plan-roxana')).toBeVisible();
});

test('card payment (simulated) needs no amount and gives no change', async ({ page }) => {
  await openCounter(page);
  await page.getByTestId('counter-search').fill('3015550129');
  await page.getByTestId('charge-3').tap();
  await page.getByTestId('tender-card').tap();
  await expect(page.getByTestId('pay-change')).toHaveText(/USD 0[.,]00/);
  await page.getByTestId('pay-confirm').tap();
  await expect(page.getByTestId('counter-receipt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('shift-card')).toHaveText(/USD 500[.,]00/);
});

test('every interactive control on the counter is at least 44 px tall', async ({ page }) => {
  await openCounter(page);
  await page.getByTestId('counter-search').fill('7035550187');
  await page.getByTestId('charge-5').tap();
  const small = await page.locator('[data-testid="mostrador"] button, [data-testid="mostrador"] input, [data-testid="mostrador"] select').evaluateAll((els) =>
    els.filter((e) => (e as HTMLElement).offsetParent !== null && e.getBoundingClientRect().height < 44).map((e) => e.outerHTML.slice(0, 80)),
  );
  expect(small).toEqual([]);
});
test('every office name fits the office dropdown at 1180 px', async ({ page }) => {
  await openCounter(page);
  const cut = await page.getByTestId('counter-office').evaluate((el) => {
    const sel = el as HTMLSelectElement;
    const cs = getComputedStyle(sel);
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // Room for the text: the content box less the native arrow (about 24 px).
    const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 24;
    return [...sel.options].filter((o) => ctx.measureText(o.text).width > room).map((o) => o.text);
  });
  expect(cut).toEqual([]);
});
