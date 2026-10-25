// Sep31OffRampProvider: the Colombian payout leg as a SEP-31 sending client. It discovers the
// receiving anchor from its stellar.toml (SEP-1), authenticates the sending account (SEP-10),
// registers the sender and the beneficiary's encargo fiduciario as customers (SEP-12), prices
// USDC → COP (SEP-38), creates the SEP-31 transaction and pays the anchor's account with the
// returned memo. The anchor is chosen by its home URL only: the simulated Colombian receiver
// (infra/receiver) and a Stellar Anchor Platform v4 (infra/anchor-platform) differ in shape, and both
// shapes are handled here:
//   - the receiver returns the payment destination and a text memo in the POST response; the Anchor
//     Platform returns only `{id}` and shows them on GET once the transaction is `pending_sender`,
//     with an id memo, so the client polls before paying;
//   - the Anchor Platform rejects a POST without `fields`, so an empty `{transaction: {}}` is sent
//     (the receiver ignores it; the fields themselves are deprecated and never used).
// The Stellar payment is an injectable seam (`sendPayment`); the default submits through Horizon.

import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  WebAuth,
} from '@stellar/stellar-sdk';
import type { ISODateTime } from '../domain/types';
import type { OffRampProvider, OffRampQuote, OffRampQuoteRequest, OffRampStatus } from './interfaces';
import { roundCop } from '../lock/engine';

export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

export type StellarMemoType = 'text' | 'id' | 'hash' | 'none';

export interface Sep31PaymentArgs {
  destination: string;
  /** Exact amount, at most 7 decimals. */
  amount: string;
  asset: { code: string; issuer: string };
  memo: { type: StellarMemoType; value: string | null };
}

export interface Sep31Customer {
  first_name: string;
  last_name: string;
  email_address?: string;
  [field: string]: string | undefined;
}

export interface Sep31OffRampOptions {
  /** Anchor home, e.g. `http://localhost:8788` (receiver) or `http://localhost:8080` (Anchor Platform). */
  homeUrl: string;
  /** Secret of the sending account that holds the USDC (payee_backend). */
  senderSecret: string;
  usdc: { code: string; issuer: string };
  networkPassphrase?: string;
  /** Horizon used by the default payment function. */
  horizonUrl?: string;
  /** The SEP-31 sender (`sep31-sender`). */
  sender: { first_name: string; last_name: string; email_address: string };
  /** Bank name of the receiver customer (default Fidudavivienda). */
  receiverBank?: string;
  /** Names on the receiver customer for an encargo ref (default: "Encargo" / the ref). */
  beneficiaryNames?: (beneficiaryRef: string) => { first_name: string; last_name: string };
  /** Demo clock offset in months, sent as X-Demo-Clock-Offset on SEP-38 calls. */
  clockOffset?: () => number;
  fetchFn?: typeof fetch;
  /** Per-request timeout, ms (default 20 s). */
  timeoutMs?: number;
  /** Polling interval for transaction status, ms (default 2 s). */
  pollIntervalMs?: number;
  /** How long to wait for `pending_sender` before paying, ms (default 60 s). */
  readyTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Sends the USDC payment; the default builds and submits it through Horizon. */
  sendPayment?: (args: Sep31PaymentArgs) => Promise<{ hash: string }>;
}

/** SEP-31 transaction record as returned by `GET /transactions/:id`. */
export interface Sep31Transaction {
  id: string;
  status: string;
  status_eta?: number | null;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
  amount_fee?: string;
  quote_id?: string;
  stellar_account_id?: string;
  stellar_memo_type?: string;
  stellar_memo?: string;
  started_at?: string;
  updated_at?: string;
  completed_at?: string | null;
  stellar_transaction_id?: string | null;
  external_transaction_id?: string | null;
  message?: string | null;
  [key: string]: unknown;
}

export interface Sep31PayResult {
  txId: string;
  stellarTxHash: string;
  status: OffRampStatus;
  /** Raw SEP-31 status right after paying. */
  sep31Status: string;
}

