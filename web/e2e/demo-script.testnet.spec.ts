// Testnet end-to-end: the same demo script (steps 1 to 5) and the same data-testids as
// demo-script.spec.ts, against the UI in DEMO_MODE=testnet, where the lock, the deposit and the
// release are real `payment_plan` transactions on Stellar testnet. Skipped unless `.env.testnet`
// exists at the repo root and the RPC answers `getHealth`. Timeouts are generous: a transaction
// takes 5 to 15 s and "Reiniciar demo" replays about twenty of them.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const PLAN = 'plan-maria';
const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env.testnet');
const TX = 90_000; // one or two transactions
const PAY = 180_000; // mint + deposit + release

async function testnetAvailable(): Promise<{ ok: boolean; reason: string }> {
  if (!existsSync(ENV_FILE)) return { ok: false, reason: '.env.testnet not found (run npm run deploy:testnet)' };
  const rpc = /^STELLAR_RPC_URL=(\S+)/m.exec(readFileSync(ENV_FILE, 'utf8'))?.[1] ?? 'https://soroban-testnet.stellar.org';
  try {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
    const body = (await res.json()) as { result?: { status?: string } };
    return body.result?.status === 'healthy' ? { ok: true, reason: '' } : { ok: false, reason: `RPC ${rpc} not healthy` };
  } catch (e) {
    return { ok: false, reason: `RPC ${rpc} unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** The page must talk to the testnet server: a Vite left running in mock mode has no /api proxy. */
async function assertTestnetMode(page: Page) {
  const res = await page.request.get('/api/health');
  const body = res.ok() && (res.headers()['content-type'] ?? '').includes('json') ? ((await res.json()) as { mode?: string }) : null;
  expect(body?.mode, 'http://localhost:5174/api/health must answer mode=testnet; stop a mock-mode Vite on 5174').toBe('testnet');
}

async function openFresh(page: Page, route: string) {
  await page.goto(`/?reset=1#/${route}`);
  await expect(page.getByTestId('demo-badge')).toBeVisible();
}

test.describe('Demo script (brief §4) on Stellar testnet', () => {
  test('reset re-seeds the chain, then steps 1–5 end to end with real transactions', async ({ page }) => {
    const avail = await testnetAvailable();
    test.skip(!avail.ok, avail.reason);
    test.slow();
    test.setTimeout(900_000);
    const t = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
    await assertTestnetMode(page);

    // ---------- Reiniciar demo first: a chain plan can be walked through only once, so every run
    // re-seeds the three plans on chain (about twenty transactions) and times it ----------
    await openFresh(page, 'comprador');
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/testnet/i).first()).toBeVisible(); // the demo bar prints the mode
    const resetStart = Date.now();
    await page.getByTestId('demo-reset').click();
    await expect(page.getByTestId('demo-reset-time')).toBeVisible({ timeout: 420_000 });
    const shown = await page.getByTestId('demo-reset-time').innerText();
    console.log(`Reiniciar demo on testnet: ${t(Date.now() - resetStart)} wall clock; UI reported "${shown}"`);

    // ---------- Step 1: buyer calendar in the seeded state ----------
    for (const n of [1, 2, 3]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'pagado');
    for (const n of [4, 5, 6]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'bloqueado');
    for (const n of [7, 8, 9]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'ofrecido');
    for (const n of [10, 11, 24]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'abierto');
    await expect(page.getByTestId('renewal-banner')).toBeVisible();
    await expect(page.getByTestId('next-payment-usd')).toContainText('1.188,33');
    await expect(page.getByTestId('next-payment-cop')).toContainText('4.093.125');

    await page.getByTestId('calendar-cell-4').click();
    const card = page.getByTestId('cell-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('1.188,33');
    await expect(card).toContainText('3.444,427');
    await page.getByTestId('cell-card-close').click();
    await expect(card).toBeHidden();

    // ---------- Step 2: accept the Q3 quarterly lock → apply_lock on chain ----------
    await page.getByTestId('renewal-accept').click();
    await expect(page.getByTestId('lock-quote')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('lock-quote-usd')).toContainText('1.188,33');
    await expect(page.getByTestId('lock-quote-rate')).toContainText('3.444,427');
    const lockStart = Date.now();
    await page.getByTestId('lock-accept').click();
    for (const n of [7, 8, 9]) await expect(page.getByTestId(`calendar-cell-${n}`)).toHaveAttribute('data-state', 'bloqueado', { timeout: TX });
    await expect(page.getByTestId('renewal-banner')).toBeHidden();
    console.log(`apply_lock (Q3) visible in ${t(Date.now() - lockStart)}`);

    // ---------- Step 3: advance one month, pay M4 → mint, deposit, release_due ----------
    await expect(page.getByTestId('pay-button')).toBeDisabled();
    await page.getByTestId('demo-advance').click();
    await expect(page.getByTestId('demo-today')).toContainText('nov', { timeout: TX });
    const pay = page.getByTestId('pay-button');
    await expect(pay).toBeEnabled({ timeout: TX });
    await expect(pay).toContainText('1.188,33');
    const payStart = Date.now();
    await pay.click();
    await page.getByTestId('pay-confirm').click();
    await expect(page.getByTestId('pay-step-recibido')).toHaveAttribute('data-done', 'true', { timeout: PAY });
    console.log(`recibido (mint + deposit) in ${t(Date.now() - payStart)}`);
    await expect(page.getByTestId('pay-step-convertido')).toHaveAttribute('data-done', 'true', { timeout: PAY });
    await expect(page.getByTestId('pay-step-entregado')).toHaveAttribute('data-done', 'true', { timeout: PAY });
    console.log(`entregado (release_due) in ${t(Date.now() - payStart)}`);
    const receipt = page.getByTestId('receipt');
    await expect(receipt).toBeVisible();
    await expect(page.getByTestId('receipt-locked-rate')).toContainText('3.444,427');
    await expect(page.getByTestId('receipt-cop')).toContainText('4.093.125');
    await page.getByTestId('receipt-tech-toggle').click();
    await expect(receipt).toContainText('lock-maria-q2');
    const techText = await receipt.innerText();
    const hash = /\b[0-9a-f]{64}\b/.exec(techText)?.[0];
    console.log(`receipt tx hash ${hash ?? '(not shown)'}${hash ? ` https://stellar.expert/explorer/testnet/tx/${hash}` : ''}`);
    await page.getByTestId('receipt-close').click();
    await expect(page.getByTestId('calendar-cell-4')).toHaveAttribute('data-state', 'pagado', { timeout: TX });
    await expect(page.getByTestId('receipts-list')).toContainText('4.093.125');

    // ---------- Step 4: treasury books the new Q3 legs (mock hedge) ----------
    await page.getByTestId('nav-tesoreria').click();
    await expect(page.getByTestId('hedge-book')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="leg-"][data-state="pendiente"]')).toHaveCount(3);
    await page.getByTestId('book-strip').click();
    await expect(page.getByTestId('book-strip-success')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid^="leg-"][data-state="pendiente"]')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('unhedged-total')).toContainText('0,00');

    // ---------- Step 5: builder/trust sees M4 reconciled ----------
    await page.getByTestId('nav-constructora').click();
    await expect(page.getByTestId('recon-table')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('project-filter').selectOption({ label: 'Parque Natura' });
    const row = page.getByTestId(`recon-row-${PLAN}-4`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-status', 'conciliado');
    await expect(row).toContainText('4.093.125');

    // Back on the buyer view, M4 stays paid after the reconciliation.
    await page.getByTestId('nav-comprador').click();
    await expect(page.getByTestId('calendar-cell-4')).toHaveAttribute('data-state', 'pagado', { timeout: 30_000 });
  });
});
