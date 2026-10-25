// MoneyGramOnRamp: the cash-in network for corridors that offer `moneygram_cash`, shaped like the
// MoneyGram Widget SDK: a session per reference (`createSession`), the widget's postMessage-style
// events (`on`), a status read per reference and an idempotent status webhook (`handleWebhook`).
// It also implements OnRampProvider, so the DemoApi can treat it as a rail next to ACH.
//
// Rule that never bends: a reference credits nothing until the network reports `completed`. The
// provider only tracks state; the DemoApi asks `referenceStatus` before it credits a plan.
//
// Two drivers behind one class:
// - `mock`: in-memory; `simulateCompleted` / `simulateExpired` are the demo controls; delays and the
//   error switch come from MockRuntime.
// - `sep24-standin`: on testnet the SDF test anchor stands in for the cash counter. Extracting a
//   shared SEP-10/24 session out of sep24OnRamp.ts would touch the Stage 3 provider, so this driver
//   wraps a Sep24OnRampProvider instead: `createSession` issues the reference locally (no anchor call
//   yet, as a real cash-in is physical), and `simulateCompleted` ("the buyer paid at the counter")
//   runs the anchor deposit for the buyer; the SEP-24 status then becomes the reference status.
//
// Limits (5 to 950 USD, four excluded states, reference TTL) come from the corridor config
// (`MoneyGramLimits`), passed per session by the caller or as the instance default.

import type { ISODateTime } from '../domain/types';
import type { CashInProvider, CashInReferenceStatus, CashInSession, CashInSessionRequest, OnRampProvider, OnRampStatus } from './interfaces';
import { MockRuntime, mockTxHash } from './mockRuntime';

export type MoneyGramEvent = 'loaded' | 'transaction_created' | 'completed' | 'expired' | 'error';

export type MoneyGramErrorCode = 'ABOVE_LIMIT' | 'BELOW_LIMIT' | 'STATE_EXCLUDED';

export class MoneyGramError extends Error {
  constructor(public readonly code: MoneyGramErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'MoneyGramError';
  }
}

export interface MoneyGramLimitsInput {
  minUsd: number;
  maxUsd: number;
  excludedStates: readonly string[];
  referenceTtlMinutes: number;
}

export interface MoneyGramWebhook {
  referenceNumber: string;
  status: 'completed' | 'expired' | 'error';
  /** The network's event id; a repeated id is ignored. */
  eventId?: string;
  detail?: string;
}

export interface MoneyGramEventPayload {
  event: MoneyGramEvent;
  sessionId: string;
  referenceNumber: string;
  status: CashInReferenceStatus;
  detail?: string;
}

export type MoneyGramEventHandler = (payload: MoneyGramEventPayload) => void;

interface ReferenceRecord {
  session: CashInSession;
  customerIdentifier: string;
  memo: string;
  status: CashInReferenceStatus;
  createdAtMs: number;
  detail: string | null;
  /** sep24-standin: the anchor deposit id once the stand-in deposit ran. */
  depositId: string | null;
}

/** The slice of Sep24OnRampProvider the stand-in driver needs (tests pass a fake). */
export interface StandInDepositRail {
  initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }): Promise<{ depositId: string; status: OnRampStatus }>;
  status(depositId: string): Promise<OnRampStatus>;
}

export interface MoneyGramOnRampOptions {
  driver: 'mock' | 'sep24-standin';
  runtime: MockRuntime;
  /** Default limits when a session request carries none (the corridor that offers the method). */
  limits: MoneyGramLimitsInput;
  /** Default buyer-side fee in USD when a session request carries none. */
  feeUsd?: number;
  /** Clock the reference TTL is measured on (the DemoApi passes the demo clock). */
  now?: () => number;
  /** sep24-standin only. */
  standIn?: StandInDepositRail;
  widgetBaseUrl?: string;
}

const REFERENCE_DIGITS = 8;

export class MoneyGramOnRamp implements CashInProvider, OnRampProvider {
  readonly name: string;
  readonly driver: 'mock' | 'sep24-standin';
  private readonly runtime: MockRuntime;
  private readonly limits: MoneyGramLimitsInput;
  private readonly feeUsd: number;
  private readonly now: () => number;
  private readonly standIn: StandInDepositRail | null;
  private readonly widgetBaseUrl: string;
  private readonly refs = new Map<string, ReferenceRecord>();
  private readonly handlers = new Map<MoneyGramEvent, Set<MoneyGramEventHandler>>();
  private readonly webhookIds = new Set<string>();
  private seq = 0;

