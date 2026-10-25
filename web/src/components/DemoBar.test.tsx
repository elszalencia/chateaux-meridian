// The presenter bar names the corridor of the plan on screen: a deep link to a Salvadoran plan
// moves the bar off "Colombia", and a manual switch moves the buyer view to that corridor's buyer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PLAN_BY_CORRIDOR, PLAN_ROXANA } from '@chateaux/services';
import CompradorPortal from '../portals/comprador/CompradorPortal';
import { renderWithProviders } from '../portals/comprador/test-utils';
import { DemoBar } from './DemoBar';

vi.mock('../app/api', async () => {
  const { createMockApi } = await import('@chateaux/services');
  return { api: createMockApi({ minDelayMs: 0, maxDelayMs: 0 }), clearPersistedDemo: () => undefined, DEMO_MODE: 'mock' };
});

beforeEach(() => {
  window.localStorage.setItem('chateaux-demo-corridor', 'co');
});
afterEach(() => {
  window.location.hash = '';
  window.localStorage.clear();
});

describe('presenter corridor', () => {
  it('follows a deep link to a plan of the other corridor', async () => {
    window.location.hash = `#/c/${PLAN_ROXANA}/pagar`;
    renderWithProviders(
      <>
        <DemoBar />
        <CompradorPortal />
      </>,
    );
    const select = screen.getByTestId('demo-corridor');
    await waitFor(() => expect(select).toHaveValue('sv'));
    expect(window.localStorage.getItem('chateaux-demo-corridor')).toBe('sv');
  });

  it('a manual switch while a plan is open moves the buyer view to the chosen corridor', async () => {
    window.location.hash = `#/comprador/${PLAN_ROXANA}`;
    renderWithProviders(
      <>
        <DemoBar />
        <CompradorPortal />
      </>,
    );
    const select = screen.getByTestId('demo-corridor');
    await waitFor(() => expect(select).toHaveValue('sv'));
    fireEvent.change(select, { target: { value: 'co' } });
    await waitFor(() => expect(window.location.hash).toBe('#/comprador'));
    await waitFor(() => expect(screen.getByTestId('demo-buyer')).toHaveValue(DEFAULT_PLAN_BY_CORRIDOR.co));
    expect(select).toHaveValue('co');
  });
});
