// The outbox lists every seeded message with time, plan, template, link and the simulado marker.
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderOffice } from '../../shared/testing';
import { OutboxTab } from './OutboxTab';
import { api } from '../../../../app/api';

vi.mock('../../../../app/api', async () => {
  const { createMockApi } = await import('@casa-puente/services');
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
    }
  });
});