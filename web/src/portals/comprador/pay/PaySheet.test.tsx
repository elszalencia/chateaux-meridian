// Pay sheet states per method, against the in-memory services: the methods and their order come
// from getPayOptions; MoneyGram is hidden for Doris (LA) and disabled above USD 950; a pending
// reference credits the plan only when the cash-in completes; an expired one offers a new
// reference; the counter shows the office and the phone to give; ACH runs the pay flow.
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { CORRIDORS, PLAN_DORIS, PLAN_ROXANA, type DemoApi, type PayOptionsView } from '@chateaux/services';
import { freshApi, renderWithProviders } from '../test-utils';
import { PaySheet } from './PaySheet';

const h = vi.hoisted(() => ({ api: null as DemoApi | null }));
vi.mock('../../../app/api', async () => {
  const { apiProxy } = await import('../apiProxy');
  return { api: apiProxy(h), clearPersistedDemo: () => undefined, DEMO_MODE: 'mock' };
});

let api: DemoApi;
beforeEach(() => {
  api = freshApi();
  h.api = api;
});

async function openSheet(planId: string) {
  const view = await api.getPlan(planId);
  const onPaid = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(<PaySheet view={view} onPaid={onPaid} onClose={onClose} />);
  await screen.findByRole('list', { name: 'Formas de pago' });
  return { view, onPaid, onClose };
}

const methodIds = () => Array.from(document.querySelectorAll('[data-testid^="method-"][data-enabled]')).map((e) => e.getAttribute('data-testid'));

