// El Salvador seed: four buyers, four sellers, three offices and the payments, receipts, payouts
// and WhatsApp messages that put every edge case of the corridor brief on screen. Amounts are US
// cents in the amount fields (config/corridors.ts `decimals` 2): an installment of USD 750.00 is
// `copDue: 75000`. Receipts keep `usdPaid` in dollars; `copCredited` is the cents delivered to the
// seller. Fee convention for every method: usdPaid = installment + fee, usdDelivered = installment,
// copCredited = usdDelivered × 100, so paid − fee = to seller holds to the cent on every row.
//
// Dates are relative to the demo clock (BASE_DATE 2026-10-20, seed clock 14:00 UTC that day):
// - Roxana: start 2026-05-24, due on the 24th; M1–M5 released, M6 due 2026-10-24 (the counter demo)
// - Marvin: start 2026-07-15, due on the 15th; M1–M3 released, M4 due 2026-10-15 (late inside grace)
// - Doris:  start 2026-10-28 (M1 not yet due), no payments
// - Óscar:  start 2026-08-27; M1–M2 released, plan on hold since 2026-10-17 (CNR lien alert)
//
// Edge-case index (asserted in svSeed.test.ts):
// - MoneyGram reference quote_expired ............ Roxana M6, pay-plan-roxana-5-expired
// - MoneyGram cash-in pending > 10 min ........... Roxana M6, pay-plan-roxana-5-pending (12 min)
// - MoneyGram attempt above USD 950, blocked ..... Marvin, pay-plan-marvin-3-blocked (USD 1,000)
// - Tier 2 seller with CNR alert, plan on hold ... Altavista / Óscar
// - payout-account change in cooling-off ......... Los Abetos (pending until seed clock + 52 h)
// - installment late inside grace ................ Marvin M4 (3 business days, SV calendar)
// - option B payout in transit / in error ........ Roxana M5 / Roxana M4
// - empty office search .......................... no buyer phone contains 5550000
// - buyer with no payments yet ................... Doris

import type {
  Buyer,
  ISODate,
  ISODateTime,
  Installment,
  Office,
  OutboxMessage,
  PayMethod,
  Payment,
  PayoutStatus,
  Payout,
  Plan,
  PlanGovernance,
  PlanState,
  PolicyEventKind,
  Receipt,
  Seller,
  SellerUnit,
  Unit,
} from '../domain/types';
import { CORRIDORS } from '../../../config/corridors';
import { addBusinessDaysIn, addDays, addMonths } from '../domain/dates';
import { mockTxHash } from '../adapters/mockRuntime';
import { defaultGovernance } from '../policy/transitions';
import { REASONS } from '../policy/reasons';
import { deepLinkFor } from '../channels/MessageChannel';

export const PLAN_ROXANA = 'plan-roxana';
export const PLAN_MARVIN = 'plan-marvin';
export const PLAN_DORIS = 'plan-doris';
export const PLAN_OSCAR = 'plan-oscar';
/** The El Salvador demo plans (mock seed; the chain bridge decides what goes on testnet). */
export const SV_DEMO_PLANS: readonly string[] = [PLAN_ROXANA, PLAN_MARVIN, PLAN_DORIS, PLAN_OSCAR];

export const SELLER_CUSCATLAN = 'seller-cuscatlan';
export const SELLER_LOS_ABETOS = 'seller-los-abetos';
export const SELLER_ALTAVISTA = 'seller-altavista';
export const SELLER_BRISAS = 'seller-brisas';

export const OFFICE_MAXI_WOODBRIDGE = 'office-maxi-woodbridge';
export const OFFICE_CHATEAUX_SILVER_SPRING = 'office-chateaux-silver-spring';
export const OFFICE_CHATEAUX_MIAMI = 'office-chateaux-miami';

const SV = CORRIDORS.sv;
const CALENDAR = SV.holidays;

/** "Now" for the seed's relative timestamps: the demo clock at 14:00 UTC. */
export function svSeedClock(baseDate: ISODate): ISODateTime {
  return `${baseDate}T14:00:00.000Z`;
}

