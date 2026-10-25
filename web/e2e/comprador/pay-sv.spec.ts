// Comprador portal, El Salvador corridor, on the mock stack at the presentation viewport.
// Roxana pays M6 in cash from the WhatsApp deep link (#/c/<plan>/pagar): the pending reference,
// the demo control that completes it, and the receipt. Doris (Louisiana) never sees the cash
// option. Every new screen is scanned with axe and must have no violations at all; ES and EN render.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const ROXANA = 'plan-roxana';
const DORIS = 'plan-doris';
const FORBIDDEN = /\b(wallet|billetera|usdc|token|blockchain|hash|stellar|cripto|crypto)\b/i;

async function axe(page: Page, label: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).analyze();
  console.log(`[axe] ${label}: ${violations.length === 0 ? 'no violations' : violations.map((v) => `${v.impact} ${v.id} (${v.nodes.length})`).join(', ')}`);
  return violations.map((v) => `${label}: ${v.impact} ${v.id} -> ${v.nodes.map((n) => JSON.stringify(n.target)).join(', ')}`);
}

async function buyerText(page: Page): Promise<string> {
  return (await page.locator('#main').innerText()) + (await page.getByRole('dialog').allInnerTexts()).join(' ');
}

test.describe('Comprador · El Salvador (mock, 1440x900)', () => {
  test('Roxana pays M6 by MoneyGram from the pay link through completed to the receipt', async ({ page }) => {
    test.setTimeout(120_000);
    const issues: string[] = [];
    await page.goto(`/?reset=1#/c/${ROXANA}/pagar`);
    const sheet = page.getByTestId('pay-sheet');
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    await expect(sheet).toHaveAttribute('data-idx', '5');
    await expect(page.getByTestId('method-moneygram_cash')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="method-"][data-enabled]')).toHaveCount(3);
    issues.push(...(await axe(page, 'pay sheet: methods')));

    await page.getByTestId('method-moneygram_cash').click();
    const panel = page.getByTestId('mg-panel');
    await expect(panel).toHaveAttribute('data-status', 'pending');
    await expect(page.getByTestId('mg-reference')).toHaveText('9062817345');
    await expect(page.getByTestId('mg-amount')).toContainText('USD 754,99');
    await expect(page.getByTestId('mg-countdown')).toHaveText(/^\d+:\d\d$/);
    issues.push(...(await axe(page, 'pay sheet: MoneyGram pending')));
    expect(await buyerText(page)).not.toMatch(FORBIDDEN);

    await page.getByTestId('mg-simulate-complete').click();
    await expect(page.getByTestId('pay-done')).toBeVisible({ timeout: 15_000 });
    const receipt = page.getByTestId('receipt');
    await expect(receipt).toContainText('USD 754,99');
    await expect(page.getByTestId('receipt-usd-to-seller')).toContainText('USD 750,00');
    await expect(page.getByTestId('receipt-fee')).toContainText('USD 4,99');
    await expect(page.getByTestId('receipt-method')).toContainText('MoneyGram');
    await expect(page.getByTestId('receipt-delivery')).toContainText('Se entrega al vendedor');
    issues.push(...(await axe(page, 'pay sheet: done with receipt')));

    await page.getByTestId('receipt-close').click();
    await expect(page.getByTestId('pay-sheet')).toBeHidden();
    await expect(page).toHaveURL(new RegExp(`#/comprador/${ROXANA}$`));
    await expect(page.getByTestId('calendar-cell-6')).toHaveAttribute('data-state', 'recibido');
    await expect(page.getByTestId('receipt-row-6')).toBeVisible();
    issues.push(...(await axe(page, 'home after payment')));

    // The receipt link from the message opens the same receipt.
    await page.getByTestId('receipt-open-6').click();
    await expect(page).toHaveURL(new RegExp(`#/c/${ROXANA}/recibo/5$`));
    await expect(page.getByTestId('receipt-sheet')).toBeVisible();
    issues.push(...(await axe(page, 'receipt deep link')));
    expect(await buyerText(page)).not.toMatch(FORBIDDEN);

    expect(issues).toEqual([]);
  });

  test('Doris (LA) sees no MoneyGram option', async ({ page }) => {
    test.setTimeout(90_000);
    const issues: string[] = [];
    await page.goto(`/?reset=1#/comprador/${DORIS}`);
    await expect(page.getByTestId('buyer-home')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('receipts-list')).toContainText('Aquí verás tus comprobantes');
    await expect(page.getByTestId('pay-opens')).toBeVisible();
    issues.push(...(await axe(page, 'home, buyer with no payments')));

    // Her first installment opens after the seed date: move the demo clock.
    await page.getByTestId('demo-advance').click();
    await expect(page.getByTestId('pay-button')).toBeEnabled({ timeout: 15_000 });
    await page.getByTestId('pay-button').click();
    await expect(page).toHaveURL(new RegExp(`#/c/${DORIS}/pagar$`));
    await expect(page.getByTestId('method-office_counter')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('method-ach')).toBeVisible();
    await expect(page.getByTestId('method-moneygram_cash')).toHaveCount(0);
    await expect(page.getByRole('dialog')).not.toContainText('MoneyGram');
    issues.push(...(await axe(page, 'pay sheet without MoneyGram')));

    await page.getByTestId('method-office_counter').click();
    await expect(page.getByTestId('counter-buyer-phone')).toContainText('(318) 555-0144');
    issues.push(...(await axe(page, 'pay sheet: counter')));
    expect(issues).toEqual([]);
  });

  test('home renders in Spanish and English', async ({ page }) => {
    await page.goto(`/?reset=1#/comprador/${ROXANA}`);
    await expect(page.getByTestId('next-payment-headline')).toContainText('Pagar USD 750,00 antes del', { timeout: 15_000 });
    await expect(page.getByTestId('property-badge')).toContainText('Propiedad verificada · CNR');
    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('next-payment-headline')).toContainText('Pay USD 750.00 by');
    await expect(page.getByTestId('property-badge')).toContainText('Property verified · CNR');
    expect(await axe(page, 'home in English')).toEqual([]);
    await page.getByTestId('lang-es').click();
    await expect(page.getByTestId('next-payment-headline')).toContainText('Pagar USD');
  });
});

