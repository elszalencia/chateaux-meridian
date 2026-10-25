// Business server for the Anchor Platform receive-side (SEP-31) deployment of the simulated
// Colombian receiving anchor. It implements the Callback API the platform calls (GET/PUT/DELETE
// /customer, GET /rate, POST /event) with `node:http` only, so the container needs no runtime
// dependencies. State is in memory on purpose: this is a demo counterparty and every restart starts
// with no customers or quotes. Incoming calls must carry the platform's HS256 JWT
// (CALLBACK_API_AUTH_TYPE=jwt), otherwise 401. Outgoing calls to the Platform API are JSON-RPC
// (`request_onchain_funds`, `notify_offchain_funds_sent`) signed with our own HS256 JWT; the v4
// Platform API has no PATCH /transactions. Status moves run only behind AUTO_COMPLETE=true, fed by
// POST /event when a broker exists or by polling GET /transactions, the docs' minimal integration.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ---------------------------------------------------------------- configuration

const env = (name: string, fallback?: string): string => {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
};

const PORT = Number(env('PORT', '8081'));
const CALLBACK_SECRET = env('SECRET_CALLBACK_API_AUTH_SECRET');
const PLATFORM_SECRET = env('SECRET_PLATFORM_API_AUTH_SECRET', '');
const PLATFORM_API_BASE_URL = env('PLATFORM_API_BASE_URL', 'http://platform-server:8085').replace(/\/+$/, '');
const AUTO_COMPLETE = env('AUTO_COMPLETE', 'false') === 'true';
const AUTO_COMPLETE_POLL_MS = Number(env('AUTO_COMPLETE_POLL_MS', '5000'));
const DISTRIBUTION_ACCOUNT = env('DISTRIBUTION_ACCOUNT', '');
const USDC_ASSET = env('USDC_ASSET', 'stellar:USDC:G...USDC_ISSUER');
const COP_ASSET = 'iso4217:COP';
// Demo spot, COP per USDC. The sender's curve (spot path by demo month) lives in
// services/src/adapters/mockRuntime.ts; this receiver quotes one flat rate so the demo stays legible.
const DEMO_SPOT_COP_PER_USDC = 3422.325;
const FIRM_QUOTE_TTL_MS = 15 * 60 * 1000;
const PLATFORM_JWT_TTL_SECONDS = 30;

const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));
};

// ---------------------------------------------------------------- JWT (HS256, node:crypto)

interface JwtClaims {
  iat?: number;
  exp?: number;
  aud?: string | string[];
}

const b64url = (input: string): string => Buffer.from(input).toString('base64url');
const hs256 = (data: string, secret: string): string =>
  createHmac('sha256', secret).update(data).digest('base64url');

// The platform signs with the raw UTF-8 bytes of SECRET_CALLBACK_API_AUTH_SECRET and sets iat, exp
// and aud=callback_api (jjwt may serialise aud as an array). Signature first, then exp, then aud.
function verifyJwt(token: string, secret: string, audience: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = Buffer.from(hs256(`${header}.${payload}`, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let alg: unknown;
  let claims: JwtClaims;
  try {
    alg = (JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg?: unknown }).alg;
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as JwtClaims;
  } catch {
    return null;
  }
  if (alg !== 'HS256') return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) return null;
  if (claims.aud !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience)) return null;
  }
  return claims;
}

function mintJwt(secret: string, audience: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now, exp: now + PLATFORM_JWT_TTL_SECONDS, aud: audience }));
  return `${header}.${payload}.${hs256(`${header}.${payload}`, secret)}`;
}

// ---------------------------------------------------------------- customers (SEP-12 semantics)

type CustomerStatus = 'ACCEPTED' | 'NEEDS_INFO';

interface FieldSpec {
  type: 'string';
  description: string;
  optional?: boolean;
}

interface Customer {
  id: string;
  type: string;
  account?: string;
  memo?: string;
  data: Record<string, string>;
}

interface CustomerResponse {
  id?: string;
  status: CustomerStatus;
  fields?: Record<string, FieldSpec>;
  provided_fields?: Record<string, FieldSpec & { status: 'ACCEPTED' }>;
  message?: string;
}

const SENDER_FIELDS: Record<string, FieldSpec> = {
  first_name: { type: 'string', description: "Sender's first name" },
  last_name: { type: 'string', description: "Sender's last name" },
  email_address: { type: 'string', description: "Sender's email address" },
};

