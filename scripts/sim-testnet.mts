// `npm run sim:testnet`: one month of mixed buyer behaviour through the real testnet stack: the
// deployed `payment_plan` contract, test USDC, the event indexer and (when the receiving anchor
// answers) one SEP-31 payout. Each scenario is a fresh plan on chain, run in parallel on the
// channel accounts:
//
//   on-time        quarterly lock, three releases at the due date, then the payout to the encargo
//   pay-ahead      two installments paid at spot weeks before they are due
//   late-in-grace  paid two days late with five days of grace: mark_missed is refused (GraceNotOver)
//   missed         two installments past grace marked Missed: the plan becomes Delinquent
//   cure           the first missed installment is cured and paid; the second stays missed
//   broken-lock    a monthly lock passes its expiry, break_lock, then paid at spot
//   hold           place_hold refuses a deposit (PlanBlocked) until lift_hold
//   withdrawal     buyer withdraws: cancel_plan, refund of the unused balance
//
// Due dates live on compressed time (seconds or backdated days), as the demo seed does. Writes a
// dated log to docs/demo-runs/<date>-sim.md with explorer links and a per-plan funds-conservation
// check: deposits = releases + refunds + vault balance, from the indexed events, from the plan's
// governance totals and from the transactions the script sent. Exits 1 if any check fails.
//   --no-offramp   skip the SEP-31 payout
//   --out <dir>    where to write the log (default docs/demo-runs)

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ChainClient,
  ChainError,
  DEMO_POLICY,
  REASON,
  evidenceHash,
  lockIdBytes,
  lockedStroops,
  randomPlanId,
  usdToStroops,
  type ChainPolicy,
  type ChainPlanStatus,
  type TxResult,
} from '../services/src/index.ts';
import { explorerContractUrl, explorerTxUrl } from '../services/src/chain/env.ts';
import { fixedPointRate } from '../services/src/lock/engine.ts';
import { EventIndexer } from '../services/src/indexer/indexer.ts';
import { Sep31OffRampProvider } from '../services/src/adapters/sep31OffRamp.ts';
import { REPO_ROOT, configFromEnv, loadEnv } from '../services/server/src/config.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, dflt: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : dflt;
};

const cfg = configFromEnv(loadEnv());
const client = new ChainClient(cfg.chain);
const server = client.submitter.server;
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (msg: string) => console.log(`[${elapsed()}] ${msg}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

// §11 figures: COP 4,093,125 per installment, quarterly locked rate 3,444.427, spot 3,422.341.
const COP_DUE = 4_093_125n;
const LOCKED_RATE = 3444.427;
const LOCKED = lockedStroops(Number(COP_DUE), LOCKED_RATE); // 1,188.33 USD
const SPOT = usdToStroops(1196.01);
const BUYERS = Object.keys(cfg.chain.buyers);
const usd = (s: bigint) => (Number(s) / 1e7).toFixed(2);

interface Step {
  label: string;
  txHash?: string;
  ledger?: number;
  /** Expected refusal checked by simulation (nothing sent). */
  refused?: string;
}

interface Scenario {
  key: string;
  title: string;
  buyerId: string;
  planId: number;
  steps: Step[];
  /** What the script sent, for the third column of the conservation check. */
  sent: { deposited: bigint; released: bigint; refunded: bigint };
  expect: { state: string; statuses: string[] };
  status?: ChainPlanStatus;
  error?: string;
}

function scenario(key: string, title: string, n: number, expect: Scenario['expect']): Scenario {
  return { key, title, buyerId: BUYERS[n % BUYERS.length]!, planId: randomPlanId(), steps: [], sent: { deposited: 0n, released: 0n, refunded: 0n }, expect };
}

async function tx<T>(s: Scenario, label: string, run: () => Promise<TxResult<T>>): Promise<TxResult<T>> {
  const r = await run();
  s.steps.push({ label, txHash: r.txHash, ledger: r.ledger });
  log(`${s.key}: ${label} (ledger ${r.ledger})`);
  return r;
}

/** Runs a call that must be refused with `errorName`; the refusal comes from simulation. */
async function refused(s: Scenario, label: string, errorName: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    const name = e instanceof ChainError ? e.errorName : String(e);
    if (name !== errorName) throw new Error(`${label}: expected ${errorName}, got ${name}`);
    s.steps.push({ label, refused: errorName });
    log(`${s.key}: ${label} refused as expected (${errorName})`);
    return;
  }
  throw new Error(`${label}: expected ${errorName}, but the call went through`);
}

const create = (s: Scenario, dues: number[], policy: ChainPolicy = DEMO_POLICY) =>
  tx(s, `create_plan #${s.planId} (${dues.length} installments, grace ${policy.graceDays} d)`, () =>
    client.createPlan(s.planId, s.buyerId, dues.map((dueTs) => ({ dueTs, copDue: COP_DUE })), policy),
  );

