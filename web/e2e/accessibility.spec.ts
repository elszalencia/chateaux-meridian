// Accessibility audit (axe-core) of the three views and the buyer's two dialogs at the presentation
// viewport, locale es-CO. Serious and critical violations fail the test; moderate and minor ones are
// printed so the report can list them. Each scan is also labelled so a failure says which state broke.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type Violation = {
  id: string;
  impact?: string | null;
  help: string;
  nodes: { target: unknown[]; failureSummary?: string }[];
};

const FAILING = new Set(['serious', 'critical']);

async function scan(page: Page, label: string): Promise<Violation[]> {
  const result = await new AxeBuilder({ page }).analyze();
  const violations = result.violations as Violation[];
  const counts: Record<string, number> = {};
  for (const v of violations) counts[v.impact ?? 'unknown'] = (counts[v.impact ?? 'unknown'] ?? 0) + v.nodes.length;
  console.log(`[axe] ${label}: ${violations.length === 0 ? 'no violations' : JSON.stringify(counts)}`);
  for (const v of violations) {
    const level = FAILING.has(v.impact ?? '') ? 'FAIL' : 'note';
    console.log(`[axe]   ${level} ${v.impact} ${v.id} (${v.nodes.length} nodes): ${v.help}`);
    for (const n of v.nodes.slice(0, 4)) console.log(`[axe]       ${JSON.stringify(n.target)}`);
  }
  return violations;
}

function failing(violations: Violation[]): string[] {
  return violations.filter((v) => FAILING.has(v.impact ?? '')).map((v) => `${v.impact} ${v.id}: ${v.help} -> ${v.nodes.map((n) => JSON.stringify(n.target)).join(', ')}`);
}

test.describe('Accessibility (axe) at 1440x900, es-CO', () => {
  test('buyer view, installment card and lock quote', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?reset=1#/comprador');
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('renewal-banner')).toBeVisible();
    const view = await scan(page, 'comprador');

    await page.getByTestId('calendar-cell-4').click();
    await expect(page.getByTestId('cell-card')).toBeVisible();
    const card = await scan(page, 'comprador: installment card');
    await page.getByTestId('cell-card-close').click();
    await expect(page.getByTestId('cell-card')).toBeHidden();

    await page.getByTestId('lock-open').click();
    await expect(page.getByTestId('lock-tenor-mensual')).toBeVisible();
    const tenor = await scan(page, 'comprador: lock tenor step');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    await page.getByTestId('renewal-accept').click();
    await expect(page.getByTestId('lock-quote')).toBeVisible({ timeout: 15_000 });
    const quote = await scan(page, 'comprador: lock quote');

    expect([...failing(view), ...failing(card), ...failing(tenor), ...failing(quote)]).toEqual([]);
  });

  test('builder / trust view', async ({ page }) => {
    await page.goto('/?reset=1#/constructora');
    await expect(page.getByTestId('recon-table')).toBeVisible({ timeout: 15_000 });
    expect(failing(await scan(page, 'constructora'))).toEqual([]);
  });

  test('treasury view', async ({ page }) => {
    await page.goto('/?reset=1#/tesoreria');
    await expect(page.getByTestId('hedge-book')).toBeVisible({ timeout: 15_000 });
    expect(failing(await scan(page, 'tesoreria'))).toEqual([]);
  });

  test('payment dialog keeps keyboard focus through the three progress steps', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/?reset=1#/comprador');
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('demo-advance').click();
    const pay = page.getByTestId('pay-button');
    await expect(pay).toBeEnabled({ timeout: 15_000 });
    await pay.click();
    // Opening moves focus to the dialog panel once.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await page.getByTestId('pay-confirm').click();
    // The confirm button unmounts, so focus is handed back to the panel; from there the user tabs to
    // the close button and must stay on it while the three steps complete.
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Tab');
    const closeButton = dialog.getByRole('button').first();
    await expect(closeButton).toBeFocused();
    for (const step of ['recibido', 'convertido', 'entregado']) {
      await expect(page.getByTestId(`pay-step-${step}`)).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
      await expect(closeButton).toBeFocused();
    }
    await expect(page.getByTestId('receipt')).toBeVisible();
    await expect(closeButton).toBeFocused();
    // Escape closes and focus returns to the opener.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('pay-button')).toBeFocused();
  });
});
