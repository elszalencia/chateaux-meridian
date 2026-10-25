// Sep24OnRampProvider: the buyer's USD deposit through a real SEP-24 anchor on testnet (the SDF test
// anchor by default). Flow per deposit: SEP-10 auth for the buyer's account (JWT cached per
// account), SEP-24 interactive deposit, then the anchor's interactive form is driven headlessly
// over HTTP against its business server (`/start` → `/transaction` → `/submit`), and the SEP-24
// transaction is polled until `completed`. The anchor then pays Circle testnet USDC to the account,
// which must already trust that asset (see `ensureAnchorUsdcTrustline`).
//
// The test anchor caps a deposit at 10 USDC, so the provider deposits min(usdAmount, maxDepositUsd)
// as proof that the dollars entered through an anchor; the caller mints the full installment in the
// platform test asset separately.
//
// SEP-1/10/24 calls go through @stellar/typescript-wallet-sdk behind the `Sep24AnchorClient` seam;
// the business-server calls use `fetchFn`. Tests replace both.

import { Asset, type Keypair } from '@stellar/stellar-sdk';
import type { OnRampProvider, OnRampStatus } from './interfaces';
import { ensureTrustlines } from '../chain/deploy';
import type { Submitter, TxResult } from '../chain/submit';

export const CIRCLE_TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const CIRCLE_TESTNET_USDC = new Asset('USDC', CIRCLE_TESTNET_USDC_ISSUER);
export const SDF_TEST_ANCHOR_DOMAIN = 'testanchor.stellar.org';
/** Business server behind the test anchor's interactive UI (anchor-ref-ui-testanchor.stellar.org). */
export const SDF_TEST_ANCHOR_BUSINESS_URL = 'https://anchor-reference-server-testanchor.stellar.org';

/** Gives every holder the Circle testnet USDC trustline the anchor pays into; `payer` pays the fee. */
export async function ensureAnchorUsdcTrustline(submitter: Submitter, payer: Keypair, holders: Keypair[]): Promise<{ created: string[]; tx: TxResult<void> | null }> {
  return ensureTrustlines(submitter, payer, holders, CIRCLE_TESTNET_USDC);
}

export interface AnchorAuth {
  token: string;
  account: string;
  expiresAtMs: number;
  /** The client's own token object (the wallet SDK's AuthToken), passed back on later calls. */
  handle?: unknown;
}

/** The subset of a SEP-24 transaction record this provider reads. */
export interface Sep24Transaction {
  id: string;
  status: string;
  amount_in?: string | null;
  amount_out?: string | null;
  stellar_transaction_id?: string | null;
  message?: string | null;
}

/** SEP-1/10/24 client calls. The default implementation uses the wallet SDK. */
export interface Sep24AnchorClient {
  authenticate(secret: string): Promise<AnchorAuth>;
  deposit(auth: AnchorAuth, req: { assetCode: string; amount: string; lang: string }): Promise<{ id: string; url: string }>;
  getTransaction(auth: AnchorAuth, id: string): Promise<Sep24Transaction>;
}

export interface Sep24Customer {
  name: string;
  surname: string;
  email: string;
}

export interface Sep24OnRampOptions {
  homeDomain?: string;
  /** Secret key of the buyer's Stellar account; never logged. */
  buyerSecret: (buyerId: string) => string;
  assetCode?: 'USDC';
  /** Anchor cap per deposit (the test anchor allows 1 to 10). */
  maxDepositUsd?: number;
  minDepositUsd?: number;
  /** Total budget for one deposit, from SEP-10 to `completed`. */
  timeoutMs?: number;
  /** Per HTTP request. */
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Resubmit the interactive form once if the transaction is still `incomplete` after this long. */
  resubmitAfterMs?: number;
  businessServerUrl?: string;
  lang?: string;
  fetchFn?: typeof fetch;
  anchorClient?: Sep24AnchorClient;
  log?: (msg: string) => void;
  customer?: (buyerId: string) => Sep24Customer;
}