const RECEIVER_FIELDS: Record<string, FieldSpec> = {
  first_name: { type: 'string', description: "Buyer's first name as registered with Fidudavivienda" },
  last_name: { type: 'string', description: "Buyer's last name as registered with Fidudavivienda" },
  bank_account_number: { type: 'string', description: 'Encargo fiduciario reference, e.g. FD-OLV-0142' },
  bank_name: { type: 'string', description: 'Fiduciary that holds the encargo; must be Fidudavivienda' },
};

const CONTROL_KEYS = new Set(['id', 'account', 'memo', 'memo_type', 'type', 'transaction_id', 'lang']);
const ENCARGO_REF = /^FD-[A-Z]{3}-\d{4}$/;

const customers = new Map<string, Customer>();

const fieldsFor = (type: string | undefined): Record<string, FieldSpec> =>
  type === 'sep31-receiver' ? RECEIVER_FIELDS : SENDER_FIELDS;

function findByAccount(account: string, memo: string | undefined, type: string | undefined): Customer | undefined {
  for (const customer of customers.values()) {
    const sameMemo = (customer.memo ?? '') === (memo ?? '');
    if (customer.account === account && sameMemo && (type === undefined || customer.type === type)) return customer;
  }
  return undefined;
}

function describe(customer: Customer): CustomerResponse {
  const missing: Record<string, FieldSpec> = {};
  const provided: Record<string, FieldSpec & { status: 'ACCEPTED' }> = {};
  for (const [name, spec] of Object.entries(fieldsFor(customer.type))) {
    if (customer.data[name]) provided[name] = { ...spec, status: 'ACCEPTED' };
    else missing[name] = spec;
  }
  const status: CustomerStatus = Object.keys(missing).length === 0 ? 'ACCEPTED' : 'NEEDS_INFO';
  const response: CustomerResponse = { id: customer.id, status };
  if (status === 'NEEDS_INFO') response.fields = missing;
  if (Object.keys(provided).length > 0) response.provided_fields = provided;
  return response;
}

// Receiver data must point at an encargo at Fidudavivienda; anything else is "Invalid data" (400).
function validateReceiver(data: Record<string, string>): string | null {
  if (data['bank_name'] && data['bank_name'].trim().toLowerCase() !== 'fidudavivienda') {
    return 'bank_name must be Fidudavivienda: the encargo fiduciario is held there';
  }
  if (data['bank_account_number'] && !ENCARGO_REF.test(data['bank_account_number'].trim())) {
    return 'bank_account_number must be an encargo reference such as FD-OLV-0142';
  }
  return null;
}

// ---------------------------------------------------------------- rates (SEP-38 via GET /rate)

interface Rate {
  id?: string;
  price: string;
  sell_amount: string;
  buy_amount: string;
  expires_at?: string;
  fee: { total: string; asset: string };
}

type RateResult = { status: 200; body: { rate: Rate } } | { status: 400 | 404; body: { error: string } };

const firmQuotes = new Map<string, Rate>();

const money = (value: number): string => value.toFixed(2);

// SEP-38 price is units of sell_asset per one unit of buy_asset. The requested amount is kept as
// given, the other side is rounded to the assets' two significant decimals, and the price is then
// recomputed from the two amounts so the platform's check sell ≈ price × buy (+ fee) holds exactly.
function buildRate(query: URLSearchParams): RateResult {
  const existingId = query.get('id');
  if (existingId) {
    const stored = firmQuotes.get(existingId);
    return stored ? { status: 200, body: { rate: stored } } : { status: 404, body: { error: 'quote not found' } };
  }
  const type = query.get('type');
  const sell = query.get('sell_asset');
  const buy = query.get('buy_asset');
  const sellAmountRaw = query.get('sell_amount');
  const buyAmountRaw = query.get('buy_amount');
  if (type !== 'indicative' && type !== 'firm') return { status: 400, body: { error: 'type must be indicative or firm' } };
  const usdcToCop = sell === USDC_ASSET && buy === COP_ASSET;
  const copToUsdc = sell === COP_ASSET && buy === USDC_ASSET;
  if (!usdcToCop && !copToUsdc) return { status: 400, body: { error: `unsupported pair ${sell} -> ${buy}` } };
  if ((sellAmountRaw === null) === (buyAmountRaw === null)) {
    return { status: 400, body: { error: 'exactly one of sell_amount or buy_amount is required' } };
  }
  const given = Number(sellAmountRaw ?? buyAmountRaw);
  if (!Number.isFinite(given) || given <= 0) return { status: 400, body: { error: 'amount must be a positive number' } };

  // COP per USDC when selling USDC, USDC per COP when selling COP.
  const copPerSell = usdcToCop ? DEMO_SPOT_COP_PER_USDC : 1 / DEMO_SPOT_COP_PER_USDC;
  const sellAmount = sellAmountRaw !== null ? given : Number(money(given / copPerSell));
  const buyAmount = buyAmountRaw !== null ? given : Number(money(given * copPerSell));
  if (sellAmount <= 0 || buyAmount <= 0) return { status: 400, body: { error: 'amount too small to quote' } };

  const rate: Rate = {
    price: (sellAmount / buyAmount).toFixed(12),
    sell_amount: money(sellAmount),
    buy_amount: money(buyAmount),
    fee: { total: '0', asset: sell },
  };
  if (type === 'firm') {
    const requested = Date.parse(query.get('expire_after') ?? '');
    const expiresAt = Math.max(Date.now() + FIRM_QUOTE_TTL_MS, Number.isFinite(requested) ? requested : 0);
    rate.id = `rate-${randomUUID()}`;
    rate.expires_at = new Date(expiresAt).toISOString();
    firmQuotes.set(rate.id, rate);
  }
  return { status: 200, body: { rate } };
}

