// The page reads the services' clock from what it last read: `now` plus the time elapsed since.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { pendingMinutesAt, useServiceClock } from './serviceClock';
import { useCountdown } from '../portals/comprador/pay/useCountdown';

const NOW = '2026-10-25T14:00:00.000Z';

beforeEach(() => {
  vi.useFakeTimers();
  // The page's own wall clock is far from the services' clock on purpose.
  vi.setSystemTime(new Date('2030-01-01T09:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('service clock', () => {
  it('starts at the services\' now and advances with the time elapsed in the page', () => {
    const { result } = renderHook(() => useServiceClock(NOW));
    expect(result.current).toBe(Date.parse(NOW));
    act(() => vi.advanceTimersByTime(3_000));
    expect(result.current).toBe(Date.parse(NOW) + 3_000);
  });

  it('is null until something was read', () => {
    expect(renderHook(() => useServiceClock(undefined)).result.current).toBeNull();
  });

  it('pending minutes are the services\' count plus whole minutes since the read', () => {
    const p = { pendingMinutes: 12, now: NOW };
    expect(pendingMinutesAt(p, Date.parse(NOW))).toBe(12);
    expect(pendingMinutesAt(p, Date.parse(NOW) + 59_000)).toBe(12);
    expect(pendingMinutesAt(p, Date.parse(NOW) + 2 * 60_000)).toBe(14);
    expect(pendingMinutesAt({ pendingMinutes: null, now: NOW }, Date.parse(NOW))).toBeNull();
  });

  it('the countdown reads the payment\'s now, not the page clock or the demo date', () => {
    const payment = { status: 'pending' as const, now: NOW, expiresAt: '2026-10-25T14:48:00.000Z' };
    const { result } = renderHook(() => useCountdown(payment));
    expect(result.current).toBe(48 * 60);
    act(() => vi.advanceTimersByTime(5_000));
    expect(result.current).toBe(48 * 60 - 5);
    expect(renderHook(() => useCountdown({ ...payment, expiresAt: null })).result.current).toBeNull();
  });
});
