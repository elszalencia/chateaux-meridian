// Stage 1 end-to-end test: walks the frozen demo script (steps 1 to 5) on the mock stack, then
// measures "Reiniciar demo". Runs against the Vite dev server at the presentation viewport.
import { expect, test, type Page } from '@playwright/test';

const PLAN = 'plan-maria';

async function openFresh(page: Page, route: string) {
  await page.goto(`/?reset=1#/${route}`);
  await expect(page.getByTestId('demo-badge')).toBeVisible();
}

test.describe('Demo script (brief §4) on mocks', () => {
  test('steps 1–5 end to end, then reset under 10 s', async ({ page }) => {
    test.setTimeout(180_000);

    // ---------- Step 1: buyer calendar in the seeded state ----------
    await openFresh(page, 'comprador');
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 15_000 });
    for (const n of [1, 2, 3]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'pagado');
    for (const n of [4, 5, 6]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'bloqueado');
    for (const n of [7, 8, 9]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'ofrecido');
    for (const n of [10, 11, 24]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'abierto');
    await expect(page.getByTestId('renewal-banner')).toBeVisible();
    await expect(page.getByTestId('next-payment-usd')).toContainText('1.188,33');
    await expect(page.getByTestId('next-payment-cop')).toContainText('4.093.125');
    await expect(page.getByTestId('demo-today')).toContainText('2026');
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');

    // Installment card for M4: COP due, USD at locked rate, today's rate, difference in COP
    await page.getByTestId('calendar-cell-4').click();
    const card = page.getByTestId('cell-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('4.093.125');
    await expect(card).toContainText('1.188,33');
    await expect(card).toContainText('3.444,427');
    await expect(card).toContainText('3.422,325');
    await page.getByTestId('cell-card-close').click();
    await expect(card).toBeHidden();

    // ---------- Step 2: accept the Q3 quarterly lock ----------
    await page.getByTestId('renewal-accept').click();
    const quote = page.getByTestId('lock-quote');
    await expect(quote).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('lock-quote-usd')).toContainText('1.188,33');
    await expect(page.getByTestId('lock-quote-rate')).toContainText('3.444,427');
    await expect(page.getByTestId('lock-countdown')).toHaveText(/^(10:00|09:5\d)$/);
    const disclosures = page.getByTestId('lock-disclosures');
    await expect(disclosures).toContainText(/gracia/i); // break rule
    await expect(disclosures).toContainText(/prima de certeza/i); // certainty premium
    await expect(disclosures).toContainText(/SMMLV/); // VIS price adjustment not locked
    await page.getByTestId('lock-accept').click();
    for (const n of [7, 8, 9]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'bloqueado', { timeout: 15_000 });
    await expect(page.getByTestId('renewal-banner')).toBeHidden();

    // ---------- Step 3: advance one month, pay M4 ----------
    await expect(page.getByTestId('pay-button')).toBeDisabled();
    await page.getByTestId('demo-advance').click();
    await expect(page.getByTestId('demo-today')).toContainText('nov');
    const pay = page.getByTestId('pay-button');
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    await expect(pay).toContainText('1.188,33');
    await pay.click();
    await page.getByTestId('pay-confirm').click();
    await expect(page.getByTestId('pay-step-recibido')).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
    await expect(page.getByTestId('pay-step-convertido')).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
    await expect(page.getByTestId('pay-step-entregado')).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
    const receipt = page.getByTestId('receipt');
    await expect(receipt).toBeVisible();
    await expect(page.getByTestId('receipt-locked-rate')).toContainText('3.444,427');
    await expect(page.getByTestId('receipt-today-rate')).toContainText('3.398,610');
    await expect(page.getByTestId('receipt-cop')).toContainText('4.093.125');
    await page.getByTestId('receipt-tech-toggle').click();
    await expect(receipt).toContainText('lock-maria-q2');
    await page.getByTestId('receipt-close').click();
    await expect(page.getByTestId('calendar-cell-4')).toHaveAttribute('data-state', 'pagado', { timeout: 15_000 });
    await expect(page.getByTestId('receipts-list')).toContainText('4.093.125');

    // Buyer screens: no crypto vocabulary in the rendered text
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toMatch(/\b(wallet|billetera|usdc|token|blockchain|hash|stellar)\b/i);

    // ---------- Step 4: treasury books the new Q3 legs ----------
    await page.getByTestId('nav-tesoreria').click();
    await expect(page.getByTestId('hedge-book')).toBeVisible({ timeout: 15_000 });
    const pendingBefore = page.locator('[data-testid^="leg-"][data-state="pendiente"]');
    await expect(pendingBefore).toHaveCount(3);
    await expect(page.getByTestId('unhedged-total')).not.toContainText('USD 0,00');
    await page.getByTestId('book-strip').click();
    await expect(page.getByTestId('book-strip-success')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="leg-"][data-state="pendiente"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('unhedged-total')).toContainText('0,00');
    await expect(page.getByTestId('margin-booked')).not.toContainText('COP 0');

    // ---------- Step 5: builder/trust sees M4 reconciled ----------
    await page.getByTestId('nav-constructora').click();
    await expect(page.getByTestId('recon-table')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('project-filter').selectOption({ label: 'Parque Natura' });
    const row = page.getByTestId(`recon-row-${PLAN}-4`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'conciliado');
    await expect(row).toContainText('FD-OLV-0142');
    await expect(row).toContainText('4.093.125');
    // edge cases from the seed are visible too
    await page.getByTestId('project-filter').selectOption({ index: 0 });
    await expect(page.locator('[data-testid^="recon-row-"][data-status="diferencia"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="recon-row-"][data-status="pendiente"]')).toHaveCount(1);
    // empty state
    await page.getByTestId('project-filter').selectOption({ label: 'Parque Natura' });
    await page.getByTestId('status-filter').selectOption('pendiente');
    await expect(page.getByTestId('recon-empty')).toBeVisible();

    // ---------- Reiniciar demo: back to step 1 in under 10 s ----------
    await page.getByTestId('nav-comprador').click();
    await expect(page.getByTestId('calendar-cell-4')).toHaveAttribute('data-state', 'pagado', { timeout: 15_000 });
    const t0 = Date.now();
    await page.getByTestId('demo-reset').click();
    for (const n of [7, 8, 9]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'ofrecido', { timeout: 10_000 });
    await expect(page.getByTestId('calendar-cell-4')).toHaveAttribute('data-state', 'bloqueado');
    await expect(page.getByTestId('renewal-banner')).toBeVisible();
    const elapsed = Date.now() - t0;
    const shown = await page.getByTestId('demo-reset-time').innerText();
    console.log(`Reiniciar demo: ${elapsed} ms wall clock until step-1 state visible; UI reported "${shown}"`);
    expect(elapsed).toBeLessThan(10_000);
  });

  test('expired quote returns to the tenor step with a message', async ({ page }) => {
    await openFresh(page, 'comprador');
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 15_000 });
    // Freeze time 11 minutes ahead after the quote is created, so the countdown expires on the next tick.
    await page.getByTestId('lock-open').click();
    await page.getByTestId('lock-tenor-mensual').click();
    await expect(page.getByTestId('lock-quote')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('lock-quote-usd')).toContainText('1.192,55');
    await page.evaluate(() => {
      const real = Date.now;
      (window as unknown as { __realNow: () => number }).__realNow = real;
      Date.now = () => real() + 11 * 60 * 1000;
    });
    await expect(page.getByTestId('lock-tenor-mensual')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/venció/i)).toBeVisible();
  });

  test('ES/EN toggle switches the UI language and number format', async ({ page }) => {
    await openFresh(page, 'comprador');
    await expect(page.getByTestId('next-payment-usd')).toContainText('1.188,33', { timeout: 15_000 });
    await page.getByTestId('lang-en').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('next-payment-usd')).toContainText('1,188.33');
    await expect(page.getByTestId('nav-comprador')).toHaveText('Buyer');
    await page.getByTestId('lang-es').click();
    await expect(page.getByTestId('nav-comprador')).toHaveText('Comprador');
  });

  test('error mode shows error states with retry, and recovers', async ({ page }) => {
    await openFresh(page, 'tesoreria');
    await expect(page.getByTestId('hedge-book')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('demo-error-mode').check();
    await expect(page.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('demo-error-mode').uncheck();
    await expect(page.getByTestId('hedge-book')).toBeVisible({ timeout: 15_000 });
  });

  test('buyer view at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openFresh(page, 'comprador');
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('next-payment-usd')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  });
});
