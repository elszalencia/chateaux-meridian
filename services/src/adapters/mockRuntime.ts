// Shared runtime for every mock adapter: realistic latency (200 to 800 ms by default) and one
// switchable error mode. Tests set the delays to zero; the demo bar flips the error switch to show
// the UI's error states. Market data (spot path and curve by demo-month offset) also lives here so
// all mocks agree on "today's rate".

import type { CurvePoint, ISODate } from '../domain/types';
import { addMonths } from '../domain/dates';

export class MockProviderError extends Error {
  readonly code = 'MOCK_ERROR_MODE';
  constructor(public readonly operation: string) {
    super(`Simulated failure in ${operation} (demo error mode is on)`);
    this.name = 'MockProviderError';
  }
}

export interface MockRuntimeOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
  errorMode?: boolean;
  /** Returns the demo clock's month offset from the base date. */
  clockOffset?: () => number;
}

export class MockRuntime {
  minDelayMs: number;
  maxDelayMs: number;
  errorMode: boolean;
  clockOffset: () => number;

  constructor(opts: MockRuntimeOptions = {}) {
    this.minDelayMs = opts.minDelayMs ?? 200;
    this.maxDelayMs = opts.maxDelayMs ?? 800;
    this.errorMode = opts.errorMode ?? false;
    this.clockOffset = opts.clockOffset ?? (() => 0);
  }

  async delay(scale = 1): Promise<void> {
    const span = Math.max(0, this.maxDelayMs - this.minDelayMs);
    const ms = Math.round((this.minDelayMs + Math.random() * span) * scale);
    if (ms <= 0) return;
    await new Promise((r) => setTimeout(r, ms));
  }

  /** Throws when error mode is on; every mock calls this before doing work. */
  guard(operation: string): void {
    if (this.errorMode) throw new MockProviderError(operation);
  }

  async call(operation: string, scale = 1): Promise<void> {
    this.guard(operation);
    await this.delay(scale);
  }
}

// ---------- Market data ----------

export const CURVE_AS_OF: ISODate = '2026-06-17';
export const CURVE_SOURCE = 'cbonds, mid, 17 jun 2026';
export const BASE_SPOT = 3422.325;
export const BASE_FORWARDS: Record<'1M' | '2M' | '3M', number> = {
  '1M': 3442.145,
  '2M': 3464.645,
  '3M': 3492.795,
};
export const FORWARD_POINTS: Record<'1M' | '2M' | '3M', number> = {
  '1M': BASE_FORWARDS['1M'] - BASE_SPOT,
  '2M': BASE_FORWARDS['2M'] - BASE_SPOT,
  '3M': BASE_FORWARDS['3M'] - BASE_SPOT,
};

/**
 * Scripted spot path by demo-month offset. Offset 0 is the seed curve's spot so the step 1 and
 * step 2 numbers match the published figures; the following months move so the receipt in step 3
 * shows a visible "locked vs today" difference in the buyer's favor.
 */
const SPOT_PATH = [3422.325, 3398.61, 3455.23, 3470.15, 3436.9, 3402.4, 3461.75, 3488.2, 3427.55, 3411.3, 3449.9, 3476.3];

export function spotAtOffset(offsetMonths: number): number {
  const i = ((offsetMonths % SPOT_PATH.length) + SPOT_PATH.length) % SPOT_PATH.length;
  return SPOT_PATH[i]!;
}

export function curveAtOffset(offsetMonths: number, baseDate: ISODate): CurvePoint[] {
  const spot = spotAtOffset(offsetMonths);
  const asOf = offsetMonths === 0 ? CURVE_AS_OF : addMonths(baseDate, offsetMonths);
  const source = offsetMonths === 0 ? CURVE_SOURCE : 'simulado (curva desplazada)';
  const mk = (tenor: CurvePoint['tenor'], rate: number, months: number): CurvePoint => ({
    id: `${asOf}:${tenor}`,
    asOf,
    tenor,
    date: addMonths(asOf, months),
    rate,
    source,
  });
  return [
    mk('spot', spot, 0),
    mk('1M', spot + FORWARD_POINTS['1M'], 1),
    mk('2M', spot + FORWARD_POINTS['2M'], 2),
    mk('3M', spot + FORWARD_POINTS['3M'], 3),
  ];
}

/** Deterministic 64-hex pseudo transaction hash from a label (FNV-1a, repeated). */
export function mockTxHash(label: string): string {
  let h = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 8; round += 1) {
    const s = `${label}:${round}`;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out;
}

export function shortId(prefix: string, label: string): string {
  return `${prefix}-${mockTxHash(label).slice(0, 8)}`;
}
