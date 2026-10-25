// The daily adverse-events run counts grace on each plan's own corridor calendar. Día del Padre,
// Wednesday 2026-06-17, is an asueto in El Salvador and a working day in Colombia, so for an
// installment due Tuesday 2026-06-16 the five business days of grace end on 2026-06-24 in El
// Salvador and on 2026-06-23 in Colombia.
import { describe, expect, it } from 'vitest';
import type { CorridorId } from '../corridors/index';
import { graceEndIn } from '../api/svApi';
import { CORRIDORS } from '../corridors/index';
import { isHoliday } from '../domain/holidays';
import type { Snapshot } from '../domain/types';
import { MemoryStore } from '../store/MemoryStore';
import { PLAN_MARVIN, buildSeed } from '../seed/fixtures';
import { defaultGovernance } from './transitions';
import { MockGovernanceProvider } from './GovernanceProvider';
import { NullPolicy } from './NullPolicy';
import { runAdverseEventsDaily } from './adverseEvents';

const DUE = '2026-06-16';

/** Marvin's plan alone, with one open installment due on DUE, in the given corridor. */
function oneRowPlan(corridor: CorridorId): Snapshot {
  const s = buildSeed();
  const plan = { ...s.plans.find((p) => p.id === PLAN_MARVIN)!, corridor };
  const row = { ...s.installments.find((i) => i.planId === PLAN_MARVIN && i.status === 'open')!, idx: 0, dueDate: DUE };
  return { ...s, plans: [plan], installments: [row], receipts: [], payments: [], payouts: [], wa_outbox: [], policy_events: [], plan_governance: [defaultGovernance(plan.id)] };
}

async function run(corridor: CorridorId, today: string) {
  const store = new MemoryStore(oneRowPlan(corridor));
  const provider = new MockGovernanceProvider({ store, today: () => today });
  const report = await runAdverseEventsDaily({ store, provider, policy: new NullPolicy(), today });
  return { report, row: (await store.all('installments'))[0]! };
}

describe('daily adverse-events job on the corridor calendar', () => {
  it('the fixture date is an SV holiday and not a Colombian one', () => {
    expect(isHoliday('2026-06-17', 'SV')).toBe(true);
    expect(isHoliday('2026-06-17', 'CO')).toBe(false);
    expect(graceEndIn(DUE, CORRIDORS.sv)).toBe('2026-06-24');
    expect(graceEndIn(DUE, CORRIDORS.co)).toBe('2026-06-23');
  });

  it('an SV plan is still in grace on 2026-06-24 because of the asueto: a late notice, no mark_missed', async () => {
    const { report, row } = await run('sv', '2026-06-24');
    expect(report.executed).toEqual([]);
    expect(report.recorded.map((e) => e.kind)).toEqual(['late_in_grace']);
    expect(row.status).toBe('open');
  });

  it('the same SV plan is marked missed the next business day', async () => {
    const { report, row } = await run('sv', '2026-06-25');
    expect(report.executed.map((e) => e.kind)).toEqual(['mark_missed']);
    expect(row.status).toBe('missed');
  });

  it('on the Colombian calendar the same dates are already beyond grace on 2026-06-24', async () => {
    const { report, row } = await run('co', '2026-06-24');
    expect(report.executed.map((e) => e.kind)).toEqual(['mark_missed']);
    expect(row.status).toBe('missed');
  });
});