test.describe('Comprador · El Salvador at 375 px (check)', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('no horizontal scroll and primary actions at least 44 px', async ({ page }) => {
    const small: string[] = [];
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const tall = async (testId: string) => {
      const box = await page.getByTestId(testId).boundingBox();
      if (!box || box.height < 44) small.push(`${testId}: ${box?.height ?? 'missing'} px`);
    };

    await page.goto(`/?reset=1#/comprador/${ROXANA}`);
    await expect(page.getByTestId('buyer-home')).toBeVisible({ timeout: 15_000 });
    expect(await overflow()).toBeLessThanOrEqual(2);
    await tall('pay-button');
    await tall('receipt-open-5');

    await page.getByTestId('pay-button').click();
    await expect(page.getByTestId('method-moneygram_cash')).toBeVisible({ timeout: 15_000 });
    expect(await overflow()).toBeLessThanOrEqual(2);
    for (const m of ['moneygram_cash', 'office_counter', 'ach']) await tall(`method-${m}`);
    await page.getByTestId('method-moneygram_cash').click();
    await expect(page.getByTestId('mg-reference')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(2);
    await tall('mg-simulate-complete');
    await tall('mg-locator');
    await tall('pay-back');
    await page.getByTestId('mg-simulate-complete').click();
    await expect(page.getByTestId('pay-done')).toBeVisible({ timeout: 15_000 });
    expect(await overflow()).toBeLessThanOrEqual(2);
    await tall('receipt-close');
    console.log(`[375] small targets: ${small.length === 0 ? 'none' : small.join('; ')}`);
    expect(small).toEqual([]);
  });
});
