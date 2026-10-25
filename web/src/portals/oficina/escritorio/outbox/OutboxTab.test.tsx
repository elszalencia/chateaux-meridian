// The outbox lists every seeded message with time, plan, template, link and the simulado marker.
// A message without template text shows the template's name and its parameters, not the raw body.
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { OFFICE_MAXI_WOODBRIDGE, PLAN_ROXANA } from '@chateaux/services';
import { renderOffice } from '../../shared/testing';
import { OutboxTab } from './OutboxTab';
import { api } from '../../../../app/api';

vi.mock('../../../../app/api', async () => {
  const { createMockApi } = await import('@chateaux/services');
  return { api: createMockApi({ minDelayMs: 0, maxDelayMs: 0 }), clearPersistedDemo: () => undefined, DEMO_MODE: 'mock' };
});

describe('outbox', () => {
  it('lists the seeded messages', async () => {
    const seeded = await api.listOutbox();
    expect(seeded.length).toBeGreaterThanOrEqual(5);
    const rows = await api.listPlanRows();
    renderOffice(<OutboxTab rows={rows} refreshKey={0} onOpenPlan={() => undefined} />);
    await screen.findByTestId('outbox-list');
    for (const m of seeded) {
      const item = screen.getByTestId(`outbox-${m.id}`);
      expect(item).toHaveAttribute('data-template', m.template);
      expect(within(item).getByRole('link')).toHaveAttribute('href', m.link);
      expect(within(item).getByTestId('simulado')).toBeInTheDocument();
      expect(item).toHaveTextContent(rows.find((r) => r.plan.id === m.planId)!.buyer.name);
      // the seed writes real text, shown as it is
      expect(item).toHaveTextContent(m.body.slice(0, 40));
    }
  });

  it('a message without template text shows its name and parameters, never the raw body', async () => {
    await api.takeCounterPayment({ planId: PLAN_ROXANA, idx: 5, tender: 'cash', amountReceived: 75_000, officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1' });
    const sent = (await api.listOutbox(PLAN_ROXANA)).find((m) => m.template === 'pago_recibido' && m.params.n === 6)!;
    expect(sent.body).toMatch(/^\[es\] pago_recibido/);
    renderOffice(<OutboxTab rows={await api.listPlanRows()} refreshKey={1} onOpenPlan={() => undefined} />);
    const item = await screen.findByTestId(`outbox-${sent.id}`);
    const summary = within(item).getByTestId('message-summary');
    expect(summary).toHaveTextContent('Pago recibido · datos del mensaje');
    expect(within(summary).getByText('Cuota')).toBeInTheDocument();
    expect(summary.querySelector('[data-param="n"]')).toHaveTextContent('6');
    expect(summary.querySelector('[data-param="usd"]')).toHaveTextContent('USD 750,00');
    expect(summary.querySelector('[data-param="link"]')).toBeNull();
    expect(item).not.toHaveTextContent('[es]');
    expect(item).not.toHaveTextContent('pago_recibido');
    expect(within(item).getByTestId('simulado')).toBeInTheDocument();
    expect(within(item).getByRole('link')).toHaveAttribute('href', sent.link);
  });
});