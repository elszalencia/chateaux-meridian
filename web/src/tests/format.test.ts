// Date and number formats per locale: "20 nov 2026" in Spanish, "Nov 20, 2026" in English, with a
// fixed 3-letter month (no "sept", no "de", no trailing period) in both languages.
import { describe, expect, it } from 'vitest';
import { makeFormatters } from '../app/format';

const es = makeFormatters('es-CO');
const en = makeFormatters('en-US');

describe('date formats', () => {
  it('Spanish: day, 3-letter lowercase month, year', () => {
    expect(es.date('2026-11-20')).toBe('20 nov 2026');
    expect(es.date('2026-09-05')).toBe('5 sep 2026');
    expect(es.monthYear('2026-11-20')).toBe('nov 2026');
    expect(es.monthYear('2027-01-01')).toBe('ene 2027');
    expect(es.dateTime('2026-11-20T14:05:00Z')).toBe('20 nov 2026, 14:05');
  });

  it('English: month, day, year', () => {
    expect(en.date('2026-11-20')).toBe('Nov 20, 2026');
    expect(en.date('2026-09-05')).toBe('Sep 5, 2026');
    expect(en.monthYear('2026-11-20')).toBe('Nov 2026');
    expect(en.dateTime('2026-11-20T14:05:00Z')).toBe('Nov 20, 2026, 2:05 PM');
  });

  it('timestamps keep the UTC calendar day', () => {
    expect(es.date('2026-11-20T23:30:00Z')).toBe('20 nov 2026');
  });
});

describe('number formats', () => {
  it('COP whole pesos, USD two decimals, rate three decimals', () => {
    expect(es.cop(4093125.4)).toBe('COP 4.093.125');
    expect(es.usd(1188.33)).toBe('USD 1.188,33');
    expect(es.rate(3444.427)).toBe('3.444,427');
    expect(en.usd(1188.33)).toBe('USD 1,188.33');
  });
});
