// Adverse-event states on the mock seed: the builder / trust view shows each plan state with its
// reason in plain language and the recent policy events; the buyer view shows each adverse buyer a
// notice with the next step and disables money actions where the plan is blocked; the demo bar's
// "Ver como" switches buyers. Every adverse buyer screen is also scanned with axe (no serious or
// critical issues allowed).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function seriousOrCritical(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  console.log(`[axe] ${label}: ${result.violations.length === 0 ? 'no violations' : result.violations.map((v) => `${v.impact} ${v.id}`).join(', ')}`);
  return bad.map((v) => `${label}: ${v.impact} ${v.id} -> ${v.nodes.map((n) => JSON.stringify(n.target)).join(', ')}`);
}

async function openBuyer(page: Page, planId: string) {
  await page.goto(`/?reset=1#/comprador/${planId}`);
  await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 15_000 });
}

test.describe('Adverse-event states on mocks', () => {
  test('builder / trust view: state, reason and events per plan', async ({ page }) => {
    await page.goto('/?reset=1#/constructora');
    await expect(page.getByTestId('unit-card-plan-luis')).toBeVisible({ timeout: 15_000 });
    const expected: [string, string, RegExp][] = [
      ['plan-luis', 'delinquent', /Cuota sin pagar después del periodo de gracia/],
      ['plan-paola', 'on_hold', /Verificación de identidad en curso/],
      ['plan-jorge', 'defaulted', /Varias cuotas sin pagar/],
      ['plan-natalia', 'cancelled', /Desistimiento del comprador/],
    ];
    for (const [plan, state, reason] of expected) {
      await expect(page.getByTestId(`plan-state-${plan}`)).toHaveAttribute('data-state', state);
      await expect(page.getByTestId(`plan-reason-${plan}`)).toHaveText(reason);
      await expect(page.getByTestId(`plan-events-${plan}`).locator('li').first()).toBeVisible();
    }
    // Plans in good standing keep the Stage 1 badges.
    await expect(page.getByTestId('plan-state-plan-maria')).toHaveCount(0);
    await expect(page.getByTestId('unit-card-plan-luis')).toContainText('Condonadas');
    await expect(page.getByTestId('unit-card-plan-natalia')).toContainText('Retenido para el comprador');
    expect(await seriousOrCritical(page, 'constructora (adverse)')).toEqual([]);
  });

  test('buyer notices with next steps; blocked plans cannot pay', async ({ page }) => {
    test.setTimeout(150_000);
    const problems: string[] = [];

    await openBuyer(page, 'plan-andres');
    await expect(page.getByTestId('notice-late_in_grace')).toContainText('La cuota 5 está pendiente');
    await expect(page.getByTestId('notice-late_in_grace')).toContainText('Qué hacer');
    problems.push(...(await seriousOrCritical(page, 'comprador: late in grace')));

    await openBuyer(page, 'plan-luis');
    await expect(page.getByTestId('notice-missed')).toContainText('La cuota 4 quedó sin pagar');
    await expect(page.getByTestId('calendar-cell-4')).toHaveAttribute('data-state', 'no_pagado');
    await expect(page.getByTestId('calendar-cell-3')).toHaveAttribute('data-state', 'condonado');
    await expect(page.getByTestId('pay-button')).toBeDisabled();
    await page.getByTestId('calendar-cell-3').click();
    await expect(page.getByTestId('cell-card')).toContainText('no tienes que pagarla');
    problems.push(...(await seriousOrCritical(page, 'comprador: missed, waived card')));
    await page.getByTestId('cell-card-close').click();

    await openBuyer(page, 'plan-paola');
    await expect(page.getByTestId('notice-on_hold')).toContainText('Tu plan está en pausa');
    await expect(page.getByTestId('notice-on_hold')).toContainText('Verificación de identidad en curso');
    await expect(page.getByTestId('actions-blocked')).toBeVisible();
    await expect(page.getByTestId('pay-button')).toBeDisabled();
    await expect(page.getByTestId('lock-open')).toBeDisabled();
    await expect(page.getByTestId('pay-ahead-button')).toBeDisabled();
    problems.push(...(await seriousOrCritical(page, 'comprador: on hold')));

    await openBuyer(page, 'plan-jorge');
    await expect(page.getByTestId('notice-defaulted')).toContainText('Tu plan necesita atención');
    problems.push(...(await seriousOrCritical(page, 'comprador: defaulted')));

    await openBuyer(page, 'plan-natalia');
    await expect(page.getByTestId('notice-cancelled')).toContainText('Desistimiento del comprador');
    await expect(page.getByTestId('notice-cancelled')).toContainText('746,83');
    problems.push(...(await seriousOrCritical(page, 'comprador: cancelled')));

    // The buyer screens never name the plumbing, adverse states included.
    const text = (await page.locator('main').innerText()).toLowerCase();
    expect(text).not.toMatch(/\b(wallet|usdc|token|blockchain|hash|stellar)\b/);
    expect(problems).toEqual([]);
  });

  test('"Ver como" switches the buyer and María stays the default', async ({ page }) => {
    await page.goto('/?reset=1#/comprador');
    await expect(page.getByTestId('calendar')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('adverse-notices')).toHaveCount(0);
    await page.getByTestId('demo-buyer').selectOption('plan-paola');
    await expect(page).toHaveURL(/#\/comprador\/plan-paola$/);
    await expect(page.getByTestId('notice-on_hold')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('nav-constructora').click();
    await expect(page.getByTestId('demo-buyer')).toHaveCount(0);
  });
});
