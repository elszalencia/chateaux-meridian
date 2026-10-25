// Holiday calendars and the calendar-aware business-day helpers. The El Salvador list is checked
// date by date (fixed asuetos, Semana Santa per year) and the Colombian calendar is asserted
// untouched, since the frozen Colombia demo depends on it.

import { describe, expect, it } from 'vitest';
import { COLOMBIA_HOLIDAYS, EL_SALVADOR_HOLIDAYS, holidayYearsCovered, holidayYearsCoveredFor, isColombianHoliday, isHoliday } from './holidays';
import { addBusinessDays, addBusinessDaysIn, businessDaysBetween, businessDaysBetweenIn, isBusinessDay, isBusinessDayIn } from './dates';

describe('El Salvador holiday calendar', () => {
  it('covers 2026, 2027 and 2028 with eleven national asuetos each', () => {
    expect(holidayYearsCoveredFor('SV')).toEqual([2026, 2027, 2028]);
    for (const year of [2026, 2027, 2028]) {
      const list = EL_SALVADOR_HOLIDAYS[year]!;
      expect(list).toHaveLength(11);
      expect([...list].sort()).toEqual(list); // chronological
      expect(new Set(list).size).toBe(11);
      for (const d of list) expect(d.startsWith(`${year}-`)).toBe(true);
    }
  });

  it('lists the fixed asuetos of Código de Trabajo art. 190 and the two decree holidays every year', () => {
    for (const year of [2026, 2027, 2028]) {
      for (const md of ['01-01', '05-01', '05-10', '06-17', '08-06', '09-15', '11-02', '12-25']) {
        expect(isHoliday(`${year}-${md}`, 'SV'), `${year}-${md}`).toBe(true);
      }
    }
  });

  it('places Semana Santa on the Thursday, Friday and Saturday before Easter Sunday', () => {
    expect(['2026-04-02', '2026-04-03', '2026-04-04'].every((d) => isHoliday(d, 'SV'))).toBe(true); // Easter 2026-04-05
    expect(['2027-03-25', '2027-03-26', '2027-03-27'].every((d) => isHoliday(d, 'SV'))).toBe(true); // Easter 2027-03-28
    expect(['2028-04-13', '2028-04-14', '2028-04-15'].every((d) => isHoliday(d, 'SV'))).toBe(true); // Easter 2028-04-16
    expect(isHoliday('2026-04-05', 'SV')).toBe(false); // Easter Sunday itself is not an asueto
    expect(isHoliday('2026-04-01', 'SV')).toBe(false);
  });

  it('does not move holidays to a Monday and excludes the San Salvador city days', () => {
    expect(isHoliday('2026-05-11', 'SV')).toBe(false); // 10 May 2026 is a Sunday; nothing moves
    expect(isHoliday('2026-08-03', 'SV')).toBe(false);
    expect(isHoliday('2026-08-05', 'SV')).toBe(false);
  });

  it('is not the Colombian calendar', () => {
    expect(isHoliday('2026-08-06', 'CO')).toBe(false);
    expect(isHoliday('2026-08-07', 'SV')).toBe(false); // Boyacá is Colombian only
    expect(isHoliday('2026-07-20', 'SV')).toBe(false);
    expect(isHoliday('2026-09-15', 'CO')).toBe(false);
  });
});

describe('business days on the El Salvador calendar', () => {
  it('skips weekends and asuetos', () => {
    expect(isBusinessDayIn('2026-09-15', 'SV')).toBe(false); // Tuesday, Independencia
    expect(isBusinessDayIn('2026-09-16', 'SV')).toBe(true);
    expect(isBusinessDayIn('2026-09-19', 'SV')).toBe(false); // Saturday
    // Mon 14 Sep → Wed 16 Sep is one business day: the 15th is a holiday.
    expect(businessDaysBetweenIn('2026-09-14', '2026-09-16', 'SV')).toBe(1);
    expect(businessDaysBetween('2026-09-14', '2026-09-16')).toBe(2); // Colombia has no holiday there
    // Five business days of grace from Fri 11 Sep land on Mon 21 Sep (15 Sep skipped).
    expect(addBusinessDaysIn('2026-09-11', 5, 'SV')).toBe('2026-09-21');
    expect(addBusinessDays('2026-09-11', 5)).toBe('2026-09-18');
    // Across Semana Santa 2027: Wed 24 Mar + 1 business day is Mon 29 Mar.
    expect(addBusinessDaysIn('2027-03-24', 1, 'SV')).toBe('2027-03-29');
    expect(addBusinessDaysIn('2027-03-29', -1, 'SV')).toBe('2027-03-24');
  });

  it('matches the seed: Marvin M4 due 2026-10-15 is three business days late on 2026-10-20', () => {
    expect(businessDaysBetweenIn('2026-10-15', '2026-10-20', 'SV')).toBe(3);
    expect(addBusinessDaysIn('2026-10-15', 5, 'SV')).toBe('2026-10-22'); // grace ends
  });
});

describe('Colombian calendar is unchanged', () => {
  it('keeps its exports and its 2026 and 2027 lists', () => {
    expect(holidayYearsCovered()).toEqual([2026, 2027]);
    expect(COLOMBIA_HOLIDAYS[2026]).toHaveLength(19);
    expect(COLOMBIA_HOLIDAYS[2027]).toHaveLength(19);
    expect(isColombianHoliday('2026-10-12')).toBe(true);
    expect(isHoliday('2026-10-12', 'CO')).toBe(true);
    expect(isHoliday('2026-10-12', 'SV')).toBe(false);
    expect(isBusinessDay('2026-10-12')).toBe(false);
    expect(isBusinessDayIn('2026-10-12', 'CO')).toBe(false);
    expect(isBusinessDayIn('2026-10-12', 'SV')).toBe(true);
    // Andrés M5 (due 2026-10-15) stays three business days late on the Colombian calendar.
    expect(businessDaysBetween('2026-10-15', '2026-10-20')).toBe(3);
    expect(addBusinessDays('2026-10-15', 5)).toBe('2026-10-22');
  });
});
