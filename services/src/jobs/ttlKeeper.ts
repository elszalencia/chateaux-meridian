// TTL keeper: a plan's persistent entries are archived when their time-to-live runs out (about 120
// days after the last bump here; the network maximum is about 180 days), and a 24-36 month plan
// outlives that many times over. Once a day the keeper reads how long each plan header has left
// (live-until ledger of `DataKey::Plan(id)`), calls the public `extend_ttl(plan_id)` for every plan
// that still has installments to pay, and warns about any plan that was found with under 30 days.
// TTL expiry is never used as a deadline: due dates live in the stored values.

import { nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import type { ChainPlanStatus } from '../chain/client';
import type { JobFn, JobResult } from './registry';

export const TTL_KEEPER_JOB = 'ttl-keeper';
/** Plans found with fewer days left than this raise a warning. */
export const TTL_WARN_DAYS = 30;
/** Average ledger close time used to turn ledgers into days. */
export const SECONDS_PER_LEDGER = 5;

export const ledgersToDays = (ledgers: number) => (ledgers * SECONDS_PER_LEDGER) / 86_400;

/** `DataKey::Plan(id)` as the contract stores it: a vector of the variant symbol and the id. */
export function planKeyScVal(chainPlanId: number): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Plan'), nativeToScVal(chainPlanId, { type: 'u32' })]);
}

/** Live-until ledger of a plan header, or null when the entry is not found (or archived). */
export async function planLiveUntil(server: rpc.Server, contractId: string, chainPlanId: number): Promise<number | null> {
  try {
    const entry = await server.getContractData(contractId, planKeyScVal(chainPlanId), rpc.Durability.Persistent);
    return entry.liveUntilLedgerSeq ?? null;
  } catch {
    return null;
  }
}

export interface TtlKeeperDeps {
  /** Demo plan id → chain plan id of the plans to keep alive. */
  chainPlans: () => Promise<Record<string, number>>;
  latestLedger: () => Promise<number>;
  liveUntil: (chainPlanId: number) => Promise<number | null>;
  getStatus: (chainPlanId: number) => Promise<ChainPlanStatus>;
  extendTtl: (chainPlanId: number) => Promise<{ txHash: string }>;
  warnDays?: number;
}

export interface TtlPlanReport {
  planId: string;
  chainPlanId: number;
  daysBefore: number | null;
  daysAfter: number | null;
  extended: boolean;
  txHash: string | null;
  note: string;
}

const FINISHED = new Set(['released', 'waived']);

export async function runTtlKeeper(deps: TtlKeeperDeps, log: (msg: string) => void = () => undefined): Promise<JobResult> {
  const warnDays = deps.warnDays ?? TTL_WARN_DAYS;
  const plans = Object.entries(await deps.chainPlans());
  const reports: TtlPlanReport[] = [];
  const warnings: string[] = [];
  for (const [planId, chainPlanId] of plans) {
    const latest = await deps.latestLedger();
    const before = await deps.liveUntil(chainPlanId);
    const daysBefore = before == null ? null : Math.round(ledgersToDays(before - latest) * 10) / 10;
    if (daysBefore == null) warnings.push(`${planId} (#${chainPlanId}): plan entry not found or archived; it must be restored before it can be extended`);
    else if (daysBefore < warnDays) warnings.push(`${planId} (#${chainPlanId}): only ${daysBefore} days of TTL left`);
    let status: ChainPlanStatus | null = null;
    try {
      status = await deps.getStatus(chainPlanId);
    } catch (e) {
      reports.push({ planId, chainPlanId, daysBefore, daysAfter: null, extended: false, txHash: null, note: `unreadable: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    const open = status.installments.filter((i) => !FINISHED.has(i.status)).length;
    const closed = status.governance.state === 'completed' || status.governance.state === 'cancelled';
    if (open === 0 || closed) {
      reports.push({ planId, chainPlanId, daysBefore, daysAfter: daysBefore, extended: false, txHash: null, note: closed ? `plan ${status.governance.state}` : 'nothing left to pay' });
      continue;
    }
    const tx = await deps.extendTtl(chainPlanId);
    const after = await deps.liveUntil(chainPlanId);
    const daysAfter = after == null ? null : Math.round(ledgersToDays(after - (await deps.latestLedger())) * 10) / 10;
    reports.push({ planId, chainPlanId, daysBefore, daysAfter, extended: true, txHash: tx.txHash, note: `${open} installment(s) to pay` });
    log(`${planId} #${chainPlanId}: ${daysBefore ?? '?'} → ${daysAfter ?? '?'} days (${tx.txHash})`);
  }
  const extended = reports.filter((r) => r.extended).length;
  const minDays = Math.min(...reports.map((r) => r.daysAfter ?? Infinity));
  return {
    summary: `${extended}/${reports.length} plan(s) extended${Number.isFinite(minDays) ? `, shortest TTL now ${minDays} days` : ''}`,
    warnings,
    details: reports,
  };
}

export function ttlKeeperJob(deps: TtlKeeperDeps): JobFn {
  return (ctx) => runTtlKeeper(deps, ctx.log);
}