export interface Sep24DepositResult {
  /** `sep24:<buyerId>:<sep24Id>`, so `status` can re-query the anchor without local state. */
  depositId: string;
  status: OnRampStatus;
  sep24Id: string;
  anchorStatus: string;
  anchor: string;
  account: string;
  requestedUsd: number;
  depositedUsd: number;
  amountIn: string | null;
  amountOut: string | null;
  /** Hash of the anchor's payment to the account, once completed. */
  stellarTransactionId: string | null;
  elapsedMs: number;
  memo: string;
}

const MAX_RECORDS = 200;
const TOKEN_MARGIN_MS = 60_000;
const ERROR_STATUSES = new Set(['error', 'expired', 'refunded', 'no_market', 'too_small', 'too_large']);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function mapSep24Status(s: string): OnRampStatus {
  if (s === 'completed') return 'completed';
  if (ERROR_STATUSES.has(s)) return 'error';
  return 'pending';
}

function parseDepositId(depositId: string): { buyerId: string; sep24Id: string } | null {
  const m = /^sep24:(.+):([^:]+)$/.exec(depositId);
  return m ? { buyerId: m[1]!, sep24Id: m[2]! } : null;
}

/** `exp` of a JWT in ms, or null when it cannot be read. */
export function jwtExpiryMs(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function withTimeout<T>(label: string, ms: number, run: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: no answer after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Error text of a wallet SDK / axios failure, including the anchor's response body when present. */
function sdkErrorText(e: unknown): string {
  const err = e as { message?: string; response?: { status?: number; data?: unknown }; cause?: unknown };
  const res = err?.response ?? (err?.cause as { response?: { status?: number; data?: unknown } } | undefined)?.response;
  const body = res?.data !== undefined ? ` ${JSON.stringify(res.data).slice(0, 300)}` : '';
  return `${messageOf(e)}${res?.status ? ` (HTTP ${res.status})` : ''}${body}`;
}

type WalletSdkModule = typeof import('@stellar/typescript-wallet-sdk');
type WalletSdkParts = Pick<WalletSdkModule, 'Wallet' | 'StellarConfiguration' | 'ApplicationConfiguration' | 'SigningKeypair'> & {
  walletSdk: Pick<WalletSdkModule['walletSdk'], 'DefaultClient'>;
};

let walletSdkPromise: Promise<WalletSdkParts> | null = null;

/**
 * Loads the wallet SDK lazily. Two workarounds for 5.1.0 on Node: its bundled jwa/jws code reads
 * `buffer.SlowBuffer`, which Node 25 removed, so the bundle crashes on load unless it is restored;
 * and the CommonJS bundle's named exports are not visible to every ESM loader.
 */
function loadWalletSdk(): Promise<WalletSdkParts> {
  walletSdkPromise ??= (async () => {
    const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
    if (proc?.versions?.node) {
      const spec = 'node:buffer';
      const nodeBuffer = (await import(/* @vite-ignore */ spec)) as { default?: Record<string, unknown> };
      const b = nodeBuffer.default;
      if (b && !b.SlowBuffer) b.SlowBuffer = b.Buffer;
    }
    const mod = (await import('@stellar/typescript-wallet-sdk')) as unknown as Record<string, unknown>;
    // Where the named exports land depends on the loader: on `mod` (bundlers), on `mod.default`
    // (plain Node ESM) or on neither (tsx, where `default` is the bundle's own `{ walletSdk }`).
    const layers = [mod, mod.default as Record<string, unknown> | undefined].filter(Boolean) as Record<string, unknown>[];
    const pick = (name: string) => {
      for (const layer of layers) if (layer[name] !== undefined) return layer[name];
      for (const layer of layers) {
        const ns = layer.walletSdk as Record<string, unknown> | undefined;
        if (ns?.[name] !== undefined) return ns[name];
      }
      throw new Error(`wallet SDK: export ${name} not found`);
    };
    return {
      Wallet: pick('Wallet'),
      StellarConfiguration: pick('StellarConfiguration'),
      ApplicationConfiguration: pick('ApplicationConfiguration'),
      SigningKeypair: pick('SigningKeypair'),
      walletSdk: { DefaultClient: pick('DefaultClient') },
    } as unknown as WalletSdkParts;
  })();
  return walletSdkPromise;
}

/** Sep24AnchorClient over @stellar/typescript-wallet-sdk (testnet). */
export class WalletSdkAnchorClient implements Sep24AnchorClient {
  private anchorPromise: Promise<ReturnType<InstanceType<WalletSdkModule['Wallet']>['anchor']>> | null = null;

  constructor(
    private readonly homeDomain: string,
    private readonly requestTimeoutMs = 20_000,
  ) {}

  private anchor() {
    this.anchorPromise ??= loadWalletSdk().then((sdk) => {
      // A dedicated axios instance with a request timeout; `create` on the SDK's client keeps its headers.
      const client = sdk.walletSdk.DefaultClient.create({ timeout: this.requestTimeoutMs });
      const wallet = new sdk.Wallet({
        stellarConfiguration: sdk.StellarConfiguration.TestNet(),
        applicationConfiguration: new sdk.ApplicationConfiguration(undefined, client),
      });
      return wallet.anchor({ homeDomain: this.homeDomain });
    });
    return this.anchorPromise;
  }

  async authenticate(secret: string): Promise<AnchorAuth> {
    const sdk = await loadWalletSdk();
    const anchor = await this.anchor();
    const accountKp = sdk.SigningKeypair.fromSecret(secret);
    try {
      const auth = await withTimeout('SEP-10', this.requestTimeoutMs * 3, (async () => (await anchor.sep10()).authenticate({ accountKp }))());
      // AuthToken.expiresAt is typed string but holds the JWT `exp` in seconds; read the JWT instead.
      const expiresAtMs = jwtExpiryMs(auth.token) ?? Date.now() + 5 * 60_000;
      return { token: auth.token, account: accountKp.publicKey, expiresAtMs, handle: auth };
    } catch (e) {
      throw new Error(`SEP-10 auth with ${this.homeDomain} failed: ${sdkErrorText(e)}`, { cause: e });
    }
  }

  async deposit(auth: AnchorAuth, req: { assetCode: string; amount: string; lang: string }): Promise<{ id: string; url: string }> {
    const anchor = await this.anchor();
    try {
      // 5.1.0 posts the interactive request as JSON, which the test anchor accepts (it rejects a
      // urlencoded body), so no direct fetch fallback is needed.
      const res = await withTimeout(
        'SEP-24 deposit',
        this.requestTimeoutMs * 2,
        anchor.sep24().deposit({
          assetCode: req.assetCode,
          authToken: auth.handle as Parameters<ReturnType<typeof anchor.sep24>['deposit']>[0]['authToken'],
          lang: req.lang,
          extraFields: { amount: req.amount },
        }),
      );
      if (!res?.id || !res?.url) throw new Error(`unexpected response ${JSON.stringify(res).slice(0, 200)}`);
      return { id: res.id, url: res.url };
    } catch (e) {
      throw new Error(`SEP-24 interactive deposit at ${this.homeDomain} failed: ${sdkErrorText(e)}`, { cause: e });
    }
  }

  async getTransaction(auth: AnchorAuth, id: string): Promise<Sep24Transaction> {
    const anchor = await this.anchor();
    try {
      const tx = await withTimeout(
        'SEP-24 transaction',
        this.requestTimeoutMs,
        anchor.sep24().getTransactionBy({ authToken: auth.handle as Parameters<ReturnType<typeof anchor.sep24>['getTransactionBy']>[0]['authToken'], id }),
      );
      return tx as unknown as Sep24Transaction;
    } catch (e) {
      throw new Error(`SEP-24 GET /transaction ${id} failed: ${sdkErrorText(e)}`, { cause: e });
    }
  }
}

export class Sep24OnRampProvider implements OnRampProvider {
  readonly name = 'Depósito ACH vía ancla (SEP-24, testnet)';
  private readonly homeDomain: string;
  private readonly assetCode: string;
  private readonly maxDepositUsd: number;
  private readonly minDepositUsd: number;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly resubmitAfterMs: number;
  private readonly businessUrl: string;
  private readonly lang: string;
  private readonly fetchFn: typeof fetch;
  private readonly client: Sep24AnchorClient;
  private readonly log: (msg: string) => void;
  private readonly customer: (buyerId: string) => Sep24Customer;
  private readonly tokens = new Map<string, Promise<AnchorAuth>>();
  private readonly records = new Map<string, Sep24DepositResult>();

  constructor(private readonly opts: Sep24OnRampOptions) {
    this.homeDomain = opts.homeDomain ?? SDF_TEST_ANCHOR_DOMAIN;
    this.assetCode = opts.assetCode ?? 'USDC';
    this.maxDepositUsd = opts.maxDepositUsd ?? 10;
    this.minDepositUsd = opts.minDepositUsd ?? 1;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.resubmitAfterMs = opts.resubmitAfterMs ?? 20_000;
    this.businessUrl = (opts.businessServerUrl ?? SDF_TEST_ANCHOR_BUSINESS_URL).replace(/\/$/, '');
    this.lang = opts.lang ?? 'en';
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.client = opts.anchorClient ?? new WalletSdkAnchorClient(this.homeDomain, this.requestTimeoutMs);
    this.log = opts.log ?? (() => {});
    this.customer = opts.customer ?? ((buyerId) => ({ name: 'Comprador', surname: buyerId.replace(/[^A-Za-z0-9]/g, ''), email: `${buyerId.replace(/[^A-Za-z0-9.-]/g, '')}@example.com` }));
  }

  /**
   * Deposits min(usdAmount, maxDepositUsd) and waits for `completed`. Failures before the anchor has
   * a transaction (auth, interactive request, business server) throw. Once the form is submitted,
   * an anchor error status returns `error`, and running out of `timeoutMs` returns `pending`: the
   * deposit may still complete, and `status(depositId)` keeps asking the anchor.
   */
  async initiateDeposit(args: { buyerId: string; usdAmount: number; memo: string }): Promise<Sep24DepositResult> {
    const t0 = Date.now();
    const deadline = t0 + this.timeoutMs;
    if (!(args.usdAmount > 0)) throw new Error(`SEP-24 deposit: invalid amount ${args.usdAmount}`);
    const depositedUsd = Math.floor(Math.min(args.usdAmount, this.maxDepositUsd) * 100) / 100;
    if (depositedUsd < this.minDepositUsd) throw new Error(`SEP-24 deposit: ${depositedUsd} USD is below the anchor minimum of ${this.minDepositUsd}`);
    const amount = depositedUsd.toFixed(2).replace(/\.?0+$/, '');

    const auth = await this.auth(args.buyerId);
    this.log(`SEP-10 ok for ${auth.account}`);
    const dep = await this.client.deposit(auth, { assetCode: this.assetCode, amount, lang: this.lang });
    this.log(`SEP-24 deposit ${dep.id} opened for ${amount} ${this.assetCode}`);
    const session = await this.completeInteractive(dep, args.buyerId, amount);
    let submittedAt = Date.now();
    let resubmitted = false;
    this.log(`SEP-24 ${dep.id}: interactive form submitted`);

    const record: Sep24DepositResult = {
      depositId: `sep24:${args.buyerId}:${dep.id}`,
      status: 'pending',
      sep24Id: dep.id,
      anchorStatus: 'incomplete',
      anchor: this.homeDomain,
      account: auth.account,
      requestedUsd: args.usdAmount,
      depositedUsd,
      amountIn: null,
      amountOut: null,
      stellarTransactionId: null,
      elapsedMs: 0,
      memo: args.memo,
    };
    this.remember(record);

    let lastStatus = '';
    while (true) {
      try {
        this.apply(record, await this.client.getTransaction(await this.auth(args.buyerId), dep.id));
      } catch (e) {
        this.log(`SEP-24 ${dep.id}: poll failed, retrying (${messageOf(e)})`);
      }
      if (record.anchorStatus !== lastStatus) {
        lastStatus = record.anchorStatus;
        this.log(`SEP-24 ${dep.id}: ${lastStatus}`);
      }
      record.elapsedMs = Date.now() - t0;
      // Seen once live: /submit answered 200 but the transaction stayed `incomplete`. One resubmit
      // on the same session recovers that case; a failure here is only logged.
      if (record.anchorStatus === 'incomplete' && !resubmitted && Date.now() - submittedAt > this.resubmitAfterMs) {
        resubmitted = true;
        submittedAt = Date.now();
        try {
          await this.business('POST /submit (retry)', '/submit', session.sessionId, session.body);
          this.log(`SEP-24 ${dep.id}: still incomplete, form submitted again`);
        } catch (e) {
          this.log(`SEP-24 ${dep.id}: resubmit failed (${messageOf(e)})`);
        }
      }
      if (record.status !== 'pending' || Date.now() + this.pollIntervalMs > deadline) break;
      await sleep(this.pollIntervalMs);
    }
    if (record.status === 'pending') this.log(`SEP-24 ${dep.id}: still ${record.anchorStatus} after ${this.timeoutMs} ms`);
    return { ...record };
  }

  async status(depositId: string): Promise<OnRampStatus> {
    const known = this.records.get(depositId);
    if (known && known.status !== 'pending') return known.status;
    const parsed = parseDepositId(depositId);
    if (!parsed) return known?.status ?? 'error';
    const tx = await this.client.getTransaction(await this.auth(parsed.buyerId), parsed.sep24Id);
    if (known) {
      this.apply(known, tx);
      return known.status;
    }
    return mapSep24Status(tx.status);
  }

  /** The last known record of a deposit made by this instance. */
  deposit(depositId: string): Sep24DepositResult | undefined {
    const r = this.records.get(depositId);
    return r ? { ...r } : undefined;
  }

  private apply(record: Sep24DepositResult, tx: Sep24Transaction): void {
    record.anchorStatus = tx.status;
    record.status = mapSep24Status(tx.status);
    record.amountIn = tx.amount_in ?? record.amountIn;
    record.amountOut = tx.amount_out ?? record.amountOut;
    record.stellarTransactionId = tx.stellar_transaction_id ?? record.stellarTransactionId;
  }

  private remember(record: Sep24DepositResult): void {
    this.records.set(record.depositId, record);
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  /** SEP-10 JWT for the buyer's account, reused until a minute before it expires. */
  private async auth(buyerId: string): Promise<AnchorAuth> {
    const secret = this.opts.buyerSecret(buyerId);
    const cached = this.tokens.get(secret);
    if (cached) {
      try {
        const auth = await cached;
        if (auth.expiresAtMs - Date.now() > TOKEN_MARGIN_MS) return auth;
      } catch {
        // A failed attempt is retried below.
      }
    }
    const fresh = this.client.authenticate(secret);
    this.tokens.set(secret, fresh);
    try {
      return await fresh;
    } catch (e) {
      this.tokens.delete(secret);
      throw e;
    }
  }

  /** Drives the anchor's interactive page over HTTP, as its web UI does. */
  private async completeInteractive(dep: { id: string; url: string }, buyerId: string, amount: string): Promise<{ sessionId: string; body: unknown }> {
    let interactiveToken: string | null = null;
    try {
      interactiveToken = new URL(dep.url).searchParams.get('token');
    } catch {
      // Reported below.
    }
    if (!interactiveToken) throw new Error(`SEP-24 interactive URL for ${dep.id} has no token parameter`);

    const start = await this.business<{ sessionId?: string }>('POST /start', '/start', interactiveToken);
    if (!start.sessionId) throw new Error(`SEP-24 business POST /start for ${dep.id}: no sessionId in the answer`);
    // The session id, not the interactive token, is the bearer for /transaction and /submit.
    const tx = await this.business<{ id?: string; status?: string }>('GET /transaction', '/transaction', start.sessionId);
    if (tx.id && tx.id !== dep.id) throw new Error(`SEP-24 business GET /transaction: session is for ${tx.id}, expected ${dep.id}`);
    if (tx.status && tx.status !== 'incomplete') this.log(`SEP-24 ${dep.id}: business server reports ${tx.status} before submit`);
    const body = { amount, ...this.customer(buyerId) };
    await this.business('POST /submit', '/submit', start.sessionId, body);
    return { sessionId: start.sessionId, body };
  }

  private async business<T>(step: string, path: string, bearer: string, body?: unknown): Promise<T> {
    const label = `SEP-24 business ${step}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.businessUrl}${path}`, {
        method: step.startsWith('GET') ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${bearer}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new Error(`${label} failed: ${messageOf(e)}`, { cause: e });
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`${label} returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    try {
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      throw new Error(`${label} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }
}
