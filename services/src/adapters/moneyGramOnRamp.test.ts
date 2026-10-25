// MoneyGramOnRamp without network: the widget-shaped session, its events, the limits from the
// corridor config, the TTL, the idempotent webhook, the two drivers, and the one rule that never
// bends: nothing reports `completed` before the network (or the stand-in anchor) says so.
import { describe, expect, it } from 'vitest';
import { corridor } from '../corridors/index';
import { MockProviderError, MockRuntime } from './mockRuntime';
import { MoneyGramError, MoneyGramOnRamp, type MoneyGramEventPayload, type StandInDepositRail } from './moneyGramOnRamp';

const LIMITS = corridor('sv').moneyGram!;
const T0 = Date.parse('2026-10-20T14:00:00Z');

function mock(t = { ms: T0 }) {
  const runtime = new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 });
  const mg = new MoneyGramOnRamp({ driver: 'mock', runtime, limits: LIMITS, feeUsd: 4.99, now: () => t.ms });
  return { mg, runtime, t };
}

const session = (mg: MoneyGramOnRamp, amountUsd = 750, buyerState: string | null = 'VA') =>
  mg.createSession({ customerIdentifier: 'buyer-roxana', buyerState, amountUsd, memo: 'CH-SV-0007B-M6', locale: 'es' });

describe('MoneyGramOnRamp (mock driver)', () => {
  it('issues a session with an eight-digit reference, the fee and a TTL from the config, and emits loaded + transaction_created', async () => {
    const { mg } = mock();
    const events: MoneyGramEventPayload[] = [];
    mg.on('loaded', (e) => events.push(e));
    mg.on('transaction_created', (e) => events.push(e));
    const s = await session(mg);
    expect(s.referenceNumber).toMatch(/^\d{8}$/);
    expect(s.sessionId).toMatch(/^mgs-/);
    expect(s.amountUsd).toBe(750);
    expect(s.feeUsd).toBe(4.99);
    expect(Date.parse(s.expiresAt) - T0).toBe(LIMITS.referenceTtlMinutes * 60_000);
    expect(s.widgetUrl).toContain(s.sessionId);
    expect(events.map((e) => e.event)).toEqual(['loaded', 'transaction_created']);
    expect(await mg.referenceStatus(s.referenceNumber)).toBe('pending');
  });

  it('is pending until the network completes it; completion emits once and never re-opens an expired reference', async () => {
    const { mg } = mock();
    const seen: string[] = [];
    mg.on('completed', (e) => seen.push(`completed:${e.referenceNumber}`));
    mg.on('expired', (e) => seen.push(`expired:${e.referenceNumber}`));
    const a = await session(mg);
    expect(await mg.referenceStatus(a.referenceNumber)).toBe('pending');
    expect(await mg.status(a.referenceNumber)).toBe('pending');
    await mg.simulateCompleted(a.referenceNumber);
    expect(await mg.referenceStatus(a.referenceNumber)).toBe('completed');
    await mg.simulateCompleted(a.referenceNumber); // idempotent
    const b = await session(mg);
    await mg.simulateExpired(b.referenceNumber);
    expect(await mg.referenceStatus(b.referenceNumber)).toBe('quote_expired');
    await mg.simulateCompleted(b.referenceNumber); // an expired reference cannot complete
    expect(await mg.referenceStatus(b.referenceNumber)).toBe('quote_expired');
    expect(await mg.status(b.referenceNumber)).toBe('error');
    expect(seen).toEqual([`completed:${a.referenceNumber}`, `expired:${b.referenceNumber}`]);
    // a new reference can be issued for the same installment
    const c = await session(mg);
    expect(c.referenceNumber).not.toBe(b.referenceNumber);
    expect(await mg.referenceStatus(c.referenceNumber)).toBe('pending');
  });

  it('expires a pending reference once the TTL has passed on the injected clock', async () => {
    const { mg, t } = mock();
    const s = await session(mg);
    t.ms = T0 + 59 * 60_000;
    expect(await mg.referenceStatus(s.referenceNumber)).toBe('pending');
    t.ms = T0 + 60 * 60_000;
    expect(await mg.referenceStatus(s.referenceNumber)).toBe('quote_expired');
  });

  it('is hidden for the four excluded states and blocked above 950 and below 5 USD, with typed errors', async () => {
    const { mg } = mock();
    for (const st of ['AK', 'HI', 'LA', 'NY']) {
      await expect(session(mg, 750, st)).rejects.toMatchObject({ code: 'STATE_EXCLUDED' });
      expect(MoneyGramOnRamp.check({ amountUsd: 750, buyerState: st }, LIMITS)).toBe('STATE_EXCLUDED');
    }
    await expect(session(mg, 950.01)).rejects.toBeInstanceOf(MoneyGramError);
    await expect(session(mg, 950.01)).rejects.toMatchObject({ code: 'ABOVE_LIMIT' });
    await expect(session(mg, 4.99)).rejects.toMatchObject({ code: 'BELOW_LIMIT' });
    await expect(session(mg, 950)).resolves.toMatchObject({ amountUsd: 950 });
    await expect(session(mg, 5)).resolves.toMatchObject({ amountUsd: 5 });
    expect(MoneyGramOnRamp.check({ amountUsd: 750, buyerState: 'VA' }, LIMITS)).toBeNull();
    expect(MoneyGramOnRamp.check({ amountUsd: 750, buyerState: null }, LIMITS)).toBeNull();
  });

  it('applies status webhooks idempotently per event id and per reference', async () => {
    const { mg } = mock();
    const s = await session(mg);
    expect(await mg.handleWebhook({ referenceNumber: s.referenceNumber, status: 'completed', eventId: 'ev-1' })).toEqual({ applied: true, status: 'completed' });
    expect(await mg.handleWebhook({ referenceNumber: s.referenceNumber, status: 'completed', eventId: 'ev-1' })).toEqual({ applied: false, status: 'completed' });
    expect(await mg.handleWebhook({ referenceNumber: s.referenceNumber, status: 'expired', eventId: 'ev-2' })).toEqual({ applied: false, status: 'completed' });
    expect(await mg.handleWebhook({ referenceNumber: '00000000', status: 'completed' })).toEqual({ applied: false, status: 'error' });
    const e = await session(mg);
    expect(await mg.handleWebhook({ referenceNumber: e.referenceNumber, status: 'error', detail: 'declined' })).toEqual({ applied: true, status: 'error' });
  });

  it('honours the runtime error mode and works as a plain OnRampProvider', async () => {
    const { mg, runtime } = mock();
    runtime.errorMode = true;
    await expect(session(mg)).rejects.toBeInstanceOf(MockProviderError);
    runtime.errorMode = false;
    const d = await mg.initiateDeposit({ buyerId: 'buyer-roxana', usdAmount: 750, memo: 'm' });
    expect(d.status).toBe('pending');
    expect(d.depositId).toMatch(/^\d{8}$/);
    await mg.simulateCompleted(d.depositId);
    expect(await mg.status(d.depositId)).toBe('completed');
    expect(mg.name).toContain('simulado');
  });

  it('adopts a reference issued elsewhere (the seed) so the demo controls apply to it', async () => {
    const { mg } = mock();
    mg.adopt({ referenceNumber: '9062817345', customerIdentifier: 'buyer-roxana', memo: 'M6', amountUsd: 750, feeUsd: 4.99, expiresAt: new Date(T0 + 48 * 60_000).toISOString() });
    expect(await mg.referenceStatus('9062817345')).toBe('pending');
    await mg.simulateCompleted('9062817345');
    expect(await mg.referenceStatus('9062817345')).toBe('completed');
  });
});

