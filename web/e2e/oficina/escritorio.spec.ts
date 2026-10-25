// Oficina · Escritorio at 1440×900, keyboard first: Ctrl+K search, Esc closes the drawer, the seed
// edge cases on the desk (pending and expired cash references, the blocked attempt above the cash
// limit, the CNR alert and plan on hold, the payout-account cooling-off, payouts in transit and in
// error), the reconciliation line on every payout, the outbox, and the three irreversible actions
// behind a modal.
import { expect, test, type Page } from '@playwright/test';

test.use({ viewport: { width: 1440, height: 900 } });

async function openDesk(page: Page) {
  await page.goto('/?reset=1#/oficina');
  await expect(page.getByTestId('escritorio')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('plan-row-plan-roxana')).toBeVisible();
}

test('keyboard: Ctrl+K opens a plan, Esc closes the drawer', async ({ page }) => {
  await openDesk(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('desk-search')).toBeFocused();
  await page.keyboard.type('Roxana');
  await page.keyboard.press('Enter');
  const drawer = page.getByTestId('plan-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId('plan-schedule')).toContainText('M24');
  // Seed edge cases on Roxana's M6: pending reference (over 10 min) and an expired one.
  await expect(drawer.getByTestId('payment-pay-plan-roxana-5-pending')).toBeVisible();
  await expect(drawer.getByTestId('payment-pending-long')).toBeVisible();
  await expect(drawer.getByTestId('payment-pay-plan-roxana-5-expired')).toContainText(/Referencia vencida/);
  await expect(drawer.getByTestId('plan-whatsapp')).toContainText('Referencia MoneyGram');
  await expect(drawer.getByTestId('plan-corridor-views')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Marvin: blocked cash attempt above the limit, late inside grace.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('3015550129');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('payment-pay-plan-marvin-3-blocked')).toContainText(/USD 950/);
  await expect(page.getByTestId('plan-schedule')).toContainText('En gracia');
  await page.keyboard.press('Escape');

  // Colombia plan: its views open from the drawer; the desk lists the Colombia tabs.
  await page.getByTestId('plan-open-plan-maria').click();
  await expect(page.getByTestId('plan-corridor-views')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('desk-tab-constructora')).toBeVisible();
  await expect(page.getByTestId('desk-tab-tesoreria')).toBeVisible();
});

test('planes filters by corridor, status and due date', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('filter-status').selectOption('en_pausa');
  await expect(page.getByTestId('plan-row-plan-oscar')).toBeVisible();
  await expect(page.getByTestId('plan-row-plan-roxana')).toHaveCount(0);
  await page.getByTestId('filter-corridor').selectOption('co');
  await expect(page.getByTestId('plan-row-plan-oscar')).toHaveCount(0);
  await page.getByTestId('filter-clear').click();
  await page.getByTestId('filter-status').selectOption('atrasado');
  await expect(page.getByTestId('plan-row-plan-marvin')).toBeVisible();
  await page.getByTestId('filter-clear').click();
  await page.getByTestId('filter-due').fill('2026-10-24');
  await expect(page.getByTestId('plan-row-plan-roxana')).toBeVisible();
  await expect(page.getByTestId('plan-row-plan-doris')).toHaveCount(0);
});

test('pagos al vendedor: reconciliation on every payout, in transit and in error, retry', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('desk-tab-pagos').click();
  const lines = page.getByTestId('recon-line');
  await expect(lines.first()).toBeVisible();
  const count = await lines.count();
  expect(count).toBeGreaterThanOrEqual(10);
  await expect(page.locator('[data-testid="recon-line"][data-reconciles="false"]')).toHaveCount(0);
  await expect(page.getByTestId('payout-payout-plan-roxana-4')).toHaveAttribute('data-status', 'en_transito');
  const err = page.getByTestId('payout-payout-plan-roxana-3');
  await expect(err).toHaveAttribute('data-status', 'error');
  await expect(err.getByTestId('payout-error-detail')).toBeVisible();
  await expect(err).toContainText(/USD 754[.,]99 pagado − USD 4[.,]99 cargo = USD 750[.,]00 al vendedor/);
  await err.getByTestId('payout-retry-payout-plan-roxana-3').click();
  await expect(page.getByTestId('payout-payout-plan-roxana-3')).not.toHaveAttribute('data-status', 'error');
});

