// Deterministic seed. Every number is derived through the lock engine from the published inputs
// (curve of 17 Jun 2026, pass-through 50 %), so the fixtures can never disagree with the math.
// Base date is 2026-10-20 with due dates on the 20th: M3 was paid today, M4 falls due exactly one
// demo-month later, which is what the demo clock's "+1 mes" needs.
//
// Edge cases required by the brief and where they live:
// - late installment inside grace ........ Andrés M5 (due 2026-10-15, 3 business days late)
// - Roto lock with a break cost .......... Andrés Q1 (M3 missed beyond grace, COP break cost)
// - reconciliation row with basis ........ María M2 (anchor converted below the TRM fixing)
// - expired quote ........................ María, monthly quote for M4 from 2026-10-01
// - buyer with no locks .................. Camila (Trifonte, pays at spot)
//
// Adverse-event buyers (mock seed only; the testnet reset seeds the three plans above):
// - delinquent, one waived installment .... Luis (Oliva OLV-0156): M3 waived, M4 missed past grace
// - on hold ............................... Paola (Oliva OLV-0171): identity review since 2026-10-14
// - defaulted ............................. Jorge (Trifonte TRF-0302): M2–M4 missed, default declared
// - cancelled with a held balance ......... Natalia (Trifonte TRF-0319): withdrawal, refund pending
//
// El Salvador corridor (USD, cents in the amount fields, no locks): svFixtures.ts builds Roxana,
// Marvin, Doris and Óscar with their sellers, offices, payments, payouts and WhatsApp outbox, and
// carries the edge-case index of that corridor. Its dates are relative to BASE_DATE too.

import type {
  Buyer,
  CurvePoint,
  DemoState,
  HedgeLeg,
  HedgeTrade,
  Installment,
  Lock,
  Plan,
  PlanGovernance,
  PlanState,
  PolicyEvent,
  PolicyEventKind,
  Receipt,
  RenewalOffer,
  Snapshot,
  Unit,
} from '../domain/types';
import { addMonths } from '../domain/dates';
import { breakCost, graceEndDate, ndfSettlement, priceLock, roundCop, usdToCoverCop } from '../lock/engine';
import { BASE_FORWARDS, BASE_SPOT, CURVE_AS_OF, CURVE_SOURCE, curveAtOffset, mockTxHash } from '../adapters/mockRuntime';
import { HEDGE_PROVIDER_LABEL } from '../adapters/mockHedge';
import { defaultGovernance } from '../policy/transitions';
import { evidenceHash } from '../policy/evidence';
import { REASONS } from '../policy/reasons';
import { buildSvSeed, PLAN_DORIS, PLAN_MARVIN, PLAN_OSCAR, PLAN_ROXANA } from './svFixtures';

export {
  PLAN_ROXANA,
  PLAN_MARVIN,
  PLAN_DORIS,
  PLAN_OSCAR,
  SV_DEMO_PLANS,
  SELLER_CUSCATLAN,
  SELLER_LOS_ABETOS,
  SELLER_ALTAVISTA,
  SELLER_BRISAS,
  OFFICE_MAXI_WOODBRIDGE,
  OFFICE_CHATEAUX_SILVER_SPRING,
  OFFICE_CHATEAUX_MIAMI,
  svSeedClock,
} from './svFixtures';

export const BASE_DATE = '2026-10-20';
export const SEED_VERSION = '2026-10-25.1';
export const DEFAULT_PASS_THROUGH = 0.5;
export const TRUST_COMPANY = 'Fidudavivienda';

export const PLAN_MARIA = 'plan-maria';
export const PLAN_ANDRES = 'plan-andres';
export const PLAN_CAMILA = 'plan-camila';
export const PLAN_LUIS = 'plan-luis';
export const PLAN_PAOLA = 'plan-paola';
export const PLAN_JORGE = 'plan-jorge';
export const PLAN_NATALIA = 'plan-natalia';
// El Salvador plan ids live in svFixtures.ts and are re-exported above.
/** The buyer the Comprador view opens when the route names none, per presenter corridor. */
export const DEFAULT_PLAN_BY_CORRIDOR: Readonly<Record<'co' | 'sv', string>> = { co: PLAN_MARIA, sv: PLAN_ROXANA };
/** Plans that exist only to demo adverse states; the testnet reset does not seed them on chain. */
export const ADVERSE_DEMO_PLANS: readonly string[] = [PLAN_LUIS, PLAN_PAOLA, PLAN_JORGE, PLAN_NATALIA];