async function fund(s: Scenario, stroops: bigint): Promise<void> {
  await tx(s, `mint ${usd(stroops)} test USDC to ${s.buyerId}`, () => client.mintTestUsdc(client.buyerPublic(s.buyerId), stroops));
  await tx(s, `deposit ${usd(stroops)}`, () => client.deposit(s.buyerId, s.planId, stroops));
  s.sent.deposited += stroops;
}

async function spot(s: Scenario, idx: number, label: string): Promise<void> {
  await tx(s, `release_spot M${idx + 1} ${usd(SPOT)} (${label})`, () => client.releaseSpot(s.planId, idx, SPOT));
  s.sent.released += SPOT;
}

const evidence = (s: Scenario, what: string) => evidenceHash(`sim ${s.planId} ${what}`);
const waitUntil = async (ts: number) => {
  const ms = (ts - now() + 7) * 1000; // a few seconds past, so the next ledger's close time is too
  if (ms > 0) await sleep(ms);
};

// ---------- scenarios ----------

const runs: Record<string, (s: Scenario) => Promise<void>> = {
  async 'on-time'(s) {
    const due = now() + 75;
    await create(s, [due, due + 1, due + 2]);
    await fund(s, LOCKED * 3n);
    await tx(s, 'apply_lock M1–M3 quarterly at 3,444.427', () =>
      client.applyLock(s.buyerId, s.planId, [0, 1, 2], lockIdBytes(`SIM-${s.planId}-Q`), fixedPointRate(LOCKED_RATE), due + 600),
    );
    await refused(s, 'release_due M1 before the due date', 'NotDue', () => client.releaseDue(s.planId, 0));
    await waitUntil(due + 2);
    for (const idx of [0, 1, 2]) {
      await tx(s, `release_due M${idx + 1} ${usd(LOCKED)} at the locked rate`, () => client.releaseDue(s.planId, idx));
      s.sent.released += LOCKED;
    }
    await refused(s, 'release_due M1 a second time', 'NotLocked', () => client.releaseDue(s.planId, 0));
  },
  async 'pay-ahead'(s) {
    const base = now() + 30 * DAY;
    await create(s, [base, base + 30 * DAY, base + 60 * DAY]);
    await fund(s, SPOT * 3n);
    await spot(s, 0, '30 days early');
    await spot(s, 1, '60 days early');
  },
  async 'late-in-grace'(s) {
    const due = now() - 2 * DAY;
    await create(s, [due, due + 30 * DAY], { ...DEMO_POLICY, graceDays: 5 });
    await fund(s, SPOT);
    await refused(s, 'mark_missed M1 two days late, grace 5 days', 'GraceNotOver', () =>
      client.markMissed(s.planId, 0, REASON.missedPayment, evidence(s, 'late')),
    );
    await spot(s, 0, 'two days late, within grace');
  },
  async 'missed-and-cure'(s) {
    const due = now() - 10 * DAY;
    await create(s, [due, due + 1, now() + 30 * DAY], { ...DEMO_POLICY, graceDays: 5 });
    await tx(s, 'mark_missed M1 past grace', () => client.markMissed(s.planId, 0, REASON.missedPayment, evidence(s, 'M1 missed')));
    await tx(s, 'mark_missed M2 past grace', () => client.markMissed(s.planId, 1, REASON.missedPayment, evidence(s, 'M2 missed')));
    await refused(s, 'release_spot M1 while Missed', 'NotReleasable', () => client.releaseSpot(s.planId, 0, SPOT));
    await fund(s, SPOT);
    await tx(s, 'cure M1 (buyer caught up)', () => client.cure(s.planId, 0, REASON.paymentReceived, evidence(s, 'M1 cured')));
    await spot(s, 0, 'after the cure');
  },
  async 'broken-lock'(s) {
    const due = now() - DAY;
    await create(s, [due, now() + 30 * DAY]);
    await fund(s, SPOT);
    const expiry = now() + 30;
    await tx(s, 'apply_lock M1 monthly, expiring in 30 s', () =>
      client.applyLock(s.buyerId, s.planId, [0], lockIdBytes(`SIM-${s.planId}-M`), fixedPointRate(3432.235), expiry),
    );
    await refused(s, 'break_lock M1 before expiry', 'LockNotExpired', () => client.breakLock(s.planId, 0));
    await waitUntil(expiry);
    await tx(s, 'break_lock M1 after expiry', () => client.breakLock(s.planId, 0));
    await spot(s, 0, 'broken lock paid at spot');
  },
  async hold(s) {
    await create(s, [now() + 30 * DAY]);
    await tx(s, 'place_hold (compliance review)', () => client.placeHold(s.planId, REASON.complianceHold, evidence(s, 'hold')));
    await tx(s, `mint ${usd(SPOT)} test USDC to ${s.buyerId}`, () => client.mintTestUsdc(client.buyerPublic(s.buyerId), SPOT));
    await refused(s, 'deposit while on hold', 'PlanBlocked', () => client.deposit(s.buyerId, s.planId, SPOT));
    await tx(s, 'lift_hold (review cleared)', () => client.liftHold(s.planId, REASON.holdCleared, evidence(s, 'lift')));
    await tx(s, `deposit ${usd(SPOT)}`, () => client.deposit(s.buyerId, s.planId, SPOT));
    s.sent.deposited += SPOT;
    await spot(s, 0, 'paid after the hold');
  },
  async withdrawal(s) {
    await create(s, [now() + 30 * DAY, now() + 60 * DAY]);
    await fund(s, SPOT * 2n);
    await spot(s, 0, 'first installment');
    await refused(s, 'refund while Active', 'RefundNotAllowed', () => client.refund(s.planId, SPOT, REASON.refund, evidence(s, 'early refund')));
    await tx(s, 'cancel_plan (buyer withdrawal)', () => client.cancelPlan(s.planId, REASON.buyerWithdrawal, evidence(s, 'withdrawal')));
    await tx(s, `refund ${usd(SPOT)} to the buyer`, () => client.refund(s.planId, SPOT, REASON.refund, evidence(s, 'refund')));
    s.sent.refunded += SPOT;
  },
};