export class Sep31Error extends Error {
  readonly step: string;
  readonly httpStatus: number | null;
  readonly body: unknown;
  constructor(step: string, message: string, opts: { httpStatus?: number | null; body?: unknown; cause?: unknown } = {}) {
    super(`${step} failed: ${message}`, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'Sep31Error';
    this.step = step;
    this.httpStatus = opts.httpStatus ?? null;
    this.body = opts.body;
  }
}

interface AnchorInfo {
  signingKey: string;
  webAuthEndpoint: string;
  kycServer: string;
  quoteServer: string;
  directPaymentServer: string;
  networkPassphrase: string | null;
}

interface StoredQuote {
  sellAmount: string;
  buyAmount: string;
  expiresAt: string;
}

interface StoredPayment {
  quoteId: string;
  beneficiaryRef: string;
  memo: string;
  stellarTxHash: string | null;
  statuses: string[];
}

const FINAL = new Set(['completed', 'refunded', 'expired', 'error']);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const trimSlash = (u: string) => u.replace(/\/+$/, '');

/** Maps a SEP-31 status onto the provider status. */
export function mapSep31Status(status: string): OffRampStatus {
  if (status === 'completed') return 'completed';
  if (status === 'refunded') return 'refunded';
  if (status === 'expired' || status === 'error') return 'error';
  return 'pending';
}

/** Top-level `KEY = "value"` pairs of a stellar.toml (tables are skipped). */
export function parseStellarToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = /^([A-Z0-9_]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

/** A stable unsigned 63-bit id memo for a beneficiary ref (FNV-1a 64), so each encargo is its own customer. */
export function customerMemoFor(ref: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(ref)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (h & 0x7fffffffffffffffn).toString();
}

function base64ToHex(b64: string): string {
  const bin = atob(b64);
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

/** The Stellar memo for a SEP-31 memo type and value; hash memos arrive base64-encoded. */
export function buildMemo(memo: Sep31PaymentArgs['memo']): Memo {
  if (memo.type === 'none' || memo.value == null || memo.value === '') return Memo.none();
  if (memo.type === 'text') return Memo.text(memo.value);
  if (memo.type === 'id') return Memo.id(memo.value);
  const hex = /^[0-9a-fA-F]{64}$/.test(memo.value) ? memo.value : base64ToHex(memo.value);
  return Memo.hash(hex);
}

/** `exp` of a JWT in ms, or null when it cannot be read. */
function jwtExpiryMs(token: string): number | null {
  try {
    const part = token.split('.')[1] ?? '';
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Default payment: one classic payment with the anchor's memo, submitted through Horizon. */
export function horizonPayment(opts: { horizonUrl: string; networkPassphrase: string; senderSecret: string; timeoutMs: number }) {
  const server = new Horizon.Server(opts.horizonUrl, { allowHttp: opts.horizonUrl.startsWith('http://') });
  const keypair = Keypair.fromSecret(opts.senderSecret);
  return async (args: Sep31PaymentArgs): Promise<{ hash: string }> => {
    const account = await server.loadAccount(keypair.publicKey());
    const tx = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: opts.networkPassphrase })
      .addOperation(Operation.payment({ destination: args.destination, asset: new Asset(args.asset.code, args.asset.issuer), amount: args.amount }))
      .addMemo(buildMemo(args.memo))
      .setTimeout(Math.ceil(opts.timeoutMs / 1000) + 30)
      .build();
    tx.sign(keypair);
    try {
      const res = await server.submitTransaction(tx);
      return { hash: res.hash };
    } catch (e) {
      const codes = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data?.extras?.result_codes;
      throw new Error(codes ? `Horizon rejected the payment: ${JSON.stringify(codes)}` : messageOf(e));
    }
  };
}

export class Sep31OffRampProvider implements OffRampProvider {
  readonly name = 'Fidudavivienda vía ancla receptora (SEP-31, testnet)';
  readonly homeUrl: string;
  readonly senderPublic: string;
  private readonly keypair: Keypair;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly readyTimeoutMs: number;
  private readonly networkPassphrase: string;
  private readonly sendPayment: (args: Sep31PaymentArgs) => Promise<{ hash: string }>;
  private info: AnchorInfo | null = null;
  private jwt: { token: string; refreshAtMs: number } | null = null;
  private senderId: string | null = null;
  private readonly receiverIds = new Map<string, string>();
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly payments = new Map<string, StoredPayment>();

  constructor(private readonly opts: Sep31OffRampOptions) {
    this.homeUrl = trimSlash(opts.homeUrl);
    this.keypair = Keypair.fromSecret(opts.senderSecret);
    this.senderPublic = this.keypair.publicKey();
    this.fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 60_000;
    this.networkPassphrase = opts.networkPassphrase ?? TESTNET_PASSPHRASE;
    this.sendPayment =
      opts.sendPayment ??
      horizonPayment({ horizonUrl: opts.horizonUrl ?? TESTNET_HORIZON_URL, networkPassphrase: this.networkPassphrase, senderSecret: opts.senderSecret, timeoutMs: this.timeoutMs });
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  private get sellAsset(): string {
    return `stellar:${this.opts.usdc.code}:${this.opts.usdc.issuer}`;
  }

  // ---------- HTTP ----------

  private async http(step: string, method: string, url: string, init: { body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}): Promise<{ status: number; body: unknown; text: string }> {
    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { Accept: 'application/json', ...(init.headers ?? {}) };
      if (init.body !== undefined) headers['Content-Type'] = 'application/json';
      if (init.auth) headers.Authorization = `Bearer ${await this.token()}`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let res: Response;
      let text: string;
      try {
        res = await this.fetchFn(url, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: ctrl.signal });
        text = await res.text();
      } catch (e) {
        const why = ctrl.signal.aborted ? `no answer from ${url} within ${this.timeoutMs} ms` : `${method} ${url}: ${messageOf(e)}`;
        throw new Sep31Error(step, why, { cause: e });
      } finally {
        clearTimeout(timer);
      }
      // An expired or revoked token gets one fresh SEP-10 round.
      if (res.status === 401 && init.auth && attempt === 1) {
        this.jwt = null;
        continue;
      }
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON bodies (stellar.toml) stay as text */
      }
      if (!res.ok) throw this.errorFor(step, res.status, body);
      return { status: res.status, body, text };
    }
  }

  private errorFor(step: string, status: number, body: unknown): Sep31Error {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const error = typeof b.error === 'string' ? b.error : typeof body === 'string' && body ? body.slice(0, 300) : `HTTP ${status}`;
    let message = `HTTP ${status}: ${error}`;
    if (error === 'customer_info_needed') {
      message = `customer_info_needed: the anchor needs more SEP-12 information for customer type ${String(b.type ?? 'unknown')}`;
    } else if (error === 'transaction_info_needed') {
      const fields = b.fields ? ` (fields: ${Object.keys(b.fields as object).join(', ')})` : '';
      message = `transaction_info_needed: the anchor needs more transaction information${fields}${typeof b.message === 'string' ? `: ${b.message}` : ''}`;
    } else if (typeof b.message === 'string') {
      message += ` (${b.message})`;
    }
    return new Sep31Error(step, message, { httpStatus: status, body });
  }

  // ---------- SEP-1 ----------

  private async anchor(): Promise<AnchorInfo> {
    if (this.info) return this.info;
    const { text } = await this.http('SEP-1 stellar.toml', 'GET', `${this.homeUrl}/.well-known/stellar.toml`);
    const toml = parseStellarToml(text);
    const need = (key: string) => {
      const v = toml[key];
      if (!v) throw new Sep31Error('SEP-1 stellar.toml', `${key} is missing in ${this.homeUrl}/.well-known/stellar.toml`);
      return trimSlash(v);
    };
    const info: AnchorInfo = {
      signingKey: need('SIGNING_KEY'),
      webAuthEndpoint: need('WEB_AUTH_ENDPOINT'),
      kycServer: need('KYC_SERVER'),
      quoteServer: need('ANCHOR_QUOTE_SERVER'),
      directPaymentServer: need('DIRECT_PAYMENT_SERVER'),
      networkPassphrase: toml.NETWORK_PASSPHRASE ?? null,
    };
    if (info.networkPassphrase && info.networkPassphrase !== this.networkPassphrase) {
      throw new Sep31Error('SEP-1 stellar.toml', `anchor is on "${info.networkPassphrase}", the sender on "${this.networkPassphrase}"`);
    }
    this.info = info;
    return info;
  }

  // ---------- SEP-10 ----------

  private async token(): Promise<string> {
    if (this.jwt && Date.now() < this.jwt.refreshAtMs) return this.jwt.token;
    const info = await this.anchor();
    const step = 'SEP-10 auth';
    const homeDomain = new URL(this.homeUrl).host;
    const webAuthDomain = new URL(info.webAuthEndpoint).host;
    const q = new URLSearchParams({ account: this.senderPublic, home_domain: homeDomain });
    const { body } = await this.http(step, 'GET', `${info.webAuthEndpoint}?${q}`);
    const challenge = body as { transaction?: string; network_passphrase?: string };
    if (!challenge?.transaction) throw new Sep31Error(step, 'challenge response has no transaction');
    if (challenge.network_passphrase && challenge.network_passphrase !== this.networkPassphrase) {
      throw new Sep31Error(step, `challenge is for network "${challenge.network_passphrase}"`);
    }
    try {
      // Checks the server signature, the time bounds, the home and web auth domains and the shape.
      const read = WebAuth.readChallengeTx(challenge.transaction, info.signingKey, this.networkPassphrase, homeDomain, webAuthDomain);
      if (read.clientAccountID !== this.senderPublic) throw new Error(`challenge is for ${read.clientAccountID}`);
    } catch (e) {
      throw new Sep31Error(step, `invalid challenge: ${messageOf(e)}`, { cause: e });
    }
    const tx = TransactionBuilder.fromXDR(challenge.transaction, this.networkPassphrase);
    tx.sign(this.keypair);
    const posted = await this.http(step, 'POST', info.webAuthEndpoint, { body: { transaction: tx.toXDR() } });
    const token = (posted.body as { token?: string } | null)?.token;
    if (!token) throw new Sep31Error(step, 'no token in the response');
    const exp = jwtExpiryMs(token) ?? Date.now() + 15 * 60 * 1000;
    this.jwt = { token, refreshAtMs: exp - 60_000 };
    this.log(`SEP-10: token for ${this.senderPublic} valid until ${new Date(exp).toISOString()}`);
    return token;
  }

  // ---------- SEP-12 ----------

  private async existingCustomer(step: string, type: string, memo: string | null): Promise<string | null> {
    const info = await this.anchor();
    const q = new URLSearchParams({ account: this.senderPublic, type });
    if (memo) {
      q.set('memo', memo);
      q.set('memo_type', 'id');
    }
    try {
      const { body } = await this.http(step, 'GET', `${info.kycServer}/customer?${q}`, { auth: true });
      const c = body as { id?: string; status?: string } | null;
      return c?.id && c.status === 'ACCEPTED' ? c.id : null;
    } catch (e) {
      if (e instanceof Sep31Error && e.httpStatus === 404) return null;
      throw e;
    }
  }

  private async putCustomer(step: string, type: string, memo: string | null, fields: Record<string, string | undefined>): Promise<string> {
    const info = await this.anchor();
    const body: Record<string, string> = { account: this.senderPublic, type };
    if (memo) {
      body.memo = memo;
      body.memo_type = 'id';
    }
    for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') body[k] = v;
    const res = await this.http(step, 'PUT', `${info.kycServer}/customer`, { body, auth: true });
    const id = (res.body as { id?: string } | null)?.id;
    if (!id) throw new Sep31Error(step, 'no customer id in the response');
    return id;
  }

  private async senderCustomer(): Promise<string> {
    if (this.senderId) return this.senderId;
    const step = 'SEP-12 sender customer';
    const id = (await this.existingCustomer(step, 'sep31-sender', null)) ?? (await this.putCustomer(step, 'sep31-sender', null, this.opts.sender));
    this.senderId = id;
    this.log(`SEP-12: sender customer ${id}`);
    return id;
  }

  private async receiverCustomer(beneficiaryRef: string): Promise<string> {
    const cached = this.receiverIds.get(beneficiaryRef);
    if (cached) return cached;
    const step = 'SEP-12 receiver customer';
    const memo = customerMemoFor(beneficiaryRef);
    let id = await this.existingCustomer(step, 'sep31-receiver', memo);
    if (!id) {
      const names = this.opts.beneficiaryNames?.(beneficiaryRef) ?? { first_name: 'Encargo', last_name: beneficiaryRef };
      id = await this.putCustomer(step, 'sep31-receiver', memo, {
        ...names,
        bank_account_number: beneficiaryRef,
        bank_name: this.opts.receiverBank ?? 'Fidudavivienda',
      });
    }
    this.receiverIds.set(beneficiaryRef, id);
    this.log(`SEP-12: receiver customer ${id} for ${beneficiaryRef}`);
    return id;
  }

  // ---------- SEP-38 ----------

  async quote(req: OffRampQuoteRequest): Promise<OffRampQuote> {
    const step = 'SEP-38 quote';
    const info = await this.anchor();
    const byCop = req.copTarget != null;
    const body: Record<string, string> = { context: 'sep31', sell_asset: this.sellAsset, buy_asset: 'iso4217:COP' };
    if (byCop) body.buy_amount = String(roundCop(req.copTarget));
    else body.sell_amount = req.usdc;
    const headers: Record<string, string> = {};
    if (this.opts.clockOffset) headers['X-Demo-Clock-Offset'] = String(Math.trunc(this.opts.clockOffset()));
    const { body: res } = await this.http(step, 'POST', `${info.quoteServer}/quote`, { body, auth: true, headers });
    const q = res as { id?: string; expires_at?: string; sell_amount?: string; buy_amount?: string } | null;
    if (!q?.id || !q.sell_amount || !q.buy_amount || !q.expires_at) throw new Sep31Error(step, `incomplete quote: ${JSON.stringify(res)}`);
    const sell = Number(q.sell_amount);
    const buy = Number(q.buy_amount);
    if (!(sell > 0) || !(buy > 0)) throw new Sep31Error(step, `non-positive amounts in quote ${q.id}`);
    const copDelivered = roundCop(buy);
    if (byCop && copDelivered !== roundCop(req.copTarget)) {
      throw new Sep31Error(step, `quote ${q.id} delivers ${copDelivered} COP, not the ${roundCop(req.copTarget)} COP target`);
    }
    this.quotes.set(q.id, { sellAmount: q.sell_amount, buyAmount: q.buy_amount, expiresAt: q.expires_at });
    const usdc = sell.toFixed(7);
    this.log(`SEP-38: quote ${q.id} sells ${usdc} USDC for ${copDelivered} COP`);
    return { quoteId: q.id, rate: buy / sell, expiresAt: q.expires_at as ISODateTime, usdc, copDelivered };
  }

  // ---------- SEP-31 ----------

  async pay(args: { quoteId: string; usdc: string; beneficiaryRef: string; memo: string }): Promise<Sep31PayResult> {
    const info = await this.anchor();
    const quote = this.quotes.get(args.quoteId);
    if (quote && Math.abs(Number(quote.sellAmount) - Number(args.usdc)) > 1e-7) {
      throw new Sep31Error('SEP-31 transaction', `amount ${args.usdc} does not match quote ${args.quoteId} (${quote.sellAmount} USDC)`);
    }
    const [senderId, receiverId] = [await this.senderCustomer(), await this.receiverCustomer(args.beneficiaryRef)];
    const amount = quote?.sellAmount ?? args.usdc;
    const step = 'SEP-31 transaction';
    const { body } = await this.http(step, 'POST', `${info.directPaymentServer}/transactions`, {
      auth: true,
      body: {
        amount,
        asset_code: this.opts.usdc.code,
        asset_issuer: this.opts.usdc.issuer,
        destination_asset: 'iso4217:COP',
        quote_id: args.quoteId,
        sender_id: senderId,
        receiver_id: receiverId,
        funding_method: 'ACH',
        fields: { transaction: {} },
      },
    });
    const created = body as { id?: string; stellar_account_id?: string; stellar_memo_type?: string; stellar_memo?: string } | null;
    if (!created?.id) throw new Sep31Error(step, `no transaction id in the response: ${JSON.stringify(body)}`);
    const txId = created.id;
    const record: StoredPayment = { quoteId: args.quoteId, beneficiaryRef: args.beneficiaryRef, memo: args.memo, stellarTxHash: null, statuses: [] };
    this.payments.set(txId, record);
    this.log(`SEP-31: transaction ${txId} created`);

    let destination = created.stellar_account_id;
    let memoType = created.stellar_memo_type;
    let memoValue = created.stellar_memo;
    let amountIn = amount;
    if (!destination) {
      const ready = await this.waitForPendingSender(txId);
      destination = ready.stellar_account_id;
      memoType = ready.stellar_memo_type;
      memoValue = ready.stellar_memo;
      if (ready.amount_in) amountIn = ready.amount_in;
    }
    if (!destination) throw new Sep31Error(step, `transaction ${txId} has no stellar_account_id`);
    const type = (memoType ?? (memoValue ? 'text' : 'none')) as StellarMemoType;
    if (!['text', 'id', 'hash', 'none'].includes(type)) throw new Sep31Error(step, `unsupported memo type ${type}`);
    if (!/^\d+(\.\d{1,7})?$/.test(amountIn)) throw new Sep31Error(step, `amount_in ${amountIn} is not a Stellar amount`);

    let hash: string;
    try {
      ({ hash } = await this.sendPayment({ destination, amount: amountIn, asset: this.opts.usdc, memo: { type, value: memoValue ?? null } }));
    } catch (e) {
      throw new Sep31Error('Stellar payment', messageOf(e), { cause: e });
    }
    record.stellarTxHash = hash;
    this.log(`Stellar: paid ${amountIn} ${this.opts.usdc.code} to ${destination} (memo ${type} ${memoValue ?? ''}) in ${hash}`);
    const after = await this.fetchTransaction(txId);
    return { txId, stellarTxHash: hash, status: mapSep31Status(after.status), sep31Status: after.status };
  }

  /** The anchor's transaction record; also tracks the statuses seen. */
  async fetchTransaction(txId: string): Promise<Sep31Transaction> {
    const info = await this.anchor();
    const { body } = await this.http('SEP-31 transaction status', 'GET', `${info.directPaymentServer}/transactions/${encodeURIComponent(txId)}`, { auth: true });
    const tx = (body as { transaction?: Sep31Transaction } | null)?.transaction;
    if (!tx?.status) throw new Sep31Error('SEP-31 transaction status', `no transaction in the response for ${txId}`);
    const rec = this.payments.get(txId);
    if (rec && rec.statuses[rec.statuses.length - 1] !== tx.status) rec.statuses.push(tx.status);
    return tx;
  }

  private async waitForPendingSender(txId: string): Promise<Sep31Transaction> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const tx = await this.fetchTransaction(txId);
      if (tx.status === 'pending_sender' && tx.stellar_account_id) return tx;
      if (FINAL.has(tx.status)) throw new Sep31Error('SEP-31 transaction', `transaction ${txId} became ${tx.status} before payment${tx.message ? `: ${tx.message}` : ''}`);
      if (Date.now() >= deadline) throw new Sep31Error('SEP-31 transaction', `transaction ${txId} still ${tx.status} after ${this.readyTimeoutMs} ms, no payment destination yet`);
      await sleep(this.pollIntervalMs);
    }
  }

  async status(txId: string): Promise<OffRampStatus> {
    return mapSep31Status((await this.fetchTransaction(txId)).status);
  }

  /** Polls until completed, refunded, expired or error and returns the final record. */
  async waitFor(txId: string, timeoutMs = 120_000): Promise<Sep31Transaction> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tx = await this.fetchTransaction(txId);
      if (FINAL.has(tx.status)) return tx;
      if (Date.now() >= deadline) throw new Sep31Error('SEP-31 transaction status', `transaction ${txId} still ${tx.status} after ${timeoutMs} ms`);
      await sleep(this.pollIntervalMs);
    }
  }

  /** SEP-31 statuses seen for a transaction paid by this provider, in order. */
  statusesSeen(txId: string): string[] {
    return [...(this.payments.get(txId)?.statuses ?? [])];
  }

  /** Stellar payment hash of a transaction paid by this provider. */
  stellarTxHashOf(txId: string): string | null {
    return this.payments.get(txId)?.stellarTxHash ?? null;
  }
}
