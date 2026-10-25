// Corridor configuration: the one place that knows how Colombia and El Salvador differ. Every
// corridor difference in the services and the web reads from here (through `corridorOf(plan)` in
// services/src/corridors); components never branch on a country literal. Amount fields keep their
// historical names (`copDue`, `installmentCop`, `priceCop`, the contract's `cop_due`) and hold the
// amount in the corridor's minor unit: whole pesos for Colombia (decimals 0), US cents for
// El Salvador (decimals 2). The holiday calendars themselves live in services/src/domain/holidays.ts.

export type CorridorId = 'co' | 'sv';

export type PayMethod = 'moneygram_cash' | 'office_counter' | 'ach';

/** Seller payout option: A holds USDC at the seller's provider address, B sends USD to a bank. */
export type PayoutOption = 'A' | 'B';

export type PayoutProvider = 'sep31-receiver' | 'usdc-hold' | 'usd-bank-payout';

export type ReceiptField =
  | 'usdPaid'
  | 'lockedRate'
  | 'todayRate'
  | 'usdAtToday'
  | 'copDelivered'
  | 'fee'
  | 'fxDeclarationRef'
  | 'usdDelivered'
  | 'payoutStatus'
  | 'method'
  | 'seller'
  | 'unit';

export type WhatsAppTemplate =
  | 'recordatorio'
  | 'referencia_moneygram'
  | 'pago_recibido'
  | 'pago_entregado'
  | 'pago_atrasado'
  | 'plan_en_pausa'
  | 'renovacion_bloqueo';

/** Steps the buyer sees while a payment runs (the pay dialog's progress list). */
export type PayStepKey = 'recibido' | 'convertido' | 'entregado';

export interface MoneyGramLimits {
  /** Smallest and largest cash-in the reference may carry, in USD (scope report, read 2026-10-25). */
  minUsd: number;
  maxUsd: number;
  /** US states where the cash-in option is not offered. */
  excludedStates: readonly string[];
  /** Minutes a reference stays payable before it expires (`quote_expired`). */
  referenceTtlMinutes: number;
  /** Minutes after which a still-pending cash-in is flagged on the office screens. */
  pendingAlertMinutes: number;
  /** Public page where the buyer finds the nearest agent; the cash panel links to it. */
  locatorUrl: string;
}

export interface Corridor {
  id: CorridorId;
  /** ISO 3166-1 alpha-2 of the destination country (data, not a branch key for components). */
  country: 'CO' | 'SV';
  /** i18n key of the corridor's display name (`corridors.<id>.name`). */
  nameKey: string;
  currency: 'COP' | 'USD';
  /** Minor-unit digits of `currency`: the amount fields store this many decimals as integers. */
  decimals: 0 | 2;
  /** Rate lock (Colombia only). When false the services refuse quoteLock/acceptLock/apply_lock. */
  locksEnabled: boolean;
  /** Treasury hedge legs and NDF settlement follow the lock. */
  hedgeEnabled: boolean;
  /** Business-day calendar used for grace, cutoffs and credit dates. */
  holidays: 'CO' | 'SV';
  /** Business days of grace after a due date (brief §9: 5 in both corridors). */
  graceBusinessDays: number;
  /** Days before the due date from which the buyer may pay (the WhatsApp reminder window). */
  payWindowDays: number;
  /** Pay methods offered to the buyer, in the order the pay sheet lists them. */
  payMethods: readonly PayMethod[];
  /** Flat fee per method, in USD. */
  feesUsd: Readonly<Record<PayMethod, number>>;
  /** Payout rails available to sellers of this corridor. */
  payoutProviders: readonly PayoutProvider[];
  /** i18n key of the payout target label ("Cuenta del vendedor" / "Encargo Fidudavivienda"). */
  payoutTargetKey: string;
  /** Receipt rows, in order. */
  receiptFields: readonly ReceiptField[];
  /** Progress steps of a payment, in order. */
  paySteps: readonly PayStepKey[];
  /** Which office views and buyer features exist in this corridor. */
  views: {
    comprador: true;
    oficina: true;
    constructora: boolean;
    tesoreria: boolean;
    /** Lock flow, renewal banner, rate columns. */
    lock: boolean;
    /** Pay ahead (next open quarter). */
    payAhead: boolean;
    /** "Propiedad verificada · CNR" badge. */
    propertyVerification: boolean;
  };
  whatsappTemplates: readonly WhatsAppTemplate[];
  /** Days before the due date the reminder goes out. */
  reminderDaysBefore: number;
  moneyGram: MoneyGramLimits | null;
  /** Environment variable names of the payment_plan instance and payee for this corridor (server only). */
  chainEnv: { contractIdKey: string; payeeSecretKey: string; payeePublicKey: string };
  /** Name of the seller-side partner shown on office screens; `simulated` adds the marker. */
  partners: { payoutPartner: string; cashNetwork: string | null; simulated: true };
}

