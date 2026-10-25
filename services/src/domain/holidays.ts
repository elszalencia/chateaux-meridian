// Public holidays as data, one calendar per corridor (config/corridors.ts `holidays`), one list per
// calendar year, ISO `YYYY-MM-DD`. Colombian festivos first; El Salvador asuetos below.
//
// Colombia: the business-day helpers in dates.ts skip these together with weekends, so acceptance
// cutoffs, grace windows and "business days late" follow the Colombian banking calendar.
//
// How the list is built (Ley 51 de 1983, "Ley Emiliani", plus later additions):
// - Fixed dates that never move: 1 Jan, 1 May, 20 Jul, 7 Aug, 8 Dec, 25 Dec.
// - Dates moved to the following Monday when they do not fall on one: 6 Jan, 19 Mar, 29 Jun,
//   15 Aug, 12 Oct, 1 Nov, 11 Nov.
// - Easter-relative: Maundy Thursday and Good Friday stay put; Ascension (+39 days from Easter
//   Sunday), Corpus Christi (+60) and Sacred Heart (+68) move to the following Monday.
// - Virgen de Chiquinquirá, 9 Jul, national holiday since Ley 2578 of 2026-06-01, moved to the
//   following Monday like the Emiliani dates (first observed on 2026-07-13).
// Each year was checked against the official calendar before being added. Years not listed here
// are treated as having no holidays; add the year rather than extrapolating.

import type { ISODate } from './types';

/** Holiday calendar key, as config/corridors.ts names it. */
export type HolidayCalendar = 'CO' | 'SV';

export const COLOMBIA_HOLIDAYS: Record<number, ISODate[]> = {
  2026: [
    '2026-01-01', // Año Nuevo
    '2026-01-12', // Reyes Magos (6 Jan → Monday)
    '2026-03-23', // San José (19 Mar → Monday)
    '2026-04-02', // Jueves Santo
    '2026-04-03', // Viernes Santo
    '2026-05-01', // Día del Trabajo
    '2026-05-18', // Ascensión (→ Monday)
    '2026-06-08', // Corpus Christi (→ Monday)
    '2026-06-15', // Sagrado Corazón (→ Monday)
    '2026-06-29', // San Pedro y San Pablo (Monday)
    '2026-07-13', // Virgen de Chiquinquirá (9 Jul → Monday)
    '2026-07-20', // Independencia
    '2026-08-07', // Batalla de Boyacá
    '2026-08-17', // Asunción (15 Aug → Monday)
    '2026-10-12', // Día de la Raza (Monday)
    '2026-11-02', // Todos los Santos (1 Nov → Monday)
    '2026-11-16', // Independencia de Cartagena (11 Nov → Monday)
    '2026-12-08', // Inmaculada Concepción
    '2026-12-25', // Navidad
  ],
  2027: [
    '2027-01-01', // Año Nuevo
    '2027-01-11', // Reyes Magos (6 Jan → Monday)
    '2027-03-22', // San José (19 Mar → Monday)
    '2027-03-25', // Jueves Santo
    '2027-03-26', // Viernes Santo
    '2027-05-01', // Día del Trabajo
    '2027-05-10', // Ascensión (→ Monday)
    '2027-05-31', // Corpus Christi (→ Monday)
    '2027-06-07', // Sagrado Corazón (→ Monday)
    '2027-07-05', // San Pedro y San Pablo (29 Jun → Monday)
    '2027-07-12', // Virgen de Chiquinquirá (9 Jul → Monday)
    '2027-07-20', // Independencia
    '2027-08-07', // Batalla de Boyacá
    '2027-08-16', // Asunción (15 Aug → Monday)
    '2027-10-18', // Día de la Raza (12 Oct → Monday)
    '2027-11-01', // Todos los Santos (Monday)
    '2027-11-15', // Independencia de Cartagena (11 Nov → Monday)
    '2027-12-08', // Inmaculada Concepción
    '2027-12-25', // Navidad
  ],
};