const buyers: Buyer[] = [
  {
    id: 'buyer-maria',
    name: 'María Fernanda Rojas',
    city: 'Miami',
    state: 'FL',
    phone: '+1 (305) 555-0142',
    email: 'maria.rojas@example.com',
    stellarAccount: 'GBMARIAROJAS7DEMO3TESTNET5ACCOUNT2CHATEAUX4OLIVA0142X',
    anchorAuthMode: 'g_account',
  },
  {
    id: 'buyer-andres',
    name: 'Andrés Felipe Gómez',
    city: 'Orlando',
    state: 'FL',
    phone: '+1 (407) 555-0188',
    email: 'andres.gomez@example.com',
    stellarAccount: 'GBANDRESGOMEZ5DEMO3TESTNET5ACCOUNT2CHATEAUX4TRIF0215XX',
    anchorAuthMode: 'g_account',
  },
  {
    id: 'buyer-camila',
    name: 'Camila Andrea Torres',
    city: 'Houston',
    state: 'TX',
    phone: '+1 (713) 555-0126',
    email: 'camila.torres@example.com',
    stellarAccount: 'GBCAMILATORRES7DEMO3TESTNET5ACCOUNT2CHATEAUX4TRIF0287X',
    anchorAuthMode: 'g_account',
  },
  {
    id: 'buyer-luis',
    name: 'Luis Eduardo Martínez',
    city: 'Newark',
    state: 'NJ',
    phone: '+1 (973) 555-0156',
    email: 'luis.martinez@example.com',
    stellarAccount: 'GBLUISMARTINEZ7DEMO3TESTNET5ACCOUNT2CHATEAUX4OLIVA0156',
    anchorAuthMode: 'g_account',
  },
  {
    id: 'buyer-paola',
    name: 'Paola Andrea Restrepo',
    city: 'Atlanta',
    state: 'GA',
    phone: '+1 (404) 555-0171',
    email: 'paola.restrepo@example.com',
    stellarAccount: 'GBPAOLARESTREPO7DEMO3TESTNET5ACCOUNT2CHATEAUX4OLIVA0171',
    anchorAuthMode: 'g_account',
  },
  {
    id: 'buyer-jorge',
    name: 'Jorge Iván Castaño',
    city: 'Queens',
    state: 'NY',
    phone: '+1 (718) 555-0302',
    email: 'jorge.castano@example.com',
    stellarAccount: 'GBJORGECASTANO7DEMO3TESTNET5ACCOUNT2CHATEAUX4TRIF0302X',
    anchorAuthMode: 'g_account',
  },
  {
    id: 'buyer-natalia',
    name: 'Natalia Ospina Vélez',
    city: 'Chicago',
    state: 'IL',
    phone: '+1 (312) 555-0319',
    email: 'natalia.ospina@example.com',
    stellarAccount: 'GBNATALIAOSPINA7DEMO3TESTNET5ACCOUNT2CHATEAUX4TRIF0319X',
    anchorAuthMode: 'g_account',
  },
];

const units: Unit[] = [
  {
    id: 'unit-oliva-0142',
    project: 'Parque Natura',
    unitName: 'Oliva',
    unitCode: 'OLV-0142',
    address: 'Alfaguara',
    city: 'Cali',
    department: 'Valle del Cauca',
    housingType: 'VIS',
    areaM2: 61,
    bedrooms: 2,
    priceCop: 327_450_000,
    priceBasis: 'SMMLV',
  },
  {
    id: 'unit-trifonte-0215',
    project: 'Ciudad Tres Quebradas',
    unitName: 'Trifonte',
    unitCode: 'TRF-0215',
    address: 'Usme',
    city: 'Bogotá',
    department: 'Bogotá D.C.',
    housingType: 'VIP/VIS',
    areaM2: 47,
    bedrooms: 2,
    priceCop: 205_000_000,
    priceBasis: 'SMMLV',
  },
  {
    id: 'unit-trifonte-0287',
    project: 'Ciudad Tres Quebradas',
    unitName: 'Trifonte',
    unitCode: 'TRF-0287',
    address: 'Usme',
    city: 'Bogotá',
    department: 'Bogotá D.C.',
    housingType: 'VIP/VIS',
    areaM2: 47,
    bedrooms: 2,
    priceCop: 205_000_000,
    priceBasis: 'SMMLV',
  },
  ...(['0156', '0171'] as const).map(
    (code): Unit => ({
      id: `unit-oliva-${code}`,
      project: 'Parque Natura',
      unitName: 'Oliva',
      unitCode: `OLV-${code}`,
      address: 'Alfaguara',
      city: 'Cali',
      department: 'Valle del Cauca',
      housingType: 'VIS',
      areaM2: 61,
      bedrooms: 2,
      priceCop: 327_450_000,
      priceBasis: 'SMMLV',
    }),
  ),
  ...(['0302', '0319'] as const).map(
    (code): Unit => ({
      id: `unit-trifonte-${code}`,
      project: 'Ciudad Tres Quebradas',
      unitName: 'Trifonte',
      unitCode: `TRF-${code}`,
      address: 'Usme',
      city: 'Bogotá',
      department: 'Bogotá D.C.',
      housingType: 'VIP/VIS',
      areaM2: 47,
      bedrooms: 2,
      priceCop: 205_000_000,
      priceBasis: 'SMMLV',
    }),
  ),
];