  constructor(opts: MoneyGramOnRampOptions) {
    this.driver = opts.driver;
    this.runtime = opts.runtime;
    this.limits = opts.limits;
    this.feeUsd = opts.feeUsd ?? 0;
    this.now = opts.now ?? (() => Date.now());
    this.standIn = opts.standIn ?? null;
    this.widgetBaseUrl = opts.widgetBaseUrl ?? 'https://widget.moneygram.simulado/session';
    this.name = opts.driver === 'mock' ? 'MoneyGram (simulado)' : 'MoneyGram (simulado · ancla de prueba SDF)';
    if (opts.driver === 'sep24-standin' && !opts.standIn) throw new Error('MoneyGramOnRamp: the sep24-standin driver needs a stand-in deposit rail');
  }

  // ---------- Widget SDK shape ----------

  on(event: MoneyGramEvent, handler: MoneyGramEventHandler): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }

  private emit(event: MoneyGramEvent, rec: ReferenceRecord, detail?: string): void {
    const payload: MoneyGramEventPayload = { event, sessionId: rec.session.sessionId, referenceNumber: rec.session.referenceNumber, status: rec.status, detail };
    for (const h of this.handlers.get(event) ?? []) h(payload);
  }

  /** Checks a request against the limits; the DemoApi calls this too when it lists the pay options. */
  static check(req: { amountUsd: number; buyerState: string | null }, limits: MoneyGramLimitsInput): MoneyGramErrorCode | null {
    if (req.buyerState && limits.excludedStates.includes(req.buyerState.toUpperCase())) return 'STATE_EXCLUDED';
    if (req.amountUsd > limits.maxUsd) return 'ABOVE_LIMIT';
    if (req.amountUsd < limits.minUsd) return 'BELOW_LIMIT';
    return null;
  }

  async createSession(req: CashInSessionRequest): Promise<CashInSession> {
    const limits = req.limits ?? this.limits;
    const code = MoneyGramOnRamp.check(req, limits);
    if (code) throw new MoneyGramError(code, `${req.amountUsd} USD for a customer in ${req.buyerState ?? 'an unknown state'}: ${code}`);
    await this.runtime.call('moneyGram.createSession');
    this.seq += 1;
    const nowMs = this.now();
    const label = `${req.customerIdentifier}:${req.memo}:${req.amountUsd}:${this.seq}:${nowMs}`;
    const referenceNumber = MoneyGramOnRamp.referenceFrom(label);
    const sessionId = `mgs-${mockTxHash(label).slice(0, 12)}`;
    const expiresAt: ISODateTime = new Date(nowMs + limits.referenceTtlMinutes * 60_000).toISOString();
    const session: CashInSession = {
      sessionId,
      referenceNumber,
      amountUsd: Math.round(req.amountUsd * 100) / 100,
      feeUsd: req.feeUsd ?? this.feeUsd,
      expiresAt,
      widgetUrl: `${this.widgetBaseUrl}/${sessionId}?lang=${req.locale}`,
    };
    const rec: ReferenceRecord = { session, customerIdentifier: req.customerIdentifier, memo: req.memo, status: 'pending', createdAtMs: nowMs, detail: null, depositId: null };
    this.refs.set(referenceNumber, rec);
    this.emit('loaded', rec);
    this.emit('transaction_created', rec);
    return { ...session };
  }

  /** Eight digits, deterministic from the label, as the network prints them on the buyer's receipt. */
  static referenceFrom(label: string): string {
    const hex = mockTxHash(label).slice(0, 12);
    return String(parseInt(hex, 16) % 10 ** REFERENCE_DIGITS).padStart(REFERENCE_DIGITS, '0');
  }

  session(referenceNumber: string): CashInSession | undefined {
    const rec = this.refs.get(referenceNumber);
    return rec ? { ...rec.session } : undefined;
  }

  /**
   * Registers a reference this instance did not issue (a seeded pending payment) so the status
   * read, the webhook and the demo controls apply to it. A known reference is left untouched.
   */
  adopt(args: { referenceNumber: string; customerIdentifier: string; memo: string; amountUsd: number; feeUsd: number; expiresAt: ISODateTime; createdAt?: ISODateTime }): void {
    if (this.refs.has(args.referenceNumber)) return;
    const session: CashInSession = {
      sessionId: `mgs-${mockTxHash(`adopt:${args.referenceNumber}`).slice(0, 12)}`,
      referenceNumber: args.referenceNumber,
      amountUsd: args.amountUsd,
      feeUsd: args.feeUsd,
      expiresAt: args.expiresAt,
      widgetUrl: `${this.widgetBaseUrl}/adopted-${args.referenceNumber}`,
    };
    this.refs.set(args.referenceNumber, {
      session,
      customerIdentifier: args.customerIdentifier,
      memo: args.memo,
      status: 'pending',
      createdAtMs: args.createdAt ? Date.parse(args.createdAt) : this.now(),
      detail: null,
      depositId: null,
    });
  }

  /** The reference's status after applying the TTL (a pending reference past `expiresAt` is `quote_expired`). */
  async referenceStatus(referenceNumber: string): Promise<CashInReferenceStatus> {
    const rec = this.refs.get(referenceNumber);
    if (!rec) return 'error';
    this.expireIfDue(rec);
    if (rec.status === 'pending' && rec.depositId && this.standIn) {
      const st = await this.standIn.status(rec.depositId);
      if (st === 'completed') this.settle(rec, 'completed');
      else if (st === 'error') this.settle(rec, 'error', 'the stand-in anchor reported an error');
    }
    return rec.status;
  }

  private expireIfDue(rec: ReferenceRecord): void {
    if (rec.status === 'pending' && Date.parse(rec.session.expiresAt) <= this.now()) this.settle(rec, 'quote_expired');
  }

  private settle(rec: ReferenceRecord, status: Exclude<CashInReferenceStatus, 'pending'>, detail?: string): boolean {
    if (rec.status !== 'pending') return false;
    rec.status = status;
    rec.detail = detail ?? null;
    this.emit(status === 'completed' ? 'completed' : status === 'quote_expired' ? 'expired' : 'error', rec, detail);
    return true;
  }

  /**
   * Status webhook from the network. Idempotent: a repeated event id, or any event on a reference
   * that already left `pending`, changes nothing and returns `applied: false`.
   */
  async handleWebhook(payload: MoneyGramWebhook): Promise<{ applied: boolean; status: CashInReferenceStatus }> {
    const rec = this.refs.get(payload.referenceNumber);
    if (!rec) return { applied: false, status: 'error' };
    if (payload.eventId) {
      if (this.webhookIds.has(payload.eventId)) return { applied: false, status: rec.status };
      this.webhookIds.add(payload.eventId);
    }
    this.expireIfDue(rec);
    const status: Exclude<CashInReferenceStatus, 'pending'> = payload.status === 'completed' ? 'completed' : payload.status === 'expired' ? 'quote_expired' : 'error';
    const applied = this.settle(rec, status, payload.detail);
    return { applied, status: rec.status };
  }

  // ---------- Demo controls ----------

  /**
   * Mock: the network reports the cash-in. Stand-in: the anchor deposit runs for the buyer (the
   * test anchor's `completed` is what "paid at the counter" means on testnet). A reference that is
   * no longer pending is left alone, so nothing is ever credited twice or after an expiry.
   */
  async simulateCompleted(referenceNumber: string): Promise<void> {
    const rec = this.refs.get(referenceNumber);
    if (!rec) throw new Error(`MoneyGram: unknown reference ${referenceNumber}`);
    this.expireIfDue(rec);
    if (rec.status !== 'pending') return;
    if (this.driver === 'sep24-standin' && this.standIn) {
      const d = await this.standIn.initiateDeposit({ buyerId: rec.customerIdentifier, usdAmount: rec.session.amountUsd, memo: rec.memo });
      rec.depositId = d.depositId;
      if (d.status === 'completed') this.settle(rec, 'completed');
      else if (d.status === 'error') this.settle(rec, 'error', 'the stand-in anchor reported an error');
      return;
    }
    await this.runtime.call('moneyGram.completed', 0.5);
    this.settle(rec, 'completed');
  }

  async simulateExpired(referenceNumber: string): Promise<void> {
    const rec = this.refs.get(referenceNumber);
    if (!rec) throw new Error(`MoneyGram: unknown reference ${referenceNumber}`);
    this.settle(rec, 'quote_expired');
  }

  // ---------- OnRampProvider ----------

  /** As a plain rail: a session without a state check, reported pending until the network completes it. */
  async initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }): Promise<{ depositId: string; status: OnRampStatus }> {
    const s = await this.createSession({ customerIdentifier: args.buyerId, buyerState: null, amountUsd: args.usdAmount, memo: args.memo, locale: 'es' });
    return { depositId: s.referenceNumber, status: 'pending' };
  }

  async status(depositId: string): Promise<OnRampStatus> {
    const st = await this.referenceStatus(depositId);
    return st === 'completed' ? 'completed' : st === 'pending' ? 'pending' : 'error';
  }
}
