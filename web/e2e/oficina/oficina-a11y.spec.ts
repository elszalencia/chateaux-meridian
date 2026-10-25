// Axe on every new office page (0 violations of any impact) and the report screenshots at
// 1180×820 (Mostrador) and 1440×900 (Escritorio), in Spanish and English.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'test-results/oficina-screens';

async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).analyze();
  for (const v of r.violations) console.log(`[axe] ${label}: ${v.impact} ${v.id} ${v.nodes.map((n) => JSON.stringify(n.target)).join(' ')}`);
  console.log(`[axe] ${label}: ${r.violations.length} violations`);
  expect(r.violations.map((v) => `${v.impact} ${v.id}`)).toEqual([]);
}

async function setLang(page: Page, lang: 'es' | 'en') {
  await page.getByTestId(`lang-${lang}`).click();
}

for (const lang of ['es', 'en'] as const) {
  test.describe(`Mostrador ${lang}`, () => {
    test.use({ viewport: { width: 1180, height: 820 }, hasTouch: true });
    test(`counter screens pass axe and render in ${lang}`, async ({ page }) => {
      await page.goto('/?reset=1#/oficina/mostrador');
      await expect(page.getByTestId('mostrador')).toBeVisible({ timeout: 15_000 });
      await setLang(page, lang);
      await expect(page.getByTestId('counter-search')).toBeVisible();
      await axe(page, `mostrador search ${lang}`);
      await page.getByTestId('counter-search').fill('5550000');
      await expect(page.getByTestId('counter-empty')).toBeVisible();
      await axe(page, `mostrador empty ${lang}`);
      await page.getByTestId('counter-search').fill('7035550187');
      await expect(page.getByTestId('buyer-card')).toBeVisible();
      await expect(page.getByTestId('charge-5')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/mostrador-card-1180x820-${lang}.png` });
      await axe(page, `mostrador card ${lang}`);
      await page.getByTestId('charge-5').tap();
      await page.getByTestId('quick-80000').tap();
      await page.screenshot({ path: `${SHOTS}/mostrador-pay-1180x820-${lang}.png` });
      await axe(page, `mostrador pay ${lang}`);
      await page.getByTestId('pay-confirm').tap();
      await expect(page.getByTestId('counter-receipt')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('receipt-whatsapp').tap();
      await expect(page.getByTestId('receipt-whatsapp-preview')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/mostrador-receipt-1180x820-${lang}.png` });
      await axe(page, `mostrador receipt ${lang}`);
    });
  });

  test.describe(`Escritorio ${lang}`, () => {
    test.use({ viewport: { width: 1440, height: 900 } });
    test(`desk screens pass axe and render in ${lang}`, async ({ page }) => {
      await page.goto('/?reset=1#/oficina/escritorio');
      await expect(page.getByTestId('plan-row-plan-roxana')).toBeVisible({ timeout: 15_000 });
      await setLang(page, lang);
      await page.screenshot({ path: `${SHOTS}/escritorio-planes-1440x900-${lang}.png` });
      await axe(page, `escritorio planes ${lang}`);
      await page.getByTestId('plan-open-plan-roxana').click();
      await expect(page.getByTestId('plan-payments')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/escritorio-plan-drawer-1440x900-${lang}.png` });
      await axe(page, `escritorio plan drawer ${lang}`);
      await page.keyboard.press('Escape');
      await page.getByTestId('desk-tab-vendedores').click();
      await page.getByTestId('seller-open-seller-altavista').click();
      await expect(page.getByTestId('cnr-alert')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/escritorio-seller-drawer-1440x900-${lang}.png` });
      await axe(page, `escritorio seller drawer ${lang}`);
      await page.keyboard.press('Escape');
      await axe(page, `escritorio vendedores ${lang}`);
      await page.getByTestId('desk-tab-pagos').click();
      await expect(page.getByTestId('payouts-list')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/escritorio-pagos-1440x900-${lang}.png`, fullPage: true });
      await axe(page, `escritorio pagos ${lang}`);
      await page.getByTestId('desk-tab-mensajes').click();
      await expect(page.getByTestId('outbox-list')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/escritorio-outbox-1440x900-${lang}.png` });
      await axe(page, `escritorio outbox ${lang}`);
      await page.getByTestId('plan-open-plan-roxana').waitFor({ state: 'detached' }).catch(() => undefined);
      await page.getByTestId('desk-tab-planes').click();
      await page.getByTestId('plan-open-plan-doris').click();
      await page.getByTestId('action-cancel_plan').click();
      await expect(page.getByTestId('confirm-modal')).toBeVisible();
      await axe(page, `escritorio confirm modal ${lang}`);
    });
  });
}