function makePlan(id: string, buyerId: string, unitId: string, encargoRef: string, startDate: string, priceCop: number): Plan {
  const downPaymentCop = Math.round(priceCop * 0.3);
  return {
    id,
    buyerId,
    unitId,
    contractId: null,
    encargoRef,
    trustCompany: TRUST_COMPANY,
    startDate,
    installmentsCount: 24,
    installmentCop: downPaymentCop / 24,
    downPaymentCop,
    downPaymentPct: 30,
    mortgageCop: priceCop - downPaymentCop,
  };
}

const plans: Plan[] = [
  makePlan(PLAN_MARIA, 'buyer-maria', 'unit-oliva-0142', 'FD-OLV-0142', '2026-08-20', 327_450_000),
  makePlan(PLAN_ANDRES, 'buyer-andres', 'unit-trifonte-0215', 'FD-TRF-0215', '2026-06-15', 205_000_000),
  makePlan(PLAN_CAMILA, 'buyer-camila', 'unit-trifonte-0287', 'FD-TRF-0287', '2026-09-10', 205_000_000),
  makePlan(PLAN_LUIS, 'buyer-luis', 'unit-oliva-0156', 'FD-OLV-0156', '2026-06-20', 327_450_000),
  makePlan(PLAN_PAOLA, 'buyer-paola', 'unit-oliva-0171', 'FD-OLV-0171', '2026-07-20', 327_450_000),
  makePlan(PLAN_JORGE, 'buyer-jorge', 'unit-trifonte-0302', 'FD-TRF-0302', '2026-04-15', 205_000_000),
  makePlan(PLAN_NATALIA, 'buyer-natalia', 'unit-trifonte-0319', 'FD-TRF-0319', '2026-05-10', 205_000_000),
];

function makeInstallments(plan: Plan): Installment[] {
  return Array.from({ length: plan.installmentsCount }, (_, idx) => ({
    id: `${plan.id}:${idx}`,
    planId: plan.id,
    idx,
    dueDate: addMonths(plan.startDate, idx),
    copDue: plan.installmentCop,
    status: 'open',
    lockId: null,
    lockedRate: null,
    usdDue: null,
    lockExpiry: null,
    releasedTx: null,
    releasedAt: null,
    receiptId: null,
    breakCostCop: null,
  }));
}

interface SeedLockInput {
  id: string;
  plan: Plan;
  tenor: Lock['tenor'];
  idxs: number[];
  spot: number;
  fwdRates: number[];
  createdAt: string;
  acceptedAt: string | null;
  state: Lock['state'];
  curveAsOf: string;
  quoteExpiresAt?: string | null;
}

function makeLock(i: SeedLockInput): { lock: Lock; usdExact: number[] } {
  const copDues = i.idxs.map(() => i.plan.installmentCop);
  const p = priceLock(copDues, { spot: i.spot, fwdRates: i.fwdRates, passThrough: DEFAULT_PASS_THROUGH });
  return {
    lock: {
      id: i.id,
      planId: i.plan.id,
      tenor: i.tenor,
      idxs: i.idxs,
      spot: i.spot,
      fwdRates: i.fwdRates,
      avgFwd: p.avgFwd,
      points: p.points,
      passThrough: DEFAULT_PASS_THROUGH,
      lockedRate: p.lockedRate,
      usdPerInstallment: p.legs.map((l) => l.usdDueRounded),
      quoteExpiresAt: i.quoteExpiresAt ?? null,
      createdAt: i.createdAt,
      acceptedAt: i.acceptedAt,
      state: i.state,
      brokenIdx: null,
      breakCostCop: null,
      curveAsOf: i.curveAsOf,
    },
    usdExact: p.legs.map((l) => l.usdDue),
  };
}

interface ReceiptInput {
  plan: Plan;
  installment: Installment;
  paidAt: string;
  usdPaid: number;
  rateKind: 'locked' | 'spot';
  lockedRate: number | null;
  fixing: number; // TRM / spot at payment
  anchorRate: number;
  lockId: string | null;
  hedgeTradeId: string | null;
  ndfSettlementCop: number | null;
  fwdRate: number | null;
  breakCostCop?: number;
}

/**
 * Reconciliation identity (per locked installment):
 *   anchorCop + ndfSettlement − basis − margin − credited = rounding (≤ a few pesos from cents).
 * basis  = anchorCop − usd × fixing  (anchor converted at its own rate vs the NDF's TRM fixing)
 * margin = usd × (fwd − locked)      (Bolívar keeps the forward points not passed through)
 * A spot (unlocked) payment is quoted by its COP target, so the anchor delivers exactly cop_due
 * plus any break cost: anchorCop = copCredited = that target, basis 0, no rounding residue. The
 * buyer's USD is the whole-cent amount covering the target (`usdToCoverCop`).
 */
