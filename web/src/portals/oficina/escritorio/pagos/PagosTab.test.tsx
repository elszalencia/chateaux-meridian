// Reconciliation line on every El Salvador payout in the seed (paid − fee = to seller), and the
// payouts in transit and in error visible with their details.
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { CORRIDORS } from '@chateaux/services';
import { renderOffice } from '../../shared/testing';
import { PagosTab } from './PagosTab';
import { api } from '../../../../app/api';

vi.mock('../../../../app/api', async () => {
  const { createMockApi } = await import('@chateaux/services');
  return { api: createMockApi({ minDelayMs: 0, maxDelayMs: 0 }), clearPersistedDemo: () => undefined, DEMO_MODE: 'mock' };
});

const cents = (n: number) => Math.round(n * 100);
const fmt = (n: number) => `USD ${n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

describe('pagos al vendedor', () => {
  it('shows paid − fee = to seller on every seeded payout, and it holds to the cent', async () => {
    const payouts = (await api.listPayouts()).filter((p) => CORRIDORS[p.corridor].payoutProviders.includes('usd-bank-payout'));
    expect(payouts.length).toBeGreaterThanOrEqual(10);
    renderOffice(<PagosTab refreshKey={0} onChanged={() => undefined} onOpenPlan={() => undefined} onOpenSeller={() => undefined} />);
    await screen.findByTestId('payouts-list');
    for (const p of payouts) {
      expect(cents(p.usdPaid) - cents(p.feeUsd)).toBe(cents(p.usdToSeller));
      const row = screen.getByTestId(`payout-${p.id}`);
      const line = within(row).getByTestId('recon-line');
      expect(line).toHaveAttribute('data-reconciles', 'true');
      expect(line).toHaveTextContent(`${fmt(p.usdPaid)} pagado − ${fmt(p.feeUsd)} cargo = ${fmt(p.usdToSeller)} al vendedor`);
    }
  });

  it('shows the payout in transit and the one in error with its reason and a retry', async () => {
    renderOffice(<PagosTab refreshKey={0} onChanged={() => undefined} onOpenPlan={() => undefined} onOpenSeller={() => undefined} />);
    const transit = await screen.findByTestId('payout-payout-plan-roxana-4');
    expect(transit).toHaveAttribute('data-status', 'en_transito');
    expect(transit).toHaveTextContent('En tránsito');
    const err = screen.getByTestId('payout-payout-plan-roxana-3');
    expect(err).toHaveAttribute('data-status', 'error');
    expect(within(err).getByTestId('payout-error-detail')).toHaveTextContent(/rechazada por el banco/);
    expect(within(err).getByTestId('payout-retry-payout-plan-roxana-3')).toBeInTheDocument();
    expect(err).toHaveTextContent('simulado');
  });
});