// ---------------------------------------------------------------- Platform API (JSON-RPC)

interface Transaction {
  id: string;
  sep?: string | number;
  status?: string;
  transfer_received_at?: string | null;
}

interface PlatformEvent {
  id?: string;
  type?: string;
  timestamp?: string;
  payload?: { transaction?: Transaction };
}

const platformHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (PLATFORM_SECRET) headers['authorization'] = `Bearer ${mintJwt(PLATFORM_SECRET, 'platform_api')}`;
  return headers;
};

// The platform server answers JSON-RPC at its base URL with an array envelope.
async function rpc(method: string, params: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${PLATFORM_API_BASE_URL}/`, {
    method: 'POST',
    headers: platformHeaders(),
    body: JSON.stringify([{ jsonrpc: '2.0', id: randomUUID(), method, params }]),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status} ${text}`);
  const [first] = JSON.parse(text) as Array<{ error?: { message?: string } }>;
  if (first?.error) throw new Error(`${method}: ${first.error.message ?? 'rpc error'}`);
}

// A `none` deposit-info generator requires an id memo; derive a stable 60-bit one from the id.
const idMemoFor = (transactionId: string): string =>
  BigInt(`0x${createHash('sha256').update(transactionId).digest('hex').slice(0, 15)}`).toString();

const inFlight = new Set<string>();

// pending_receiver before the payment: ask the sender for funds (amounts come from the quote the
// platform stored at creation, so none are resent). pending_receiver after the payment: report the
// COP payout and complete with an ACH-style external id.
async function advance(txn: Transaction): Promise<void> {
  if (String(txn.sep) !== '31' || txn.status !== 'pending_receiver' || inFlight.has(txn.id)) return;
  inFlight.add(txn.id);
  try {
    if (!txn.transfer_received_at) {
      const params: Record<string, unknown> = { transaction_id: txn.id, message: 'Awaiting the USDC payment from the sending anchor' };
      if (DISTRIBUTION_ACCOUNT) {
        params['destination_account'] = DISTRIBUTION_ACCOUNT;
        params['memo'] = idMemoFor(txn.id);
        params['memo_type'] = 'id';
      }
      await rpc('request_onchain_funds', params);
      log('transaction moved to pending_sender', { id: txn.id, memo: params['memo'] ?? 'platform-generated' });
    } else {
      const externalId = `ACH-CO-${randomBytes(4).toString('hex').toUpperCase()}`;
      await rpc('notify_offchain_funds_sent', {
        transaction_id: txn.id,
        message: 'COP credited to the encargo fiduciario at Fidudavivienda',
        funds_sent_at: new Date().toISOString(),
        external_transaction_id: externalId,
      });
      log('transaction completed', { id: txn.id, external_transaction_id: externalId });
    }
  } catch (error) {
    log('platform rpc failed', { id: txn.id, error: error instanceof Error ? error.message : String(error) });
  } finally {
    inFlight.delete(txn.id);
  }
}

async function pollPendingReceiver(): Promise<void> {
  const url = `${PLATFORM_API_BASE_URL}/transactions?sep=31&statuses=pending_receiver&order_by=created_at&order=asc&page_size=50`;
  const response = await fetch(url, { headers: platformHeaders() });
  if (!response.ok) throw new Error(`GET /transactions: HTTP ${response.status}`);
  const { records = [] } = (await response.json()) as { records?: Transaction[] };
  await Promise.all(records.map((txn) => advance(txn)));
}