const scenarios: Scenario[] = [
  scenario('on-time', 'On time, quarterly lock released at the due date', 0, { state: 'active', statuses: ['released', 'released', 'released'] }),
  scenario('pay-ahead', 'Pays two installments ahead at spot', 1, { state: 'active', statuses: ['released', 'released', 'open'] }),
  scenario('late-in-grace', 'Two days late, within the 5-day grace', 2, { state: 'active', statuses: ['released', 'open'] }),
  scenario('missed-and-cure', 'Two installments missed past grace; one cured and paid', 0, { state: 'delinquent', statuses: ['released', 'missed', 'open'] }),
  scenario('broken-lock', 'Monthly lock broken after expiry, paid at spot', 1, { state: 'active', statuses: ['released', 'open'] }),
  scenario('hold', 'Compliance hold placed and lifted', 2, { state: 'active', statuses: ['released'] }),
  scenario('withdrawal', 'Buyer withdraws: cancel and refund', 0, { state: 'cancelled', statuses: ['released', 'open'] }),
];

// ---------- run ----------

if (!(await client.health())) throw new Error(`RPC ${cfg.rpcUrl} is not healthy`);
const version = await client.version();
const startLedger = (await server.getLatestLedger()).sequence;
log(`contract ${cfg.chain.contractId} schema v${version}, ${cfg.chain.channelSecrets?.length ?? 0} channels, start ledger ${startLedger}`);

await Promise.all(
  scenarios.map(async (s) => {
    try {
      await runs[s.key]!(s);
    } catch (e) {
      s.error = e instanceof Error ? e.message : String(e);
      log(`${s.key}: FAILED ${s.error}`);
    }
  }),
);