export function makeReceipt(r: ReceiptInput): Receipt {
  const spotTarget = r.installment.copDue + (r.breakCostCop ?? 0);
  const anchorCop = r.rateKind === 'locked' ? roundCop(r.usdPaid * r.anchorRate) : spotTarget;
  const basisCop = r.rateKind === 'locked' ? anchorCop - roundCop(r.usdPaid * r.fixing) : 0;
  const marginCop = r.rateKind === 'locked' && r.fwdRate && r.lockedRate ? roundCop(r.usdPaid * (r.fwdRate - r.lockedRate)) : 0;
  const copCredited = r.rateKind === 'locked' ? r.installment.copDue : spotTarget;
  const number = r.installment.idx + 1;
  return {
    id: `rcpt-${r.plan.id}-${r.installment.idx}`,
    planId: r.plan.id,
    buyerId: r.plan.buyerId,
    installmentIdx: r.installment.idx,
    paidAt: r.paidAt,
    usdPaid: r.usdPaid,
    rateKind: r.rateKind,
    lockedRate: r.lockedRate,
    spotAtPayment: r.fixing,
    anchorRate: r.anchorRate,
    copDelivered: copCredited,
    feeUsd: 0,
    fxDeclarationRef: `DCIN-${r.paidAt.slice(0, 4)}-${r.plan.encargoRef}-M${number}`,
    txHash: mockTxHash(`${r.plan.id}:${r.installment.idx}:${r.paidAt}`),
    lockId: r.lockId,
    hedgeTradeId: r.hedgeTradeId,
    anchorCop,
    ndfSettlementCop: r.ndfSettlementCop,
    basisCop,
    marginCop,
    copCredited,
    breakCostCop: r.breakCostCop ?? 0,
  };
}

function makeTrade(tradeId: string, dueDate: string, usdNotional: number, rate: number, bookedAt: string, seq: number, settled?: { fixing: number }): HedgeTrade {
  return {
    id: tradeId,
    provider: HEDGE_PROVIDER_LABEL,
    dueDate,
    usdNotional,
    rate,
    banrepRef: `BR-DER-${dueDate.slice(0, 7).replace('-', '')}-${String(seq).padStart(4, '0')}`,
    bookedAt,
    settledCop: settled ? ndfSettlement(rate, settled.fixing, usdNotional) : null,
    fixing: settled ? settled.fixing : null,
  };
}