// ---------------------------------------------------------------- HTTP plumbing

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

function send(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text || '{}');
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getCustomer(query: URLSearchParams, res: ServerResponse): void {
  const id = query.get('id');
  const account = query.get('account');
  const type = query.get('type') ?? undefined;
  if (id) {
    const customer = customers.get(id);
    if (!customer) return send(res, 404, { error: 'customer not found' });
    return send(res, 200, describe(customer));
  }
  const existing = account ? findByAccount(account, query.get('memo') ?? undefined, type) : undefined;
  if (existing) return send(res, 200, describe(existing));
  send(res, 200, { status: 'NEEDS_INFO', fields: fieldsFor(type) } satisfies CustomerResponse);
}

function putCustomer(body: Record<string, unknown>, res: ServerResponse): void {
  const id = typeof body['id'] === 'string' ? body['id'] : undefined;
  const account = typeof body['account'] === 'string' ? body['account'] : undefined;
  const memo = typeof body['memo'] === 'string' ? body['memo'] : undefined;
  const type = typeof body['type'] === 'string' ? body['type'] : undefined;
  let customer = id ? customers.get(id) : account ? findByAccount(account, memo, type) : undefined;
  if (id && !customer) return send(res, 404, { error: 'customer not found' });
  if (!customer) {
    if (!account) return send(res, 400, { error: 'account (with optional memo) or id is required' });
    customer = { id: randomUUID(), type: type ?? 'sep31-sender', account, memo, data: {} };
  }
  const incoming: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!CONTROL_KEYS.has(key) && typeof value === 'string' && value.trim() !== '') incoming[key] = value.trim();
  }
  if (type) customer.type = type;
  if (customer.type === 'sep31-receiver') {
    const problem = validateReceiver(incoming);
    if (problem) return send(res, 400, { error: problem });
  }
  customer.data = { ...customer.data, ...incoming };
  customers.set(customer.id, customer);
  log('customer upserted', { id: customer.id, type: customer.type, status: describe(customer).status });
  send(res, 200, describe(customer));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  if (method === 'GET' && path === '/health') {
    return send(res, 200, { ok: true, service: 'Ancla receptora simulada (Colombia) · Anchor Platform', customers: customers.size });
  }
  const authorization = req.headers.authorization ?? '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (!token || !verifyJwt(token, CALLBACK_SECRET, 'callback_api')) {
    return send(res, 401, { error: 'missing or invalid callback JWT' });
  }
  if (method === 'GET' && path === '/customer') return getCustomer(url.searchParams, res);
  if (method === 'PUT' && path === '/customer') {
    if (!(req.headers['content-type'] ?? '').includes('application/json')) {
      return send(res, 400, { error: 'only application/json customer updates are supported (no binary fields)' });
    }
    const body = parseJson(await readBody(req));
    return body ? putCustomer(body, res) : send(res, 400, { error: 'invalid JSON body' });
  }
  if (method === 'DELETE' && path.startsWith('/customer/')) {
    const deleted = customers.delete(decodeURIComponent(path.slice('/customer/'.length)));
    return deleted ? send(res, 204) : send(res, 404, { error: 'customer not found' });
  }
  if (method === 'GET' && path === '/rate') {
    const result = buildRate(url.searchParams);
    log('rate quoted', { status: result.status, query: url.search });
    return send(res, result.status, result.body);
  }
  if (method === 'POST' && path === '/event') {
    const event = parseJson(await readBody(req)) as PlatformEvent | null;
    if (!event || typeof event.type !== 'string') return send(res, 400, { error: 'invalid event' });
    const txn = event.payload?.transaction;
    log('event received', { id: event.id, type: event.type, transaction: txn?.id, status: txn?.status });
    if (AUTO_COMPLETE && txn?.id) void advance(txn);
    return send(res, 200);
  }
  send(res, 404, { error: `no route for ${method} ${path}` });
}

// ---------------------------------------------------------------- start

const server = createServer((req, res) => {
  handle(req, res).catch((error: unknown) => {
    log('unhandled error', { error: error instanceof Error ? error.message : String(error) });
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  });
});

server.listen(PORT, () => {
  log('business server listening', { port: PORT, autoComplete: AUTO_COMPLETE, platformApi: PLATFORM_API_BASE_URL });
  if (AUTO_COMPLETE) {
    setInterval(() => {
      pollPendingReceiver().catch((error: unknown) => {
        log('poll failed', { error: error instanceof Error ? error.message : String(error) });
      });
    }, AUTO_COMPLETE_POLL_MS).unref();
  }
});