// One SEP-31 payout of the on-time plan's first release to the encargo, when the receiver answers.
interface Payout {
  txId: string;
  stellarTxHash: string;
  statuses: string[];
  cop: number;
  final: string;
}
let payout: Payout | null = null;
let payoutNote = '';
const onTime = scenarios[0]!;
if (flag('--no-offramp') || cfg.offRamp !== 'sep31') payoutNote = 'skipped (--no-offramp or OFFRAMP=mock)';
else if (onTime.error) payoutNote = 'skipped: the on-time scenario failed';
else {
  const up = await fetch(`${cfg.offRampHomeUrl}/health`, { signal: AbortSignal.timeout(3_000) }).then((r) => r.ok, () => false);
  if (!up) payoutNote = `skipped: no receiving anchor at ${cfg.offRampHomeUrl} (start it with npm run infra:up)`;
  else {
    try {
      const off = new Sep31OffRampProvider({
        homeUrl: cfg.offRampHomeUrl,
        senderSecret: cfg.payeeBackendSecret,
        usdc: { code: 'USDC', issuer: cfg.usdcIssuer },
        networkPassphrase: cfg.networkPassphrase,
        horizonUrl: cfg.horizonUrl,
        sender: { first_name: 'Casa Puente', last_name: 'S.A.S.', email_address: 'operaciones@casapuente.example' },
        log: (m) => log(`off-ramp: ${m}`),
      });
      const q = await off.quote({ usdc: (Number(LOCKED) / 1e7).toFixed(7) });
      const paid = await off.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'FD-OLV-0142', memo: `SIM-${onTime.planId}-M1` });
      const statuses = [paid.sep31Status];
      const deadline = Date.now() + 120_000;
      while (!['completed', 'refunded', 'expired', 'error'].includes(statuses[statuses.length - 1]!) && Date.now() < deadline) {
        await sleep(2_000);
        const st = (await off.fetchTransaction(paid.txId)).status;
        if (st !== statuses[statuses.length - 1]) statuses.push(st);
      }
      payout = { txId: paid.txId, stellarTxHash: paid.stellarTxHash, statuses, cop: q.copDelivered, final: statuses[statuses.length - 1]! };
    } catch (e) {
      payoutNote = `failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}

// Indexer over the sim's own ledgers, in its own data dir so it never races a running server.
const lastLedger = Math.max(startLedger, ...scenarios.flatMap((s) => s.steps.map((st) => st.ledger ?? 0)));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const indexer = new EventIndexer({
  contractId: cfg.chain.contractId,
  dataDir: path.join(REPO_ROOT, '.data', 'sim', runId),
  getEvents: (req) => server.getEvents(req),
  startLedger,
  log,
});
const caughtUp = await indexer.waitForLedger(lastLedger, 120_000);
log(`indexer: ${indexer.stats().events} event(s) from ledger ${startLedger} to ${indexer.stats().latestLedger}${caughtUp ? '' : ' (did not reach the last ledger)'}`);

for (const s of scenarios) {
  try {
    s.status = await client.getStatus(s.planId);
  } catch (e) {
    s.error ??= `get_status: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ---------- checks ----------

interface Check {
  s: Scenario;
  events: { deposited: bigint; released: bigint; refunded: bigint; count: number; names: string[] };
  balance: bigint;
  ok: boolean;
  problems: string[];
}

const sum = (rows: { data: Record<string, unknown> }[], field: string) => rows.reduce((a, e) => a + BigInt(String(e.data[field] ?? 0)), 0n);
const checks: Check[] = scenarios.map((s) => {
  const evs = indexer.eventsForPlan(s.planId);
  const by = (n: string) => evs.filter((e) => e.name === n);
  const events = { deposited: sum(by('deposited'), 'amount'), released: sum(by('released'), 'usd_amount'), refunded: sum(by('refunded'), 'amount'), count: evs.length, names: evs.map((e) => e.name) };
  const problems: string[] = [];
  if (s.error) problems.push(s.error);
  const st = s.status;
  const balance = st?.plan.balanceUsdc ?? -1n;
  if (st) {
    const g = st.governance;
    if (events.deposited !== events.released + events.refunded + balance) problems.push('indexed events do not conserve funds');
    if (g.totalDeposited !== g.totalReleased + g.totalRefunded + balance) problems.push('governance totals do not conserve funds');
    if (g.totalDeposited !== events.deposited || g.totalReleased !== events.released || g.totalRefunded !== events.refunded) problems.push('governance totals differ from the indexed events');
    if (s.sent.deposited !== events.deposited || s.sent.released !== events.released || s.sent.refunded !== events.refunded) problems.push('indexed events differ from the transactions sent');
    if (g.state !== s.expect.state) problems.push(`plan state ${g.state}, expected ${s.expect.state}`);
    const statuses = st.installments.map((i) => i.status);
    if (statuses.join(',') !== s.expect.statuses.join(',')) problems.push(`installments ${statuses.join(',')}, expected ${s.expect.statuses.join(',')}`);
  }
  if (!caughtUp) problems.push('indexer did not catch up');
  return { s, events, balance, ok: problems.length === 0, problems };
});
const allOk = checks.every((c) => c.ok) && (payout ? payout.final === 'completed' : true);

// ---------- log ----------

const date = new Date().toISOString().slice(0, 10);
const outDir = path.resolve(REPO_ROOT, opt('--out', 'docs/demo-runs'));
mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, `${date}-sim.md`);
const link = (h: string) => `[${h.slice(0, 10)}…](${explorerTxUrl(h)})`;
const md: string[] = [
  `# Testnet simulation · ${date}`,
  '',
  `Generated by \`npm run sim:testnet\` in ${elapsed()}. Contract [${cfg.chain.contractId.slice(0, 8)}…](${explorerContractUrl(cfg.chain.contractId)}) (schema v${version}) on Stellar testnet, ledgers ${startLedger}–${indexer.stats().latestLedger}, ${cfg.chain.channelSecrets?.length ?? 0} channel accounts. Amounts are test USDC; COP ${COP_DUE.toLocaleString('en-US')} per installment, locked ${usd(LOCKED)} USD at 3,444.427, spot ${usd(SPOT)} USD.`,
  '',
  `**Result: ${allOk ? 'PASS' : 'FAIL'}** · ${checks.filter((c) => c.ok).length}/${checks.length} plans conserve funds and end in the expected state · ${indexer.stats().events} events indexed.`,
  '',
  '## Funds conservation per plan',
  '',
  'deposits = releases + refunds + vault balance, from the indexed events; the plan\'s governance totals and the transactions sent must agree with them.',
  '',
  '| Plan | Scenario | Deposits | Releases | Refunds | Balance | State | Check |',
  '| --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  ...checks.map((c) => `| #${c.s.planId} | ${c.s.key} | ${usd(c.events.deposited)} | ${usd(c.events.released)} | ${usd(c.events.refunded)} | ${c.balance >= 0n ? usd(c.balance) : '–'} | ${c.s.status?.governance.state ?? '–'} | ${c.ok ? 'ok' : `FAIL: ${c.problems.join('; ')}`} |`),
  '',
  '## SEP-31 payout',
  '',
  payout
    ? `On-time plan M1, ${usd(LOCKED)} USDC → COP ${payout.cop.toLocaleString('en-US')} to encargo FD-OLV-0142 at the simulated receiving anchor (${cfg.offRampHomeUrl}). SEP-31 transaction \`${payout.txId}\`, statuses ${payout.statuses.join(' → ')}; Stellar payment ${link(payout.stellarTxHash)}.`
    : `Not run: ${payoutNote}.`,
  '',
  '## Scenarios',
  '',
];
for (const c of checks) {
  const s = c.s;
  md.push(`### ${s.key}: ${s.title}`, '', `Plan #${s.planId}, ${s.buyerId}. Events: ${c.events.names.join(', ') || 'none'}.`, '');
  for (const st of s.steps) md.push(`- ${st.label}: ${st.txHash ? `${link(st.txHash)} (ledger ${st.ledger})` : `refused by simulation with \`${st.refused}\`, nothing sent`}`);
  md.push('');
}
writeFileSync(file, md.join('\n'));
log(`log written to ${path.relative(REPO_ROOT, file)}`);
log(allOk ? 'PASS: every plan conserves funds' : 'FAIL: see the log');
process.exit(allOk ? 0 : 1);