describe('MoneyGramOnRamp (sep24-standin driver)', () => {
  class FakeRail implements StandInDepositRail {
    calls: { buyerId: string; usdAmount: number; memo: string }[] = [];
    polls = 0;
    constructor(private readonly outcome: 'completed' | 'pending' | 'error' = 'completed') {}
    async initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }) {
      this.calls.push(args);
      return { depositId: `sep24:${args.buyerId}:tx-${this.calls.length}`, status: this.outcome };
    }
    async status() {
      this.polls += 1;
      return this.polls >= 2 ? ('completed' as const) : ('pending' as const);
    }
  }

  it('issues the reference locally and runs the anchor deposit only when the cash-in is reported', async () => {
    const rail = new FakeRail();
    const mg = new MoneyGramOnRamp({ driver: 'sep24-standin', runtime: new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 }), limits: LIMITS, standIn: rail, now: () => T0 });
    const s = await session(mg);
    expect(rail.calls).toHaveLength(0);
    expect(await mg.referenceStatus(s.referenceNumber)).toBe('pending');
    await mg.simulateCompleted(s.referenceNumber);
    expect(rail.calls).toEqual([{ buyerId: 'buyer-roxana', usdAmount: 750, memo: 'CH-SV-0007B-M6' }]);
    expect(await mg.referenceStatus(s.referenceNumber)).toBe('completed');
    expect(mg.name).toContain('simulado');
  });

  it('keeps polling the anchor while its deposit is pending', async () => {
    const rail = new FakeRail('pending');
    const mg = new MoneyGramOnRamp({ driver: 'sep24-standin', runtime: new MockRuntime({ minDelayMs: 0, maxDelayMs: 0 }), limits: LIMITS, standIn: rail, now: () => T0 });
    const s = await session(mg);
    await mg.simulateCompleted(s.referenceNumber);
    expect(await mg.referenceStatus(s.referenceNumber)).toBe('pending');
    expect(await mg.referenceStatus(s.referenceNumber)).toBe('completed');
  });

  it('refuses to start without a stand-in rail', () => {
    expect(() => new MoneyGramOnRamp({ driver: 'sep24-standin', runtime: new MockRuntime(), limits: LIMITS })).toThrow(/stand-in/);
  });
});