function shiftMinutes(iso: ISODateTime, minutes: number): ISODateTime {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function feeCents(method: PayMethod): number {
  return Math.round(SV.feesUsd[method] * 100);
}

const buyers: Buyer[] = [
  {
    id: 'buyer-roxana',
    name: 'Roxana Beatriz Hernández',
    city: 'Woodbridge',
    state: 'VA',
    phone: '+1 (703) 555-0187',
    email: 'roxana.hernandez@example.com',
    stellarAccount: 'GBROXANAHERNANDEZ7DEMO3TESTNET5ACCOUNT2CHATEAUX4CEDROS07B',
    anchorAuthMode: 'g_account',
    lang: 'es',
    officeId: OFFICE_MAXI_WOODBRIDGE,
  },
  {
    id: 'buyer-marvin',
    name: 'Marvin Alexander Portillo',
    city: 'Silver Spring',
    state: 'MD',
    phone: '+1 (301) 555-0129',
    email: 'marvin.portillo@example.com',
    stellarAccount: 'GBMARVINPORTILLO7DEMO3TESTNET5ACCOUNT2CHATEAUX4ABETOS014X',
    anchorAuthMode: 'g_account',
    lang: 'es',
    officeId: OFFICE_CHATEAUX_SILVER_SPRING,
  },
  {
    id: 'buyer-doris',
    name: 'Doris Elizabeth Martínez',
    city: 'Shreveport',
    state: 'LA',
    phone: '+1 (318) 555-0144',
    email: 'doris.martinez@example.com',
    stellarAccount: 'GBDORISMARTINEZ7DEMO3TESTNET5ACCOUNT2CHATEAUX4CEDROS03AX',
    anchorAuthMode: 'g_account',
    lang: 'es',
    officeId: null,
  },
  {
    id: 'buyer-oscar',
    name: 'Óscar Armando Rivas',
    city: 'Houston',
    state: 'TX',
    phone: '+1 (713) 555-0163',
    email: 'oscar.rivas@example.com',
    stellarAccount: 'GBOSCARRIVAS7DEMO3TESTNET5ACCOUNT2CHATEAUX4ALTAVISTA012X',
    anchorAuthMode: 'g_account',
    lang: 'es',
    officeId: null,
  },
];

const units: Unit[] = [
  {
    id: 'unit-cedros-07b',
    project: 'Torre Cedros (ficticio)',
    unitName: 'Apartamento',
    unitCode: '7B',
    address: 'Colonia Escalón',
    city: 'San Salvador',
    department: 'San Salvador',
    housingType: 'No VIS',
    areaM2: 82,
    bedrooms: 3,
    priceCop: 9_000_000,
    priceBasis: 'fixed',
  },
  {
    id: 'unit-abetos-14',
    project: 'Residencial Los Abetos (ficticio)',
    unitName: 'Casa',
    unitCode: '14',
    address: 'Santa Tecla',
    city: 'Santa Tecla',
    department: 'La Libertad',
    housingType: 'No VIS',
    areaM2: 96,
    bedrooms: 3,
    priceCop: 6_500_000,
    priceBasis: 'fixed',
  },
  {
    id: 'unit-cedros-03a',
    project: 'Torre Cedros (ficticio)',
    unitName: 'Apartamento',
    unitCode: '3A',
    address: 'Colonia Escalón',
    city: 'San Salvador',
    department: 'San Salvador',
    housingType: 'No VIS',
    areaM2: 74,
    bedrooms: 2,
    priceCop: 7_800_000,
    priceBasis: 'fixed',
  },
  {
    id: 'unit-altavista-12',
    project: 'Residencial Altavista (ficticio)',
    unitName: 'Casa',
    unitCode: '12',
    address: 'Carretera Panamericana, km 136',
    city: 'San Miguel',
    department: 'San Miguel',
    housingType: 'No VIS',
    areaM2: 88,
    bedrooms: 3,
    priceCop: 5_400_000,
    priceBasis: 'fixed',
  },
];

const sellers: Seller[] = [
  {
    id: SELLER_CUSCATLAN,
    corridor: 'sv',
    tier: 1,
    legalName: 'Desarrollos Cuscatlán, S.A. de C.V. (ficticio)',
    tradeName: 'Desarrollos Cuscatlán (ficticio)',
    taxId: '0614-120399-101-2',
    legalRepresentative: 'Ana Lucía Menéndez de Portillo',
    bank: 'Davivienda Salvadoreño',
    verificationStatus: 'verified',
    verifiedAt: '2026-09-01T15:00:00.000Z',
    payoutOption: 'B',
    payoutAccount: { kind: 'bank', institution: 'Davivienda Salvadoreño', holder: 'DESARROLLOS CUSCATLAN SA DE CV', ref: 'USD ••• 4471' },
    pendingPayoutAccount: null,
    payoutChangePendingUntil: null,
    kybRef: 'KYB-SV-2026-0012',
    releasesCount: 5,
    notes: 'Confirmación del banco recibida (simulado)',
    simulated: true,
  },
  {
    id: SELLER_LOS_ABETOS,
    corridor: 'sv',
    tier: 2,
    legalName: 'Inversiones Los Abetos, S.A. de C.V. (ficticio)',
    tradeName: 'Inversiones Los Abetos (ficticio)',
    taxId: '0511-230801-102-7',
    legalRepresentative: 'Rafael Antonio Quintanilla',
    bank: 'Banco Agrícola',
    verificationStatus: 'verified',
    verifiedAt: '2026-08-15T16:30:00.000Z',
    payoutOption: 'A',
    payoutAccount: { kind: 'provider_address', institution: 'Proveedor de custodia (simulado)', holder: 'INVERSIONES LOS ABETOS SA DE CV', ref: 'CUST-LA-7F2A' },
    pendingPayoutAccount: { kind: 'provider_address', institution: 'Proveedor de custodia (simulado)', holder: 'INVERSIONES LOS ABETOS SA DE CV', ref: 'CUST-LA-9C41' },
    payoutChangePendingUntil: null, // set from the seed clock in buildSvSeed (+52 h)
    kybRef: 'KYB-SV-2026-0019',
    releasesCount: 3,
    notes: 'Cambio de cuenta de pago solicitado; ventana de espera de 72 h en curso (simulado)',
    simulated: true,
  },
  {
    id: SELLER_ALTAVISTA,
    corridor: 'sv',
    tier: 2,
    legalName: 'Urbanizadora Altavista, S.A. de C.V. (ficticio)',
    tradeName: 'Urbanizadora Altavista (ficticio)',
    taxId: '1217-050797-103-4',
    legalRepresentative: 'José Mauricio Ayala Rivera',
    bank: 'Banco Cuscatlán',
    verificationStatus: 'verified',
    verifiedAt: '2026-07-20T14:00:00.000Z',
    payoutOption: 'B',
    payoutAccount: { kind: 'bank', institution: 'Banco Cuscatlán', holder: 'URBANIZADORA ALTAVISTA SA DE CV', ref: 'USD ••• 2208' },
    pendingPayoutAccount: null,
    payoutChangePendingUntil: null,
    kybRef: 'KYB-SV-2026-0007',
    releasesCount: 2,
    notes: 'Alerta CNR 2026-10-17: nuevo gravamen inscrito sobre la unidad 12 (simulado)',
    simulated: true,
  },
  {
    id: SELLER_BRISAS,
    corridor: 'sv',
    tier: 2,
    legalName: 'Constructora Brisas del Pacífico, S.A. de C.V. (ficticio)',
    tradeName: 'Constructora Brisas del Pacífico (ficticio)',
    taxId: '0210-180902-104-9',
    legalRepresentative: 'Claudia Marisol Guzmán',
    bank: 'Banco Hipotecario',
    verificationStatus: 'pending',
    verifiedAt: null,
    payoutOption: 'B',
    payoutAccount: null,
    pendingPayoutAccount: null,
    payoutChangePendingUntil: null,
    kybRef: 'KYB-SV-2026-0031',
    releasesCount: 0,
    notes: 'KYB en revisión; certificación CNR pendiente (simulado)',
    simulated: true,
  },
];

const sellerUnits: SellerUnit[] = [
  { id: 'su-cedros-07b', sellerId: SELLER_CUSCATLAN, unitId: 'unit-cedros-07b', cnrRegistryNo: 'CNR-SS-2026-118342', cnrCertDate: '2026-08-28', cnrCertHash: mockTxHash('cnr:CNR-SS-2026-118342'), alertStatus: 'none', alertAt: null, alertDetail: null },
  { id: 'su-cedros-03a', sellerId: SELLER_CUSCATLAN, unitId: 'unit-cedros-03a', cnrRegistryNo: 'CNR-SS-2026-118347', cnrCertDate: '2026-10-09', cnrCertHash: mockTxHash('cnr:CNR-SS-2026-118347'), alertStatus: 'none', alertAt: null, alertDetail: null },
  { id: 'su-abetos-14', sellerId: SELLER_LOS_ABETOS, unitId: 'unit-abetos-14', cnrRegistryNo: 'CNR-LL-2026-074115', cnrCertDate: '2026-08-12', cnrCertHash: mockTxHash('cnr:CNR-LL-2026-074115'), alertStatus: 'none', alertAt: null, alertDetail: null },
  {
    id: 'su-altavista-12',
    sellerId: SELLER_ALTAVISTA,
    unitId: 'unit-altavista-12',
    cnrRegistryNo: 'CNR-SM-2026-032871',
    cnrCertDate: '2026-07-17',
    cnrCertHash: mockTxHash('cnr:CNR-SM-2026-032871'),
    alertStatus: 'lien_registered',
    alertAt: '2026-10-17T13:30:00.000Z',
    alertDetail: 'Nuevo gravamen inscrito: hipoteca a favor de un tercero (simulado)',
  },
];

const offices: Office[] = [
  {
    id: OFFICE_MAXI_WOODBRIDGE,
    corridor: 'sv',
    name: 'Maxi Envíos · Agencia Woodbridge (simulado)',
    address: '14010 Smoketown Rd',
    city: 'Woodbridge',
    state: 'VA',
    hours: 'Lun–Sáb 9:00–19:00',
    phone: '+1 (703) 555-0100',
    isLicensedAgency: true,
    simulated: true,
  },
  {
    id: OFFICE_CHATEAUX_SILVER_SPRING,
    corridor: 'sv',
    name: 'Chateaux · Oficina de ventas Silver Spring',
    address: '8120 Fenton St',
    city: 'Silver Spring',
    state: 'MD',
    hours: 'Lun–Vie 9:00–18:00 · Sáb 10:00–14:00',
    phone: '+1 (301) 555-0101',
    isLicensedAgency: false,
    simulated: true,
  },
  {
    id: OFFICE_CHATEAUX_MIAMI,
    corridor: 'co',
    name: 'Chateaux · Oficina Miami',
    address: '1450 Brickell Ave',
    city: 'Miami',
    state: 'FL',
    hours: 'Lun–Vie 9:00–18:00',
    phone: '+1 (305) 555-0102',
    isLicensedAgency: false,
    simulated: true,
  },
];

interface SvPlanInput {
  id: string;
  buyerId: string;
  unitId: string;
  encargoRef: string;
  sellerId: string;
  startDate: ISODate;
  installmentsCount: number;
  installmentCop: number;
  priceCop: number;
}

function makeSvPlan(i: SvPlanInput): Plan {
  const seller = sellers.find((s) => s.id === i.sellerId)!;
  const downPaymentCop = i.installmentsCount * i.installmentCop;
  return {
    id: i.id,
    buyerId: i.buyerId,
    unitId: i.unitId,
    contractId: null,
    encargoRef: i.encargoRef,
    trustCompany: seller.tradeName,
    startDate: i.startDate,
    installmentsCount: i.installmentsCount,
    installmentCop: i.installmentCop,
    downPaymentCop,
    downPaymentPct: Math.round((downPaymentCop / i.priceCop) * 100),
    mortgageCop: i.priceCop - downPaymentCop,
    corridor: 'sv',
    sellerId: i.sellerId,
    payoutOption: seller.payoutOption,
  };
}

/** What the Colombia seed lends the El Salvador builder: its installment maker and its event log. */
export interface SvSeedContext {
  baseDate: ISODate;
  makeInstallments: (plan: Plan) => Installment[];
  recordEvent: (e: {
    id?: string;
    planId: string;
    at: ISODate;
    kind: PolicyEventKind;
    idx: number | null;
    from: PlanState;
    to: PlanState;
    reasonCode: number;
    rule: string;
    executed?: boolean;
    detail?: string;
  }) => void;
}

export interface SvSeed {
  buyers: Buyer[];
  units: Unit[];
  plans: Plan[];
  installments: Installment[];
  receipts: Receipt[];
  payments: Payment[];
  sellers: Seller[];
  seller_units: SellerUnit[];
  offices: Office[];
  payouts: Payout[];
  wa_outbox: OutboxMessage[];
  plan_governance: PlanGovernance[];
}

interface PaidInput {
  plan: Plan;
  row: Installment;
  method: PayMethod;
  /** When the buyer paid; the release runs the same day. */
  paidAt: ISODateTime;
  externalRef: string;
  payout: { status: PayoutStatus; partnerRef: string; sentAt: ISODateTime; errorDetail?: string };
  counter?: { officeId: string; cashierId: string; amountReceived: number };
}

export function buildSvSeed(ctx: SvSeedContext): SvSeed {
  const clock = svSeedClock(ctx.baseDate);
  const sellerRows = sellers.map((s) => (s.id === SELLER_LOS_ABETOS ? { ...s, payoutChangePendingUntil: shiftMinutes(clock, 52 * 60) } : s));

  const plans: Plan[] = [
    makeSvPlan({ id: PLAN_ROXANA, buyerId: 'buyer-roxana', unitId: 'unit-cedros-07b', encargoRef: 'CH-SV-0007B', sellerId: SELLER_CUSCATLAN, startDate: addMonths(addDays(ctx.baseDate, 4), -5), installmentsCount: 24, installmentCop: 75000, priceCop: 9_000_000 }),
    makeSvPlan({ id: PLAN_MARVIN, buyerId: 'buyer-marvin', unitId: 'unit-abetos-14', encargoRef: 'CH-SV-0014', sellerId: SELLER_LOS_ABETOS, startDate: '2026-07-15', installmentsCount: 26, installmentCop: 50000, priceCop: 6_500_000 }),
    makeSvPlan({ id: PLAN_DORIS, buyerId: 'buyer-doris', unitId: 'unit-cedros-03a', encargoRef: 'CH-SV-0003A', sellerId: SELLER_CUSCATLAN, startDate: addDays(ctx.baseDate, 8), installmentsCount: 24, installmentCop: 65000, priceCop: 7_800_000 }),
    makeSvPlan({ id: PLAN_OSCAR, buyerId: 'buyer-oscar', unitId: 'unit-altavista-12', encargoRef: 'CH-SV-0012', sellerId: SELLER_ALTAVISTA, startDate: '2026-08-27', installmentsCount: 24, installmentCop: 45000, priceCop: 5_400_000 }),
  ];

  const installments: Installment[] = [];
  const byPlan = new Map<string, Installment[]>();
  for (const plan of plans) {
    const rows = ctx.makeInstallments(plan);
    byPlan.set(plan.id, rows);
    installments.push(...rows);
  }
  const inst = (planId: string, idx: number): Installment => byPlan.get(planId)![idx]!;

  const receipts: Receipt[] = [];
  const payments: Payment[] = [];
  const payouts: Payout[] = [];
  const outbox: OutboxMessage[] = [];

  /** One released installment: Payment (completed) + Receipt + Payout, all reconciling to the cent. */
  const paid = (p: PaidInput) => {
    const fee = feeCents(p.method);
    const usdDelivered = p.row.copDue / 100;
    const usdPaid = round2(usdDelivered + fee / 100);
    const feeUsd = round2(fee / 100);
    const paymentId = `pay-${p.plan.id}-${p.row.idx}`;
    const receiptId = `rcpt-${p.plan.id}-${p.row.idx}`;
    const payoutId = `payout-${p.plan.id}-${p.row.idx}`;
    const txHash = mockTxHash(`${p.plan.id}:${p.row.idx}:${p.paidAt}`);
    const isCounter = p.method === 'office_counter';
    const isMoneyGram = p.method === 'moneygram_cash';
    payments.push({
      id: paymentId,
      planId: p.plan.id,
      idx: p.row.idx,
      method: p.method,
      amount: p.row.copDue,
      fee,
      status: 'completed',
      externalRef: p.externalRef,
      officeId: p.counter?.officeId ?? null,
      cashierId: p.counter?.cashierId ?? null,
      tender: isCounter ? 'cash' : null,
      amountReceived: p.counter?.amountReceived ?? null,
      changeDue: p.counter ? p.counter.amountReceived - p.row.copDue : null,
      createdAt: isMoneyGram ? shiftMinutes(p.paidAt, -35) : p.paidAt,
      expiresAt: isMoneyGram ? shiftMinutes(p.paidAt, -35 + SV.moneyGram!.referenceTtlMinutes) : null,
      receivedAt: p.paidAt,
      blockedReason: null,
      receiptId,
    });
    receipts.push({
      id: receiptId,
      planId: p.plan.id,
      buyerId: p.plan.buyerId,
      installmentIdx: p.row.idx,
      paidAt: p.paidAt,
      usdPaid,
      rateKind: 'spot',
      lockedRate: null,
      spotAtPayment: 1,
      anchorRate: 1,
      copDelivered: p.row.copDue,
      feeUsd,
      fxDeclarationRef: '',
      txHash,
      lockId: null,
      hedgeTradeId: null,
      anchorCop: p.row.copDue,
      ndfSettlementCop: null,
      basisCop: 0,
      marginCop: 0,
      copCredited: p.row.copDue,
      breakCostCop: 0,
      method: p.method,
      usdDelivered,
      payoutId,
      paymentId,
    });
    const optionB = p.plan.payoutOption === 'B';
    const expectedCreditDate = optionB ? addBusinessDaysIn(p.payout.sentAt.slice(0, 10), 1, CALENDAR) : null;
    const credited = p.payout.status === 'acreditado' || p.payout.status === 'transferido';
    payouts.push({
      id: payoutId,
      planId: p.plan.id,
      idx: p.row.idx,
      sellerId: p.plan.sellerId!,
      option: p.plan.payoutOption!,
      status: p.payout.status,
      usdPaid,
      feeUsd,
      usdToSeller: usdDelivered,
      partnerRef: p.payout.partnerRef,
      releaseTx: txHash,
      sentAt: p.payout.sentAt,
      expectedCreditDate,
      creditedAt: credited ? (optionB ? `${expectedCreditDate}T15:00:00.000Z` : p.payout.sentAt) : null,
      errorDetail: p.payout.errorDetail ?? null,
      holdReason: null,
      receiptId,
    });
    Object.assign(p.row, { status: 'released', usdDue: usdDelivered, releasedTx: txHash, releasedAt: p.paidAt, receiptId } satisfies Partial<Installment>);
  };

  // ---------------- Roxana: M1–M5 released (3 MoneyGram, 2 counter), M6 due in four days ----------------
  const roxana = plans[0]!;
  const roxanaMethods: { method: PayMethod; ref: string; payout: PaidInput['payout'] }[] = [
    { method: 'moneygram_cash', ref: '4821093765', payout: { status: 'acreditado', partnerRef: 'DSV-TRF-2026-0001', sentAt: `${inst(roxana.id, 0).dueDate}T16:00:00.000Z` } },
    { method: 'moneygram_cash', ref: '5190274836', payout: { status: 'acreditado', partnerRef: 'DSV-TRF-2026-0002', sentAt: `${inst(roxana.id, 1).dueDate}T16:00:00.000Z` } },
    { method: 'office_counter', ref: 'MW-2026-000418', payout: { status: 'acreditado', partnerRef: 'DSV-TRF-2026-0003', sentAt: `${inst(roxana.id, 2).dueDate}T16:00:00.000Z` } },
    {
      method: 'moneygram_cash',
      ref: '6603851927',
      payout: { status: 'error', partnerRef: 'DSV-TRF-2026-0004', sentAt: `${inst(roxana.id, 3).dueDate}T16:00:00.000Z`, errorDetail: 'Cuenta destino rechazada por el banco (simulado)' },
    },
    // M5: the partner batch went out on the eve of the demo clock; credit expected the next business day.
    { method: 'office_counter', ref: 'MW-2026-000562', payout: { status: 'en_transito', partnerRef: 'DSV-TRF-2026-0005', sentAt: `${addDays(ctx.baseDate, -1)}T16:00:00.000Z` } },
  ];
  roxanaMethods.forEach((m, idx) => {
    const row = inst(roxana.id, idx);
    paid({
      plan: roxana,
      row,
      method: m.method,
      paidAt: `${row.dueDate}T${m.method === 'office_counter' ? '15:20' : '14:05'}:00.000Z`,
      externalRef: m.ref,
      payout: m.payout,
      counter: m.method === 'office_counter' ? { officeId: OFFICE_MAXI_WOODBRIDGE, cashierId: 'cajero-1', amountReceived: 80000 } : undefined,
    });
  });
  // M6: a reference that expired on the 18th, and a fresh one issued 12 minutes ago, still unpaid.
  const m6 = inst(roxana.id, 5);
  const mgFee = feeCents('moneygram_cash');
  const expiredAt = '2026-10-18T13:05:00.000Z';
  payments.push({
    id: `pay-${roxana.id}-5-expired`,
    planId: roxana.id,
    idx: 5,
    method: 'moneygram_cash',
    amount: m6.copDue,
    fee: mgFee,
    status: 'quote_expired',
    externalRef: '7730451982',
    officeId: null,
    cashierId: null,
    tender: null,
    amountReceived: null,
    changeDue: null,
    createdAt: expiredAt,
    expiresAt: shiftMinutes(expiredAt, SV.moneyGram!.referenceTtlMinutes),
    receivedAt: null,
    blockedReason: null,
    receiptId: null,
  });
  const pendingAt = shiftMinutes(clock, -12);
  const pendingRef = '9062817345';
  payments.push({
    id: `pay-${roxana.id}-5-pending`,
    planId: roxana.id,
    idx: 5,
    method: 'moneygram_cash',
    amount: m6.copDue,
    fee: mgFee,
    status: 'pending',
    externalRef: pendingRef,
    officeId: null,
    cashierId: null,
    tender: null,
    amountReceived: null,
    changeDue: null,
    createdAt: pendingAt,
    expiresAt: shiftMinutes(pendingAt, SV.moneyGram!.referenceTtlMinutes),
    receivedAt: null,
    blockedReason: null,
    receiptId: null,
  });

  // ---------------- Marvin: M1–M3 by ACH (option A, transferred), M4 late inside grace ----------------
  const marvin = plans[1]!;
  ['021000021847203', '021000021903377', '021000021988412'].forEach((trace, idx) => {
    const row = inst(marvin.id, idx);
    paid({
      plan: marvin,
      row,
      method: 'ach',
      paidAt: `${row.dueDate}T13:40:00.000Z`,
      externalRef: trace,
      payout: { status: 'transferido', partnerRef: `CUST-TX-2026-${String(1180 + idx).padStart(4, '0')}`, sentAt: `${row.dueDate}T16:00:00.000Z` },
    });
  });
  const marvinM4 = inst(marvin.id, 3);
  ctx.recordEvent({ id: `pe-${marvin.id}-late-3`, planId: marvin.id, at: ctx.baseDate, kind: 'late_in_grace', idx: 3, from: 'active', to: 'active', reasonCode: REASONS.GRACE_EXPIRED.code, rule: 'R1-late-in-grace', executed: false, detail: `M4 due ${marvinM4.dueDate}` });
  // An attempt to pay M4 and M5 together by MoneyGram (USD 1,000): above the network's cap, blocked.
  payments.push({
    id: `pay-${marvin.id}-3-blocked`,
    planId: marvin.id,
    idx: 3,
    method: 'moneygram_cash',
    amount: 2 * marvinM4.copDue,
    fee: mgFee,
    status: 'blocked',
    externalRef: null,
    officeId: null,
    cashierId: null,
    tender: null,
    amountReceived: null,
    changeDue: null,
    createdAt: '2026-10-19T18:22:00.000Z',
    expiresAt: null,
    receivedAt: null,
    blockedReason: 'above_limit',
    receiptId: null,
  });

  // ---------------- Doris: plan starts in eight days, nothing paid ----------------

  // ---------------- Óscar: M1–M2 by ACH before the CNR alert put the plan on hold ----------------
  const oscar = plans[3]!;
  ['021000022015540', '021000022090861'].forEach((trace, idx) => {
    const row = inst(oscar.id, idx);
    paid({
      plan: oscar,
      row,
      method: 'ach',
      paidAt: `${row.dueDate}T14:10:00.000Z`,
      externalRef: trace,
      payout: { status: 'acreditado', partnerRef: `BCU-TRF-2026-${String(207 + idx).padStart(4, '0')}`, sentAt: `${row.dueDate}T16:00:00.000Z` },
    });
  });
  const holdSince = '2026-10-17';
  ctx.recordEvent({ planId: oscar.id, at: holdSince, kind: 'place_hold', idx: null, from: 'active', to: 'on_hold', reasonCode: REASONS.CNR_LIEN.code, rule: 'operator', detail: 'CNR: nuevo gravamen inscrito sobre la unidad' });

  const governance: PlanGovernance[] = plans.map((p) => defaultGovernance(p.id));
  const oscarGov = governance.find((g) => g.planId === oscar.id)!;
  Object.assign(oscarGov, { state: 'on_hold', holdPrev: 'active', reasonCode: REASONS.CNR_LIEN.code, since: holdSince } satisfies Partial<PlanGovernance>);

  // ---------------- WhatsApp outbox (mock channel): what the system would have sent ----------------
  const e164 = (phone: string) => `+${phone.replace(/\D/g, '')}`;
  const msg = (m: Omit<OutboxMessage, 'channel' | 'simulated' | 'to' | 'buyerId'> & { plan: Plan }): OutboxMessage => {
    const buyer = buyers.find((b) => b.id === m.plan.buyerId)!;
    const { plan: _plan, ...rest } = m;
    return { ...rest, buyerId: buyer.id, to: e164(buyer.phone), channel: 'whatsapp', simulated: true };
  };
  const payLink = (planId: string) => deepLinkFor('recordatorio', planId);
  outbox.push(
    msg({
      id: 'wa-roxana-recordatorio-5',
      plan: roxana,
      planId: roxana.id,
      template: 'recordatorio',
      locale: 'es',
      params: { n: 6, usd: '750.00', date: m6.dueDate, link: payLink(roxana.id) },
      body: 'Hola Roxana, tu cuota 6 de USD 750.00 vence el 24 de octubre. Puedes pagarla en efectivo, en la oficina o desde tu banco desde este enlace: #/c/plan-roxana/pagar (simulado)',
      link: payLink(roxana.id),
      createdAt: `${addDays(m6.dueDate, -SV.reminderDaysBefore)}T14:00:00.000Z`,
    }),
    msg({
      id: 'wa-roxana-referencia-5',
      plan: roxana,
      planId: roxana.id,
      template: 'referencia_moneygram',
      locale: 'es',
      params: { n: 6, usd: '754.99', ref: pendingRef, expiresAt: shiftMinutes(pendingAt, SV.moneyGram!.referenceTtlMinutes), link: payLink(roxana.id) },
      body: 'Tu referencia MoneyGram para la cuota 6 es 9062817345. Paga USD 754.99 en efectivo en cualquier agencia MoneyGram antes de que venza (60 minutos). Encuentra la más cercana y revisa el estado aquí: #/c/plan-roxana/pagar (simulado)',
      link: payLink(roxana.id),
      createdAt: shiftMinutes(pendingAt, 1),
    }),
    msg({
      id: 'wa-roxana-pago-entregado-4',
      plan: roxana,
      planId: roxana.id,
      template: 'pago_entregado',
      locale: 'es',
      params: { n: 5, usd: '750.00', seller: sellerRows[0]!.tradeName, link: deepLinkFor('pago_entregado', roxana.id, 4) },
      body: 'Tu cuota 5 de USD 750.00 fue entregada a Desarrollos Cuscatlán (ficticio) y quedó registrada en tu plan. Tu recibo: #/c/plan-roxana/recibo/4 (simulado)',
      link: deepLinkFor('pago_entregado', roxana.id, 4),
      createdAt: `${inst(roxana.id, 4).dueDate}T16:30:00.000Z`,
    }),
    msg({
      id: 'wa-marvin-pago-atrasado-3',
      plan: marvin,
      planId: marvin.id,
      template: 'pago_atrasado',
      locale: 'es',
      params: { n: 4, usd: '500.00', date: marvinM4.dueDate, graceEnds: addBusinessDaysIn(marvinM4.dueDate, SV.graceBusinessDays, CALENDAR), link: payLink(marvin.id) },
      body: 'Hola Marvin, tu cuota 4 de USD 500.00 venció el 15 de octubre. Tienes hasta el 22 de octubre para pagarla sin novedad en tu plan: #/c/plan-marvin/pagar (simulado)',
      link: payLink(marvin.id),
      createdAt: `${addDays(marvinM4.dueDate, 1)}T14:00:00.000Z`,
    }),
    msg({
      id: 'wa-oscar-plan-en-pausa',
      plan: oscar,
      planId: oscar.id,
      template: 'plan_en_pausa',
      locale: 'es',
      params: { since: holdSince, reason: REASONS.CNR_LIEN.key, link: deepLinkFor('plan_en_pausa', oscar.id) },
      body: 'Hola Óscar, tu plan quedó en pausa el 17 de octubre mientras revisamos una novedad registral sobre la propiedad. No se tomarán pagos hasta resolverla; te avisaremos por aquí. Detalles: #/comprador/plan-oscar (simulado)',
      link: deepLinkFor('plan_en_pausa', oscar.id),
      createdAt: `${holdSince}T15:00:00.000Z`,
    }),
  );

  return { buyers, units, plans, installments, receipts, payments, sellers: sellerRows, seller_units: sellerUnits, offices, payouts, wa_outbox: outbox, plan_governance: governance };
}