test('a payout held by the seller gate explains the typed reason on retry', async ({ page }) => {
  // Take Marvin's late installment at the counter: the release runs and the gate holds it (cooling-off).
  await page.goto('/?reset=1#/oficina/mostrador');
  await page.getByTestId('counter-search').fill('3015550129');
  await page.getByTestId('charge-3').click();
  await page.getByTestId('tender-card').click();
  await page.getByTestId('pay-confirm').click();
  await expect(page.getByTestId('counter-receipt')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('oficina-surface-escritorio').click();
  await page.getByTestId('desk-tab-pagos').click();
  const held = page.getByTestId('payout-payout-plan-marvin-3');
  await expect(held).toHaveAttribute('data-status', 'retenido');
  await held.getByTestId('payout-retry-payout-plan-marvin-3').click();
  await expect(page.getByTestId('payout-retry-gate')).toHaveAttribute('data-gate', 'seller_cooling_off');
  await expect(page.getByTestId('payout-retry-gate')).toContainText('72 horas');
});

test('vendedores: gate states, cooling-off, CNR alert pauses plans, reject is final behind a modal', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('desk-tab-vendedores').click();
  await expect(page.getByTestId('seller-row-seller-brisas')).toHaveAttribute('data-status', 'pending');

  // Seed: cooling-off on Los Abetos.
  await page.getByTestId('seller-open-seller-los-abetos').click();
  await expect(page.getByTestId('seller-gate')).toHaveAttribute('data-gate', 'seller_cooling_off');
  await expect(page.getByTestId('seller-cooling-off')).toContainText('Cambio en espera');
  await page.keyboard.press('Escape');

  // Seed: CNR alert on Altavista.
  await page.getByTestId('seller-open-seller-altavista').click();
  await expect(page.getByTestId('seller-gate')).toHaveAttribute('data-gate', 'cnr_alert');
  await expect(page.getByTestId('cnr-alert')).toContainText('Nuevo gravamen inscrito');
  await page.keyboard.press('Escape');

  // New payout-account change on Cuscatlán starts the 72 h cooling-off.
  await page.getByTestId('seller-open-seller-cuscatlan').click();
  await expect(page.getByTestId('seller-gate-clear')).toBeVisible();
  await page.getByTestId('payout-change-open').click();
  await page.getByTestId('payout-field-institution').fill('Banco Agrícola');
  await page.getByTestId('payout-field-ref').fill('USD ••• 9031');
  await page.getByTestId('payout-change-submit').click();
  await expect(page.getByTestId('seller-notice')).toContainText('Cambio en espera');
  await expect(page.getByTestId('seller-gate')).toHaveAttribute('data-gate', 'seller_cooling_off');

  // A CNR alert on a unit puts the seller's plans on hold.
  await page.getByTestId('cnr-raise-unit-cedros-07b').click();
  await expect(page.getByTestId('seller-notice')).toContainText('en pausa');
  await page.keyboard.press('Escape');
  await page.getByTestId('desk-tab-planes').click();
  await expect(page.getByTestId('plan-row-plan-roxana')).toHaveAttribute('data-status', 'en_pausa');

  // Reject Brisas: modal first, then final.
  await page.getByTestId('desk-tab-vendedores').click();
  await page.getByTestId('seller-open-seller-brisas').click();
  await expect(page.getByTestId('seller-gate')).toHaveAttribute('data-gate', 'seller_unverified');
  await page.getByTestId('seller-reject').click();
  await expect(page.getByTestId('confirm-modal')).toBeVisible();
  await page.getByTestId('confirm-modal-ok').click();
  await expect(page.getByTestId('seller-rejected-final')).toBeVisible();
});

test('plan actions: pause and resume from the drawer, cancel behind a modal', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('plan-open-plan-doris').click();
  await page.getByTestId('action-place_hold').click();
  await expect(page.getByTestId('action-done')).toBeVisible();
  await expect(page.getByTestId('plan-whatsapp')).toContainText('Plan en pausa');
  await page.getByTestId('action-lift_hold').click();
  await expect(page.getByTestId('action-place_hold')).toBeVisible();
  await page.getByTestId('action-cancel_plan').click();
  await expect(page.getByTestId('confirm-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('confirm-modal')).toBeHidden();
  await expect(page.getByTestId('plan-drawer')).toBeVisible();
});

test('outbox lists the seeded messages, each marked simulado', async ({ page }) => {
  await openDesk(page);
  await page.getByTestId('desk-tab-mensajes').click();
  const items = page.locator('[data-testid^="outbox-wa-"]');
  await expect(items.first()).toBeVisible();
  const n = await items.count();
  expect(n).toBeGreaterThanOrEqual(5);
  for (let i = 0; i < n; i++) await expect(items.nth(i).getByTestId('simulado')).toBeVisible();
  await expect(page.getByTestId('outbox-list')).toContainText('#/c/plan-roxana/pagar');
});