const HOLIDAY_SET: ReadonlySet<string> = new Set(Object.values(COLOMBIA_HOLIDAYS).flat());

export function isColombianHoliday(iso: ISODate): boolean {
  return HOLIDAY_SET.has(iso);
}

/** Years for which the holiday calendar is loaded; business-day math outside them ignores holidays. */
export function holidayYearsCovered(): number[] {
  return Object.keys(COLOMBIA_HOLIDAYS).map(Number).sort((a, b) => a - b);
}

// El Salvador: días de asueto remunerado, Código de Trabajo art. 190 (Decreto Legislativo 15 of
// 1972, consolidated text) plus the two national asuetos set by separate decrees: Día de la Madre,
// 10 May (asueto for the public and private sector since 2016) and Día del Padre, 17 Jun
// (Decreto Legislativo 208 of 2012). Nothing moves to a Monday; a holiday on a weekend is simply
// absorbed by the weekend. Semana Santa is Thursday, Friday and Saturday before Easter Sunday
// (Easter: 2026-04-05, 2027-03-28, 2028-04-16, Gregorian computus). The 3 and 5 of August are
// asuetos only inside the city of San Salvador (art. 190, second paragraph) and are not national
// bank holidays, so they are not listed. Sources and the date they were read: docs/CORRIDORS.md.
export const EL_SALVADOR_HOLIDAYS: Record<number, ISODate[]> = {
  2026: [
    '2026-01-01', // Año Nuevo
    '2026-04-02', // Jueves Santo
    '2026-04-03', // Viernes Santo
    '2026-04-04', // Sábado Santo
    '2026-05-01', // Día del Trabajo
    '2026-05-10', // Día de la Madre (Sunday)
    '2026-06-17', // Día del Padre
    '2026-08-06', // Fiestas Agostinas: Divino Salvador del Mundo
    '2026-09-15', // Independencia
    '2026-11-02', // Fieles Difuntos
    '2026-12-25', // Navidad
  ],
  2027: [
    '2027-01-01', // Año Nuevo
    '2027-03-25', // Jueves Santo
    '2027-03-26', // Viernes Santo
    '2027-03-27', // Sábado Santo
    '2027-05-01', // Día del Trabajo (Saturday)
    '2027-05-10', // Día de la Madre
    '2027-06-17', // Día del Padre
    '2027-08-06', // Divino Salvador del Mundo
    '2027-09-15', // Independencia
    '2027-11-02', // Fieles Difuntos
    '2027-12-25', // Navidad (Saturday)
  ],
  2028: [
    '2028-01-01', // Año Nuevo (Saturday)
    '2028-04-13', // Jueves Santo
    '2028-04-14', // Viernes Santo
    '2028-04-15', // Sábado Santo
    '2028-05-01', // Día del Trabajo
    '2028-05-10', // Día de la Madre
    '2028-06-17', // Día del Padre (Saturday)
    '2028-08-06', // Divino Salvador del Mundo (Sunday)
    '2028-09-15', // Independencia
    '2028-11-02', // Fieles Difuntos
    '2028-12-25', // Navidad
  ],
};

const CALENDARS: Readonly<Record<HolidayCalendar, Record<number, ISODate[]>>> = { CO: COLOMBIA_HOLIDAYS, SV: EL_SALVADOR_HOLIDAYS };

const HOLIDAY_SETS: Readonly<Record<HolidayCalendar, ReadonlySet<string>>> = {
  CO: HOLIDAY_SET,
  SV: new Set(Object.values(EL_SALVADOR_HOLIDAYS).flat()),
};

/** Whether `iso` is a public holiday in the given calendar. */
export function isHoliday(iso: ISODate, calendar: HolidayCalendar): boolean {
  return HOLIDAY_SETS[calendar].has(iso);
}

/** Years loaded for a calendar; business-day math outside them ignores holidays. */
export function holidayYearsCoveredFor(calendar: HolidayCalendar): number[] {
  return Object.keys(CALENDARS[calendar]).map(Number).sort((a, b) => a - b);
}
