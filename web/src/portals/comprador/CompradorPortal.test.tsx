// The portal picks the screen from the plan's corridor config, and the deep links open the pay
// sheet and one receipt for that plan. Receipts show the corridor's fields: the delivery status
// for a corridor without an FX leg, the unchanged rate receipt for one with locks. The technical
// details stay collapsed and are the only place the transaction reference appears.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PLAN_DORIS, PLAN_MARIA, PLAN_ROXANA, type DemoApi } from '@casa-puente/services';
import CompradorPortal from './CompradorPortal';
import { freshApi, renderWithProviders } from './test-utils';

const h = vi.hoisted(() => ({ api: null as DemoApi | null }));
vi.mock('../../app/api', async () => {
  const { apiProxy } = await import('./apiProxy');
  return { api: apiProxy(h), clearPersistedDemo: () => undefined, DEMO_MODE: 'mock' };
});

let api: DemoApi;
beforeEach(() => {
  api = freshApi();
  h.api = api;
});
afterEach(() => {
  window.location.hash = '';
});

function open(route: string, lang: 'es' | 'en' = 'es') {
  window.location.hash = route;
  return renderWithProviders(<CompradorPortal />, lang);
}

describe('routes', () => {
  it('#/comprador/<SV plan> opens the pay-sheet home without lock screens', async () => {
    open(`#/comprador/${PLAN_ROXANA}`);
    const home = await screen.findByTestId('buyer-home');
    expect(home).toHaveAttribute('data-corridor', 'sv');
    expect(screen.getByTestId('next-payment-headline')).toHaveTextContent('Pagar USD 750,00 antes del');
    expect(screen.getByTestId('property-badge')).toHaveTextContent('Propiedad verificada · CNR');
    expect(screen.getByTestId('property-badge')).toHaveTextContent('Revisado el');
    expect(screen.getByTestId('property-badge')).toHaveTextContent('simulado');
    expect(screen.queryByTestId('lock-open')).toBeNull();
    const legend = screen.getByRole('list', { name: 'Leyenda del calendario' });
    expect(legend).not.toHaveTextContent(/asegura|tasa/i);
    expect(document.querySelector('[data-state="bloqueado"], [data-state="ofrecido"], [data-state="roto"]')).toBeNull();
  });

  it('#/comprador/<CO plan> keeps the original buyer view', async () => {
    open(`#/comprador/${PLAN_MARIA}`);
    expect(await screen.findByTestId('lock-open')).toBeInTheDocument();
    expect(screen.queryByTestId('buyer-home')).toBeNull();
  });

  it('#/c/<plan>/pagar opens the pay sheet for that plan', async () => {
    open(`#/c/${PLAN_ROXANA}/pagar`);
    const sheet = await screen.findByTestId('pay-sheet');
    expect(sheet).toHaveAttribute('data-idx', '5');
    await within(sheet).findByTestId('method-moneygram_cash');
  });

  it('"Ver formas de pago" goes to the pay deep link, and closing the sheet returns home', async () => {
    open(`#/comprador/${PLAN_ROXANA}`);
    fireEvent.click(await screen.findByTestId('pay-button'));
    expect(window.location.hash).toBe(`#/c/${PLAN_ROXANA}/pagar`);
    await act(async () => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await screen.findByTestId('pay-sheet');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar' }));
    expect(window.location.hash).toBe(`#/comprador/${PLAN_ROXANA}`);
  });

  it('#/c/<plan>/recibo/<idx> opens that receipt', async () => {
    open(`#/c/${PLAN_ROXANA}/recibo/2`);
    const sheet = await screen.findByTestId('receipt-sheet');
    expect(sheet).toHaveAttribute('data-idx', '2');
    expect(await within(sheet).findByTestId('receipt')).toHaveTextContent('Comprobante · Cuota 3');
  });

  it('#/c/<plan>/recibo/<idx> without a receipt says so warmly', async () => {
    open(`#/c/${PLAN_DORIS}/recibo/0`);
    expect(await screen.findByText('Aún no hay comprobante de la cuota 1')).toBeInTheDocument();
  });

  it('a buyer with no payments sees a warm empty receipts list', async () => {
    open(`#/comprador/${PLAN_DORIS}`);
    await screen.findByTestId('buyer-home');
    await waitFor(() => expect(screen.getByTestId('receipts-list')).toHaveTextContent('Aquí verás tus comprobantes'));
  });
});

describe('receipt fields per corridor', () => {
  it('SV receipt: USD paid, fee, USD to the seller, delivery status, date, method, seller, unit', async () => {
    open(`#/c/${PLAN_ROXANA}/recibo/3`);
    const receipt = await screen.findByTestId('receipt');
    await waitFor(() => expect(within(receipt).getByTestId('receipt-delivery')).toHaveTextContent('rechazó la transferencia'));
    expect(receipt).toHaveTextContent('USD 754,99');
    expect(within(receipt).getByTestId('receipt-fee')).toHaveTextContent('USD 4,99');
    expect(within(receipt).getByTestId('receipt-usd-to-seller')).toHaveTextContent('USD 750,00');
    expect(within(receipt).getByTestId('receipt-seller')).toHaveTextContent('Desarrollos Cuscatlán');
    expect(within(receipt).getByTestId('receipt-unit')).toHaveTextContent('Torre Cedros');
    expect(within(receipt).getByTestId('receipt-method')).toHaveTextContent('Efectivo en MoneyGram');
    expect(receipt).toHaveTextContent('Fecha de pago');
    expect(receipt).not.toHaveTextContent(/tasa|COP|Declaración/i);
    expect(within(receipt).queryByTestId('receipt-locked-rate')).toBeNull();
  });

  it('SV receipt: delivery reads the payout (credited, in transit)', async () => {
    open(`#/c/${PLAN_ROXANA}/recibo/4`);
    const receipt = await screen.findByTestId('receipt');
    await waitFor(() => expect(within(receipt).getByTestId('receipt-delivery')).toHaveTextContent('En camino a la cuenta del vendedor'));
  });

  it('technical details are collapsed and hold the only transaction reference', async () => {
    open(`#/c/${PLAN_ROXANA}/recibo/0`);
    const receipt = await screen.findByTestId('receipt');
    const ref = (await api.getReceipts(PLAN_ROXANA)).find((r) => r.installmentIdx === 0)!;
    const txRef = String((ref as unknown as Record<string, unknown>)[['tx', 'Ha', 'sh'].join('')]);
    expect(receipt).not.toHaveTextContent(txRef);
    expect(receipt).not.toHaveTextContent('Referencia de transacción');
    fireEvent.click(within(receipt).getByTestId('receipt-tech-toggle'));
    expect(receipt).toHaveTextContent('Referencia de transacción');
    expect(receipt).toHaveTextContent(txRef);
    expect(receipt).not.toHaveTextContent('Identificador del aseguramiento');
  });

  it('CO receipt from a deep link is the unchanged rate receipt', async () => {
    open(`#/c/${PLAN_MARIA}/recibo/0`);
    const sheet = await screen.findByTestId('receipt-sheet');
    const receipt = await within(sheet).findByTestId('receipt');
    expect(within(receipt).getByTestId('receipt-locked-rate')).toBeInTheDocument();
    expect(within(receipt).getByTestId('receipt-cop')).toHaveTextContent('COP');
    expect(within(receipt).queryByTestId('receipt-usd-to-seller')).toBeNull();
  });

  it('renders in English too', async () => {
    open(`#/c/${PLAN_ROXANA}/recibo/3`, 'en');
    const receipt = await screen.findByTestId('receipt');
    expect(within(receipt).getByTestId('receipt-usd-to-seller')).toHaveTextContent('USD 750.00');
    expect(receipt).toHaveTextContent('USD to the seller');
  });
});
