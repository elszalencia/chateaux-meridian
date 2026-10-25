// Seller gate states with their explanation, the payout-account cooling-off flow, and the CNR alert
// putting the seller's plans in "En pausa" (the brief's component checks for Vendedores).
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderOffice } from '../../shared/testing';
import { SellerDrawer } from './SellerDrawer';
import { api } from '../../../../app/api';

vi.mock('../../../../app/api', async () => {
  const { createMockApi } = await import('@chateaux/services');
  return { api: createMockApi({ minDelayMs: 0, maxDelayMs: 0 }), clearPersistedDemo: () => undefined, DEMO_MODE: 'mock' };
});

function drawer(sellerId: string) {
  return renderOffice(<SellerDrawer sellerId={sellerId} rows={[]} onClose={() => undefined} onChanged={() => undefined} onOpenPlan={() => undefined} refreshKey={0} />);
}

describe('seller drawer', () => {
  it.each([
    ['seller-brisas', 'seller_unverified', /Verificación pendiente/, /hasta terminar su verificación/],
    ['seller-los-abetos', 'seller_cooling_off', /Cambio de cuenta en espera/, /72 horas/],
    ['seller-altavista', 'cnr_alert', /Alerta registral \(CNR\)/, /nuevo gravamen inscrito/i],
  ])('%s shows gate %s with its explanation', async (id, gate, title, body) => {
    const { unmount } = drawer(id);
    const note = await screen.findByTestId('seller-gate');
    expect(note).toHaveAttribute('data-gate', gate);
    expect(note).toHaveTextContent(title);
    expect(note).toHaveTextContent(body);
    unmount();
  });

  it('a verified seller with nothing pending says payouts flow, and shows CNR data per unit', async () => {
    const { unmount } = drawer('seller-cuscatlan');
    expect(await screen.findByTestId('seller-gate-clear')).toBeInTheDocument();
    const unit = screen.getByTestId('seller-unit-unit-cedros-07b');
    expect(unit).toHaveTextContent('CNR-SS-2026-118342');
    expect(unit).toHaveTextContent(/[0-9a-f]{64}/);
    expect(screen.getByTestId('seller-legal-rep').textContent).not.toBe('');
    expect(screen.getByTestId('seller-option')).toHaveTextContent(/Opción B/);
    unmount();
  });

  it('changing the payout account starts the 72 h cooling-off ("Cambio en espera")', async () => {
    const { unmount } = drawer('seller-cuscatlan');
    fireEvent.click(await screen.findByTestId('payout-change-open'));
    fireEvent.change(screen.getByTestId('payout-field-institution'), { target: { value: 'Banco Agrícola' } });
    fireEvent.change(screen.getByTestId('payout-field-ref'), { target: { value: 'USD ••• 9031' } });
    fireEvent.click(screen.getByTestId('payout-change-submit'));
    expect(await screen.findByTestId('seller-notice')).toHaveTextContent(/Cambio en espera/);
    await waitFor(() => expect(screen.getByTestId('seller-gate')).toHaveAttribute('data-gate', 'seller_cooling_off'));
    expect(screen.getByTestId('seller-cooling-off')).toHaveTextContent(/Banco Agrícola/);
    const s = await api.getSeller('seller-cuscatlan');
    expect(s.payoutChangePendingUntil).not.toBeNull();
    expect(s.gate).toBe('seller_cooling_off');
    unmount();
  });

  it('a CNR alert puts the seller plans in En pausa', async () => {
    const before = await api.listPlanRows();
    expect(before.find((r) => r.plan.id === 'plan-doris')?.status).not.toBe('en_pausa');
    const { unmount } = drawer('seller-cuscatlan');
    fireEvent.click(await screen.findByTestId('cnr-raise-unit-cedros-03a'));
    expect(await screen.findByTestId('seller-notice')).toHaveTextContent(/en pausa/);
    const after = await api.listPlanRows();
    for (const id of ['plan-roxana', 'plan-doris']) expect(after.find((r) => r.plan.id === id)?.status).toBe('en_pausa');
    expect(await screen.findByTestId('cnr-alert')).toHaveTextContent('Nuevo gravamen inscrito');
    unmount();
  });

  it('a rejected seller is final: no moves, no account change', async () => {
    await api.setSellerVerification('seller-brisas', 'rejected');
    const { unmount } = drawer('seller-brisas');
    expect(await screen.findByTestId('seller-rejected-final')).toBeInTheDocument();
    expect(screen.queryByTestId('seller-verified')).toBeNull();
    expect(screen.queryByTestId('payout-change-open')).toBeNull();
    unmount();
  });
});