describe('PaySheet', () => {
  it('lists the methods in the order the services return them, with where, time and fee', async () => {
    await openSheet(PLAN_ROXANA);
    expect(methodIds()).toEqual(['method-moneygram_cash', 'method-office_counter', 'method-ach']);
    const mg = screen.getByTestId('method-moneygram_cash');
    expect(mg).toHaveTextContent('USD 754,99');
    expect(mg).toHaveTextContent('Comisión USD 4,99');
    expect(mg).toHaveTextContent('Dónde');
    expect(mg).toHaveTextContent('Cuánto tarda');
    expect(screen.getByTestId('method-office_counter')).toHaveTextContent('Sin comisión');
    expect(screen.getByTestId('method-ach')).toHaveTextContent('Comisión USD 1,50');
  });

  it('MoneyGram: pending reference, then completed; the plan is credited only at completion', async () => {
    const { onPaid } = await openSheet(PLAN_ROXANA);
    fireEvent.click(screen.getByTestId('method-moneygram_cash'));
    const panel = await screen.findByTestId('mg-panel');
    expect(panel).toHaveAttribute('data-status', 'pending');
    expect(screen.getByTestId('mg-reference')).toHaveTextContent('9062817345');
    expect(screen.getByTestId('mg-amount')).toHaveTextContent('USD 754,99');
    expect(screen.getByTestId('mg-countdown').textContent).toMatch(/^\d+:\d\d$/);
    // The locator comes from the corridor config, not from the dictionaries.
    expect(screen.getByTestId('mg-locator')).toHaveAttribute('href', CORRIDORS.sv.moneyGram!.locatorUrl);
    expect(CORRIDORS.sv.moneyGram!.locatorUrl).toMatch(/^https:\/\//);
    // Not credited while pending.
    expect((await api.getReceipts(PLAN_ROXANA)).some((r) => r.installmentIdx === 5)).toBe(false);

    fireEvent.click(screen.getByTestId('mg-simulate-complete'));
    await screen.findByTestId('pay-done');
    expect(onPaid).toHaveBeenCalled();
    const receipt = screen.getByTestId('receipt');
    expect(within(receipt).getByTestId('receipt-usd-to-seller')).toHaveTextContent('USD 750,00');
    expect(within(receipt).getByTestId('receipt-fee')).toHaveTextContent('USD 4,99');
    expect(within(receipt).getByTestId('receipt-method')).toHaveTextContent('Efectivo en MoneyGram');
    expect((await api.getReceipts(PLAN_ROXANA)).some((r) => r.installmentIdx === 5)).toBe(true);
    expect((await api.getPlan(PLAN_ROXANA)).installments[5]!.cellState).toBe('recibido');
  });

  it('MoneyGram: no reference yet, then one is requested', async () => {
    const options = await api.getPayOptions(PLAN_ROXANA, 5);
    vi.spyOn(api, 'getPayOptions').mockResolvedValue({ ...options, options: options.options.map((o) => ({ ...o, payment: null })) });
    const request = vi.spyOn(api, 'requestCashReference');
    await openSheet(PLAN_ROXANA);
    fireEvent.click(screen.getByTestId('method-moneygram_cash'));
    expect(await screen.findByTestId('mg-panel')).toHaveAttribute('data-status', 'none');
    fireEvent.click(screen.getByTestId('mg-request'));
    await waitFor(() => expect(screen.getByTestId('mg-panel')).toHaveAttribute('data-status', 'pending'));
    expect(request).toHaveBeenCalledWith(PLAN_ROXANA, 5);
    expect(screen.getByTestId('mg-reference').textContent).toMatch(/\d{6,}/);
  });

  it('MoneyGram: quote_expired offers "Nueva referencia" and renews it', async () => {
    const options = await api.getPayOptions(PLAN_ROXANA, 5);
    const mg = options.options[0]!;
    const expired = { ...mg.payment!, id: 'pay-expired', status: 'quote_expired' as const, externalRef: '7730451982' };
    vi.spyOn(api, 'getPayOptions').mockResolvedValue({ ...options, options: [{ ...mg, payment: expired }, ...options.options.slice(1)] });
    const fresh = { ...mg.payment!, id: 'pay-new', externalRef: '5550001111', status: 'pending' as const };
    const renew = vi.spyOn(api, 'renewCashReference').mockResolvedValue(fresh);
    await openSheet(PLAN_ROXANA);
    expect(screen.getByTestId('method-moneygram_cash')).toHaveTextContent('Tu última referencia venció');
    fireEvent.click(screen.getByTestId('method-moneygram_cash'));
    expect(await screen.findByTestId('mg-panel')).toHaveAttribute('data-status', 'quote_expired');
    expect(screen.getByTestId('mg-expired')).toHaveTextContent('7730451982');
    fireEvent.click(screen.getByRole('button', { name: 'Nueva referencia' }));
    await waitFor(() => expect(screen.getByTestId('mg-reference')).toHaveTextContent('5550001111'));
    expect(renew).toHaveBeenCalledWith('pay-expired');
  });

  it('MoneyGram is hidden for Doris (LA): the services do not list it', async () => {
    await api.advanceClock(1); // her first installment opens after the seed date
    await openSheet(PLAN_DORIS);
    expect(methodIds()).toEqual(['method-office_counter', 'method-ach']);
    expect(screen.queryByText(/MoneyGram/)).toBeNull();
  });

  it('MoneyGram above USD 950 is shown disabled with its reason and cannot be opened', async () => {
    const options = await api.getPayOptions(PLAN_ROXANA, 5);
    const above: PayOptionsView = {
      ...options,
      usdDue: 1000,
      options: options.options.map((o) => (o.method === 'moneygram_cash' ? { ...o, enabled: false, disabledReason: 'above_limit', payment: null, totalUsd: 1004.99 } : o)),
    };
    vi.spyOn(api, 'getPayOptions').mockResolvedValue(above);
    const request = vi.spyOn(api, 'requestCashReference');
    await openSheet(PLAN_ROXANA);
    const mg = screen.getByTestId('method-moneygram_cash');
    expect(mg).toHaveAttribute('data-enabled', 'false');
    expect(mg.tagName).not.toBe('BUTTON');
    expect(screen.getByTestId('method-moneygram_cash-reason')).toHaveTextContent('hasta USD 950,00');
    expect(screen.getByTestId('method-moneygram_cash-reason')).toHaveTextContent(/oficina o desde tu banco/);
    fireEvent.click(mg);
    expect(screen.queryByTestId('mg-panel')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it('office counter: nearest agency, hours and the phone number to give the cashier', async () => {
    await openSheet(PLAN_ROXANA);
    fireEvent.click(screen.getByTestId('method-office_counter'));
    await screen.findByTestId('counter-panel');
    expect(screen.getByTestId('counter-office')).toHaveTextContent('Maxi Envíos');
    expect(screen.getByTestId('counter-office')).toHaveTextContent('simulado');
    expect(screen.getByTestId('counter-hours').textContent).not.toBe('');
    expect(screen.getByTestId('counter-buyer-phone')).toHaveTextContent('(703) 555-0187');
  });

  it('ACH: confirm, progress, then the receipt', async () => {
    await openSheet(PLAN_ROXANA);
    fireEvent.click(screen.getByTestId('method-ach'));
    expect(await screen.findByTestId('ach-amount')).toHaveTextContent('USD 751,50');
    fireEvent.click(screen.getByTestId('pay-confirm'));
    await screen.findByTestId('pay-done');
    expect(screen.getByTestId('pay-step-recibido')).toHaveAttribute('data-done', 'true');
    expect(screen.getByTestId('receipt-method')).toHaveTextContent('Desde tu banco (ACH)');
    expect(screen.getByTestId('receipt-fee')).toHaveTextContent('USD 1,50');
  });

  it('shows the error with a retry when the options cannot load', async () => {
    vi.spyOn(api, 'getPayOptions').mockRejectedValueOnce(new Error('boom'));
    const view = await api.getPlan(PLAN_ROXANA);
    renderWithProviders(<PaySheet view={view} onPaid={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('list', { name: 'Formas de pago' });
  });

  it('says when paying opens instead of asking for options of an installment that is not payable', async () => {
    const spy = vi.spyOn(api, 'getPayOptions');
    const view = await api.getPlan(PLAN_DORIS);
    renderWithProviders(<PaySheet view={view} onPaid={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByTestId('pay-not-open')).toHaveTextContent('todavía no se puede pagar');
    expect(spy).not.toHaveBeenCalled();
  });
});