export function buildSeed(): Snapshot {
  const installments: Installment[] = [];
  const locks: Lock[] = [];
  const offers: RenewalOffer[] = [];
  const legs: HedgeLeg[] = [];
  const trades: HedgeTrade[] = [];
  const receipts: Receipt[] = [];

  const byPlan = new Map<string, Installment[]>();
  for (const plan of plans) {
    const rows = makeInstallments(plan);
    byPlan.set(plan.id, rows);
    installments.push(...rows);
  }
  const inst = (planId: string, idx: number): Installment => byPlan.get(planId)![idx]!;
  const baseFwds = [BASE_FORWARDS['1M'], BASE_FORWARDS['2M'], BASE_FORWARDS['3M']];

  // ---------------- María: Q1 paid under a quarterly lock (closed) ----------------
  const maria = plans[0]!;
  const q1 = makeLock({
    id: 'lock-maria-q1',
    plan: maria,
    tenor: 'trimestral',
    idxs: [0, 1, 2],
    spot: BASE_SPOT,
    fwdRates: baseFwds,
    createdAt: '2026-08-10T14:02:00.000Z',
    acceptedAt: '2026-08-10T14:06:00.000Z',
    state: 'cerrado',
    curveAsOf: CURVE_AS_OF,
  });
  locks.push(q1.lock);
  const q1Fixings = [BASE_SPOT, 3431.9, 3418.75];
  const q1AnchorRates = [BASE_SPOT, 3429.1, 3418.75]; // M2: anchor below the TRM → basis difference
  q1.lock.idxs.forEach((idx, k) => {
    const row = inst(maria.id, idx);
    const tradeId = `DAV-NDF-2026-${String(417 + k).padStart(4, '0')}`;
    const trade = makeTrade(tradeId, row.dueDate, q1.usdExact[k]!, q1.lock.fwdRates[k]!, '2026-08-11T13:00:00.000Z', 417 + k, { fixing: q1Fixings[k]! });
    trades.push(trade);
    legs.push({
      id: `leg-${q1.lock.id}-${idx}`,
      lockId: q1.lock.id,
      planId: maria.id,
      installmentIdx: idx,
      dueDate: row.dueDate,
      usdNotional: q1.usdExact[k]!,
      lockedRate: q1.lock.lockedRate,
      fwdRate: q1.lock.fwdRates[k]!,
      tradeId,
      bookedAt: trade.bookedAt,
      settledCop: trade.settledCop,
      fixing: trade.fixing,
      settledAt: `${row.dueDate}T16:00:00.000Z`,
      state: 'liquidada',
    });
    const receipt = makeReceipt({
      plan: maria,
      installment: row,
      paidAt: `${row.dueDate}T14:05:00.000Z`,
      usdPaid: q1.lock.usdPerInstallment[k]!,
      rateKind: 'locked',
      lockedRate: q1.lock.lockedRate,
      fixing: q1Fixings[k]!,
      anchorRate: q1AnchorRates[k]!,
      lockId: q1.lock.id,
      hedgeTradeId: tradeId,
      ndfSettlementCop: trade.settledCop,
      fwdRate: q1.lock.fwdRates[k]!,
    });
    receipts.push(receipt);
    Object.assign(row, {
      status: 'released',
      lockId: q1.lock.id,
      lockedRate: q1.lock.lockedRate,
      usdDue: q1.lock.usdPerInstallment[k]!,
      lockExpiry: graceEndDate(row.dueDate),
      releasedTx: receipt.txHash,
      releasedAt: receipt.paidAt,
      receiptId: receipt.id,
    } satisfies Partial<Installment>);
  });

  // ---------------- María: Q2 locked and hedged, unpaid (M4 is the demo payment) ----------------
  const q2 = makeLock({
    id: 'lock-maria-q2',
    plan: maria,
    tenor: 'trimestral',
    idxs: [3, 4, 5],
    spot: BASE_SPOT,
    fwdRates: baseFwds,
    createdAt: '2026-10-05T15:30:00.000Z',
    acceptedAt: '2026-10-05T15:34:00.000Z',
    state: 'activo',
    curveAsOf: CURVE_AS_OF,
  });
  locks.push(q2.lock);
  q2.lock.idxs.forEach((idx, k) => {
    const row = inst(maria.id, idx);
    const tradeId = `DAV-NDF-2026-${String(521 + k).padStart(4, '0')}`;
    const trade = makeTrade(tradeId, row.dueDate, q2.usdExact[k]!, q2.lock.fwdRates[k]!, '2026-10-07T14:15:00.000Z', 521 + k);
    trades.push(trade);
    legs.push({
      id: `leg-${q2.lock.id}-${idx}`,
      lockId: q2.lock.id,
      planId: maria.id,
      installmentIdx: idx,
      dueDate: row.dueDate,
      usdNotional: q2.usdExact[k]!,
      lockedRate: q2.lock.lockedRate,
      fwdRate: q2.lock.fwdRates[k]!,
      tradeId,
      bookedAt: trade.bookedAt,
      settledCop: null,
      fixing: null,
      settledAt: null,
      state: 'reservada',
    });
    Object.assign(row, {
      status: 'locked',
      lockId: q2.lock.id,
      lockedRate: q2.lock.lockedRate,
      usdDue: q2.lock.usdPerInstallment[k]!,
      lockExpiry: graceEndDate(row.dueDate),
    } satisfies Partial<Installment>);
  });

  // María: an expired monthly quote for M4 (she chose the quarterly lock instead)
  const expired = makeLock({
    id: 'lock-maria-m4-vencido',
    plan: maria,
    tenor: 'mensual',
    idxs: [3],
    spot: BASE_SPOT,
    fwdRates: [BASE_FORWARDS['1M']],
    createdAt: '2026-10-01T16:00:00.000Z',
    acceptedAt: null,
    state: 'vencido',
    curveAsOf: CURVE_AS_OF,
    quoteExpiresAt: '2026-10-01T16:10:00.000Z',
  });
  locks.push(expired.lock);

  // María: Q3 renewal offer (M7 to M9), dashed on the calendar with the renewal banner
  offers.push({ id: 'offer-maria-q3', planId: maria.id, tenor: 'trimestral', idxs: [6, 7, 8], offeredAt: BASE_DATE, state: 'ofrecido' });

  // ---------------- Andrés: Q1 broke (M3 missed beyond grace), Q2 active with M5 late in grace ----------------
  const andres = plans[1]!;
  const aq1 = makeLock({
    id: 'lock-andres-q1',
    plan: andres,
    tenor: 'trimestral',
    idxs: [0, 1, 2],
    spot: 3410.5,
    fwdRates: [3431.9, 3455.8, 3482.1],
    createdAt: '2026-05-05T15:00:00.000Z',
    acceptedAt: '2026-05-05T15:04:00.000Z',
    state: 'roto',
    curveAsOf: '2026-05-05',
  });
  const spotAtBreak = 3496.4;
  aq1.lock.brokenIdx = 2;
  aq1.lock.breakCostCop = breakCost(spotAtBreak, aq1.lock.fwdRates[2]!, aq1.usdExact[2]!);
  locks.push(aq1.lock);
  const aq1Fixings = [3418.2, 3440.75, spotAtBreak];
  aq1.lock.idxs.forEach((idx, k) => {
    const row = inst(andres.id, idx);
    const tradeId = `DAV-NDF-2026-${String(203 + k).padStart(4, '0')}`;
    const trade = makeTrade(tradeId, row.dueDate, aq1.usdExact[k]!, aq1.lock.fwdRates[k]!, '2026-05-06T13:30:00.000Z', 203 + k, { fixing: aq1Fixings[k]! });
    trades.push(trade);
    const broken = k === 2;
    legs.push({
      id: `leg-${aq1.lock.id}-${idx}`,
      lockId: aq1.lock.id,
      planId: andres.id,
      installmentIdx: idx,
      dueDate: row.dueDate,
      usdNotional: aq1.usdExact[k]!,
      lockedRate: aq1.lock.lockedRate,
      fwdRate: aq1.lock.fwdRates[k]!,
      tradeId,
      bookedAt: trade.bookedAt,
      settledCop: trade.settledCop,
      fixing: trade.fixing,
      settledAt: `${row.dueDate}T16:00:00.000Z`,
      state: broken ? 'rota' : 'liquidada',
    });
    if (broken) {
      Object.assign(row, {
        status: 'broken',
        lockId: aq1.lock.id,
        lockedRate: null,
        usdDue: null,
        lockExpiry: graceEndDate(row.dueDate),
        breakCostCop: aq1.lock.breakCostCop,
      } satisfies Partial<Installment>);
      return;
    }
    const receipt = makeReceipt({
      plan: andres,
      installment: row,
      paidAt: `${row.dueDate}T15:10:00.000Z`,
      usdPaid: aq1.lock.usdPerInstallment[k]!,
      rateKind: 'locked',
      lockedRate: aq1.lock.lockedRate,
      fixing: aq1Fixings[k]!,
      anchorRate: aq1Fixings[k]!,
      lockId: aq1.lock.id,
      hedgeTradeId: tradeId,
      ndfSettlementCop: trade.settledCop,
      fwdRate: aq1.lock.fwdRates[k]!,
    });
    receipts.push(receipt);
    Object.assign(row, {
      status: 'released',
      lockId: aq1.lock.id,
      lockedRate: aq1.lock.lockedRate,
      usdDue: aq1.lock.usdPerInstallment[k]!,
      lockExpiry: graceEndDate(row.dueDate),
      releasedTx: receipt.txHash,
      releasedAt: receipt.paidAt,
      receiptId: receipt.id,
    } satisfies Partial<Installment>);
  });

  const aq2 = makeLock({
    id: 'lock-andres-q2',
    plan: andres,
    tenor: 'trimestral',
    idxs: [3, 4, 5],
    spot: 3438.2,
    fwdRates: [3458.5, 3481.0, 3508.9],
    createdAt: '2026-09-01T14:00:00.000Z',
    acceptedAt: '2026-09-01T14:03:00.000Z',
    state: 'activo',
    curveAsOf: '2026-09-01',
  });
  locks.push(aq2.lock);
  aq2.lock.idxs.forEach((idx, k) => {
    const row = inst(andres.id, idx);
    const tradeId = `DAV-NDF-2026-${String(388 + k).padStart(4, '0')}`;
    const trade = makeTrade(tradeId, row.dueDate, aq2.usdExact[k]!, aq2.lock.fwdRates[k]!, '2026-09-03T13:45:00.000Z', 388 + k);
    trades.push(trade);
    legs.push({
      id: `leg-${aq2.lock.id}-${idx}`,
      lockId: aq2.lock.id,
      planId: andres.id,
      installmentIdx: idx,
      dueDate: row.dueDate,
      usdNotional: aq2.usdExact[k]!,
      lockedRate: aq2.lock.lockedRate,
      fwdRate: aq2.lock.fwdRates[k]!,
      tradeId,
      bookedAt: trade.bookedAt,
      settledCop: null,
      fixing: null,
      settledAt: null,
      state: 'reservada',
    });
    Object.assign(row, {
      status: 'locked',
      lockId: aq2.lock.id,
      lockedRate: aq2.lock.lockedRate,
      usdDue: aq2.lock.usdPerInstallment[k]!,
      lockExpiry: graceEndDate(row.dueDate),
    } satisfies Partial<Installment>);
    if (k === 0) {
      // M4 paid at the locked rate; the NDF settlement has not been received yet → "Pendiente"
      const receipt = makeReceipt({
        plan: andres,
        installment: row,
        paidAt: `${row.dueDate}T15:40:00.000Z`,
        usdPaid: aq2.lock.usdPerInstallment[k]!,
        rateKind: 'locked',
        lockedRate: aq2.lock.lockedRate,
        fixing: 3433.6,
        anchorRate: 3433.6,
        lockId: aq2.lock.id,
        hedgeTradeId: tradeId,
        ndfSettlementCop: null,
        fwdRate: aq2.lock.fwdRates[k]!,
      });
      receipts.push(receipt);
      Object.assign(row, { status: 'released', usdDue: receipt.usdPaid, releasedTx: receipt.txHash, releasedAt: receipt.paidAt, receiptId: receipt.id } satisfies Partial<Installment>);
    }
  });

  // ---------------- Camila: no locks, two installments paid at spot (exact COP, USD to the cent) ----------------
  const camila = plans[2]!;
  [
    { idx: 0, rate: 3428.1 },
    { idx: 1, rate: 3421.0 },
  ].forEach(({ idx, rate }) => {
    const row = inst(camila.id, idx);
    const receipt = makeReceipt({
      plan: camila,
      installment: row,
      paidAt: `${row.dueDate}T13:20:00.000Z`,
      usdPaid: usdToCoverCop(row.copDue, rate),
      rateKind: 'spot',
      lockedRate: null,
      fixing: rate,
      anchorRate: rate,
      lockId: null,
      hedgeTradeId: null,
      ndfSettlementCop: null,
      fwdRate: null,
    });
    receipts.push(receipt);
    Object.assign(row, { status: 'released', usdDue: receipt.usdPaid, releasedTx: receipt.txHash, releasedAt: receipt.paidAt, receiptId: receipt.id } satisfies Partial<Installment>);
  });

  // ---------------- Adverse-event buyers: spot payments, then the recorded transitions ----------------
  const governance = new Map<string, PlanGovernance>(plans.map((p) => [p.id, defaultGovernance(p.id)]));
  const events: PolicyEvent[] = [];
  const paySpot = (plan: Plan, idx: number, rate: number) => {
    const row = inst(plan.id, idx);
    const receipt = makeReceipt({
      plan,
      installment: row,
      paidAt: `${row.dueDate}T14:30:00.000Z`,
      usdPaid: usdToCoverCop(row.copDue, rate),
      rateKind: 'spot',
      lockedRate: null,
      fixing: rate,
      anchorRate: rate,
      lockId: null,
      hedgeTradeId: null,
      ndfSettlementCop: null,
      fwdRate: null,
    });
    receipts.push(receipt);
    Object.assign(row, { status: 'released', usdDue: receipt.usdPaid, releasedTx: receipt.txHash, releasedAt: receipt.paidAt, receiptId: receipt.id } satisfies Partial<Installment>);
  };
  const recordEvent = (e: { id?: string; planId: string; at: string; kind: PolicyEventKind; idx: number | null; from: PlanState; to: PlanState; reasonCode: number; rule: string; executed?: boolean; amountCents?: number | null; detail?: string }) => {
    const seq = events.length + 1;
    const record = { planId: e.planId, kind: e.kind, idx: e.idx, from: e.from, to: e.to, reasonCode: e.reasonCode, amountCents: e.amountCents ?? null, at: e.at, seq };
    const executed = e.executed ?? true;
    events.push({
      id: e.id ?? `pe-${e.planId}-${String(seq).padStart(5, '0')}`,
      ...record,
      rule: e.rule,
      policyStatus: 'pending',
      executed,
      evidence: evidenceHash(record),
      ref: executed ? mockTxHash(`${e.kind}:${e.planId}:${seq}`) : null,
      detail: e.detail ?? null,
    });
  };
  const govern = (planId: string, patch: Partial<PlanGovernance>) => governance.set(planId, { ...governance.get(planId)!, ...patch });

  // Andrés: M5 is late inside the grace period (a notice, nothing on chain).
  recordEvent({ id: `pe-${andres.id}-late-4`, planId: andres.id, at: BASE_DATE, kind: 'late_in_grace', idx: 4, from: 'active', to: 'active', reasonCode: REASONS.GRACE_EXPIRED.code, rule: 'R1-late-in-grace', executed: false, detail: 'M5 due 2026-10-15' });

  // Luis: M1–M2 paid; M3 waived by the builder (construction delay credit); M4 missed past grace.
  const luis = plans.find((p) => p.id === PLAN_LUIS)!;
  paySpot(luis, 0, 3409.8);
  paySpot(luis, 1, 3415.2);
  inst(luis.id, 2).status = 'waived';
  recordEvent({ planId: luis.id, at: '2026-08-25', kind: 'waive', idx: 2, from: 'active', to: 'active', reasonCode: REASONS.WAIVED_BY_BUILDER.code, rule: 'operator', detail: 'credit for the delayed handover of the model unit' });
  inst(luis.id, 3).status = 'missed';
  recordEvent({ planId: luis.id, at: '2026-09-28', kind: 'mark_missed', idx: 3, from: 'active', to: 'delinquent', reasonCode: REASONS.GRACE_EXPIRED.code, rule: 'R2-missed-past-grace', detail: 'M4 due 2026-09-20' });
  govern(luis.id, { state: 'delinquent', misses: 1, reasonCode: REASONS.GRACE_EXPIRED.code, since: '2026-09-28' });

  // Paola: M1–M3 paid; plan on hold while the bank re-verifies her identity.
  const paola = plans.find((p) => p.id === PLAN_PAOLA)!;
  [3418.4, 3425.0, 3430.6].forEach((rate, idx) => paySpot(paola, idx, rate));
  recordEvent({ planId: paola.id, at: '2026-10-14', kind: 'place_hold', idx: null, from: 'active', to: 'on_hold', reasonCode: REASONS.KYC_REVIEW.code, rule: 'operator', detail: 'identity documents expired at the US bank' });
  govern(paola.id, { state: 'on_hold', holdPrev: 'active', reasonCode: REASONS.KYC_REVIEW.code, since: '2026-10-14' });

  // Jorge: M1 paid; M2–M4 missed; default declared by a person after the policy flagged it.
  const jorge = plans.find((p) => p.id === PLAN_JORGE)!;
  paySpot(jorge, 0, 3398.7);
  [1, 2, 3].forEach((idx, k) => {
    inst(jorge.id, idx).status = 'missed';
    const at = addMonths('2026-05-25', k);
    recordEvent({ planId: jorge.id, at, kind: 'mark_missed', idx, from: k === 0 ? 'active' : 'delinquent', to: 'delinquent', reasonCode: REASONS.GRACE_EXPIRED.code, rule: 'R2-missed-past-grace', detail: `M${idx + 1} due ${inst(jorge.id, idx).dueDate}` });
  });
  recordEvent({ id: `pe-${jorge.id}-default-eligible-3`, planId: jorge.id, at: '2026-07-25', kind: 'default_eligible', idx: null, from: 'delinquent', to: 'delinquent', reasonCode: REASONS.REPEATED_MISSES.code, rule: 'R3-default-review', executed: false, detail: '3 missed, threshold 3' });
  recordEvent({ planId: jorge.id, at: '2026-09-01', kind: 'declare_default', idx: null, from: 'delinquent', to: 'defaulted', reasonCode: REASONS.REPEATED_MISSES.code, rule: 'operator', detail: 'approved by the builder after two calls and a letter' });
  govern(jorge.id, { state: 'defaulted', misses: 3, reasonCode: REASONS.REPEATED_MISSES.code, since: '2026-09-01' });

  // Natalia: M1–M5 paid; withdrew (desistimiento) on 2026-10-02 after depositing M6, which is held.
  const natalia = plans.find((p) => p.id === PLAN_NATALIA)!;
  [3402.5, 3398.1, 3411.0, 3420.3, 3427.9].forEach((rate, idx) => paySpot(natalia, idx, rate));
  const heldCents = Math.round(usdToCoverCop(natalia.installmentCop, 3431.2) * 100);
  recordEvent({ planId: natalia.id, at: '2026-10-02', kind: 'cancel_plan', idx: null, from: 'active', to: 'cancelled', reasonCode: REASONS.BUYER_WITHDRAWAL.code, rule: 'operator', detail: 'desistimiento signed; refund amount depends on the encargo penalty clause' });
  govern(natalia.id, { state: 'cancelled', reasonCode: REASONS.BUYER_WITHDRAWAL.code, since: '2026-10-02', balanceCents: heldCents });

  // ---------------- El Salvador: built apart, appended after the Colombia rows ----------------
  const sv = buildSvSeed({ baseDate: BASE_DATE, makeInstallments, recordEvent });
  for (const g of sv.plan_governance) governance.set(g.planId, g);

  const curves: CurvePoint[] = curveAtOffset(0, BASE_DATE).map((p) => ({ ...p, source: CURVE_SOURCE }));

  const demoState: DemoState = {
    id: 'singleton',
    baseDate: BASE_DATE,
    clockOffsetMonths: 0,
    today: BASE_DATE,
    passThrough: DEFAULT_PASS_THROUGH,
    errorMode: false,
    mode: 'mock',
    curveAsOf: CURVE_AS_OF,
    lastResetMs: null,
    seedVersion: SEED_VERSION,
  };

  return {
    buyers: [...buyers, ...sv.buyers],
    units: [...units, ...sv.units],
    plans: [...plans, ...sv.plans],
    installments: [...installments, ...sv.installments],
    locks,
    renewal_offers: offers,
    hedge_legs: legs,
    hedge_trades: trades,
    receipts: [...receipts, ...sv.receipts],
    curves,
    demo_state: [demoState],
    plan_governance: [...governance.values()],
    policy_events: events,
    payments: sv.payments,
    sellers: sv.sellers,
    seller_units: sv.seller_units,
    offices: sv.offices,
    payouts: sv.payouts,
    wa_outbox: sv.wa_outbox,
  };
}
