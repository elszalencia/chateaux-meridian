import { describe, expect, it } from 'vitest';
import { parseUsdToCents, quickAmounts } from './money';

describe('counter money helpers', () => {
  it('parses what a cashier types into cents', () => {
    expect(parseUsdToCents('800')).toBe(80000);
    expect(parseUsdToCents('800.5')).toBe(80050);
    expect(parseUsdToCents('800,50')).toBe(80050);
    expect(parseUsdToCents('1,000.00')).toBe(100000);
    expect(parseUsdToCents('')).toBeNull();
    expect(parseUsdToCents('abc')).toBeNull();
    expect(parseUsdToCents('10.999')).toBeNull();
  });

  it('offers the exact amount and the next likely bills, never less than due', () => {
    expect(quickAmounts(75000)).toEqual([75000, 80000, 100000]);
    expect(quickAmounts(75499)).toEqual([75499, 76000, 80000, 100000]);
    expect(quickAmounts(75000).every((c) => c >= 75000)).toBe(true);
  });
});