export const CORRIDORS: Readonly<Record<CorridorId, Corridor>> = {
  co: {
    id: 'co',
    country: 'CO',
    nameKey: 'corridors.co.name',
    currency: 'COP',
    decimals: 0,
    locksEnabled: true,
    hedgeEnabled: true,
    holidays: 'CO',
    graceBusinessDays: 5,
    payWindowDays: 0,
    payMethods: ['office_counter', 'ach'],
    feesUsd: { moneygram_cash: 0, office_counter: 0, ach: 0 },
    payoutProviders: ['sep31-receiver'],
    payoutTargetKey: 'corridors.co.payoutTarget',
    receiptFields: ['usdPaid', 'lockedRate', 'todayRate', 'usdAtToday', 'copDelivered', 'fee', 'fxDeclarationRef'],
    paySteps: ['recibido', 'convertido', 'entregado'],
    views: { comprador: true, oficina: true, constructora: true, tesoreria: true, lock: true, payAhead: true, propertyVerification: false },
    whatsappTemplates: ['recordatorio', 'pago_recibido', 'pago_entregado', 'pago_atrasado', 'plan_en_pausa', 'renovacion_bloqueo'],
    reminderDaysBefore: 5,
    moneyGram: null,
    chainEnv: { contractIdKey: 'PAYMENT_PLAN_CONTRACT_ID', payeeSecretKey: 'PAYEE_BACKEND_SECRET', payeePublicKey: 'PAYEE_BACKEND_PUBLIC' },
    partners: { payoutPartner: 'Fidudavivienda', cashNetwork: null, simulated: true },
  },
  sv: {
    id: 'sv',
    country: 'SV',
    nameKey: 'corridors.sv.name',
    currency: 'USD',
    decimals: 2,
    locksEnabled: false,
    hedgeEnabled: false,
    holidays: 'SV',
    graceBusinessDays: 5,
    payWindowDays: 5,
    payMethods: ['moneygram_cash', 'office_counter', 'ach'],
    feesUsd: { moneygram_cash: 4.99, office_counter: 0, ach: 1.5 },
    payoutProviders: ['usdc-hold', 'usd-bank-payout'],
    payoutTargetKey: 'corridors.sv.payoutTarget',
    receiptFields: ['usdPaid', 'fee', 'usdDelivered', 'payoutStatus', 'method', 'seller', 'unit'],
    paySteps: ['recibido', 'entregado'],
    views: { comprador: true, oficina: true, constructora: false, tesoreria: false, lock: false, payAhead: false, propertyVerification: true },
    whatsappTemplates: ['recordatorio', 'referencia_moneygram', 'pago_recibido', 'pago_entregado', 'pago_atrasado', 'plan_en_pausa'],
    reminderDaysBefore: 5,
    moneyGram: { minUsd: 5, maxUsd: 950, excludedStates: ['AK', 'HI', 'LA', 'NY'], referenceTtlMinutes: 60, pendingAlertMinutes: 10, locatorUrl: 'https://www.moneygram.com/mgo/us/en/locations' },
    chainEnv: { contractIdKey: 'PAYMENT_PLAN_CONTRACT_ID_SV', payeeSecretKey: 'PAYEE_BACKEND_SV_SECRET', payeePublicKey: 'PAYEE_BACKEND_SV_PUBLIC' },
    partners: { payoutPartner: 'Davivienda Salvadoreño', cashNetwork: 'MoneyGram', simulated: true },
  },
};

export const CORRIDOR_IDS: readonly CorridorId[] = ['co', 'sv'];

export function corridor(id: CorridorId): Corridor {
  return CORRIDORS[id];
}

/** Minor units → major units (COP 4093125 → 4093125; 75000 cents → USD 750.00). */
export function minorToMajor(minor: number, c: Corridor): number {
  return c.decimals === 0 ? minor : minor / 10 ** c.decimals;
}

/** Major units → minor units, rounded to the corridor's precision. */
export function majorToMinor(major: number, c: Corridor): number {
  return Math.round(major * 10 ** c.decimals);
}
