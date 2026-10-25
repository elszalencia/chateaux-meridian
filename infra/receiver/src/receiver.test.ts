// Unit tests for the simulated receiving anchor. No network: Horizon is replaced by a stub signer
// loader, the stores live in a temp dir, and the status machine is driven by a fake payment and an
// explicit clock. Random keypairs keep the SEP-10 test independent from any configured secret.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { TESTNET_PASSPHRASE } from '../../../services/src/chain/env.ts';
import { usdToCoverCop } from '../../../services/src/lock/engine.ts';
import { HttpError, parseMultipart, type Req } from './http.ts';
import { signJwt, verifyJwt } from './jwt.ts';
import { buildChallenge, requireAuth, verifyChallenge, type Sep10Options } from './sep10.ts';
import { putCustomer } from './sep12.ts';
import { advance, applyPayment, createTransaction, paymentMatches, PENDING_RECEIVER_MS, PENDING_STELLAR_MS, SENDER_TIMEOUT_MS, type IncomingPayment } from './sep31.ts';
import { COP_ASSET, priceUsdcToCop, usdcAsset } from './sep38.ts';
import { openStores, type Sep31Transaction } from './store.ts';

const SECRET = 'test-jwt-secret';
const ISSUER = Keypair.random().publicKey();
const RECEIVER = Keypair.random().publicKey();
const dataDir = mkdtempSync(join(tmpdir(), 'receiver-test-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const fakeReq = (headers: Record<string, string> = {}): Req => ({ method: 'GET', path: '/', query: new URLSearchParams(), headers, body: {}, params: {} });

describe('jwt', () => {
  it('round-trips HS256 claims and rejects tampering and expiry', () => {
    const claims = { iss: 'http://localhost:8788/auth', sub: 'GABC', iat: 1000, exp: 2000, jti: 'abc' };
    const token = signJwt(claims, SECRET);
    expect(verifyJwt(token, SECRET, 1500)).toEqual(claims);
    expect(verifyJwt(token, SECRET, 2000)).toBeNull();
    expect(verifyJwt(token, 'other-secret', 1500)).toBeNull();
    const [h, p, s] = token.split('.') as [string, string, string];
    expect(verifyJwt(`${h}.${p}.${s.slice(0, -2)}xx`, SECRET, 1500)).toBeNull();
    expect(verifyJwt(`${h}.${Buffer.from('{"sub":"GEVIL","exp":9999}').toString('base64url')}.${s}`, SECRET, 1500)).toBeNull();
  });

  it('requireAuth reads account and memo from the subject', () => {
    const token = signJwt({ iss: 'x', sub: 'GABC:42', iat: 0, exp: Math.floor(Date.now() / 1000) + 60, jti: 'j' }, SECRET);
    expect(requireAuth(fakeReq({ authorization: `Bearer ${token}` }), SECRET)).toEqual({ sub: 'GABC:42', account: 'GABC', memo: '42' });
    expect(() => requireAuth(fakeReq(), SECRET)).toThrow(HttpError);
  });
});

describe('sep10', () => {
  const server = Keypair.random();
  const client = Keypair.random();
  const opts = (loaded: Awaited<ReturnType<Sep10Options['loadSigners']>>): Sep10Options => ({
    serverKeypair: server,
    homeDomain: 'localhost:8788',
    webAuthDomain: 'localhost:8788',
    networkPassphrase: TESTNET_PASSPHRASE,
    webAuthEndpoint: 'http://localhost:8788/auth',
    jwtSecret: SECRET,
    loadSigners: async () => loaded,
  });
  const sign = (xdr: string, ...keys: Keypair[]): string => {
    const tx = TransactionBuilder.fromXDR(xdr, TESTNET_PASSPHRASE);
    tx.sign(...keys);
    return tx.toXDR();
  };

  it('builds a challenge the client signs and verifies it against the master key when the account is not on the ledger', async () => {
    const { transaction, network_passphrase } = buildChallenge(opts(null), client.publicKey(), null, null);
    expect(network_passphrase).toBe(TESTNET_PASSPHRASE);
    const { token } = await verifyChallenge(opts(null), sign(transaction, client), 1_700_000_000);
    const claims = verifyJwt(token, SECRET, 1_700_000_001);
    expect(claims?.sub).toBe(client.publicKey());
    expect(claims?.iss).toBe('http://localhost:8788/auth');
    expect(claims?.exp).toBe(1_700_000_000 + 24 * 3600);
    expect(claims?.jti).toBe(Buffer.from(TransactionBuilder.fromXDR(transaction, TESTNET_PASSPHRASE).hash()).toString('hex'));
  });

  it('uses Horizon signers and the medium threshold when the account exists, and carries the memo into sub', async () => {
    const loaded = { signers: [{ key: client.publicKey(), weight: 1, type: 'ed25519_public_key' }], threshold: 1 };
    const { transaction } = buildChallenge(opts(loaded), client.publicKey(), '7', 'localhost:8788');
    const { token } = await verifyChallenge(opts(loaded), sign(transaction, client));
    expect(verifyJwt(token, SECRET)?.sub).toBe(`${client.publicKey()}:7`);
    const stranger = Keypair.random();
    await expect(verifyChallenge(opts(loaded), sign(transaction, stranger))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects an unsigned challenge, a foreign home domain and a bad account', async () => {
    const { transaction } = buildChallenge(opts(null), client.publicKey(), null, null);
    await expect(verifyChallenge(opts(null), transaction)).rejects.toMatchObject({ status: 401 });
    expect(() => buildChallenge(opts(null), client.publicKey(), null, 'evil.example')).toThrow(HttpError);
    expect(() => buildChallenge(opts(null), 'not-an-account', null, null)).toThrow(HttpError);
    expect(() => buildChallenge(opts(null), client.publicKey(), 'abc', null)).toThrow(HttpError);
  });
});

describe('sep38 quote math', () => {
  const rate = 3422.325;

  it('covers a COP target with the smallest whole-cent USDC amount', () => {
    const q = priceUsdcToCop(rate, { buy_amount: '12358167' });
    expect(q.buy_amount).toBe('12358167');
    expect(q.sell_amount).toBe(usdToCoverCop(12358167, rate).toFixed(2));
    const usd = Number(q.sell_amount);
    expect(usd * rate).toBeGreaterThanOrEqual(12358167);
    expect((usd - 0.01) * rate).toBeLessThan(12358167);
    expect(q.price).toBe((usd / 12358167).toFixed(10));
    expect(q.total_price).toBe(q.price);
  });

  it('turns a USDC amount into whole pesos and validates inputs', () => {
    const q = priceUsdcToCop(rate, { sell_amount: '1000' });
    expect(q.sell_amount).toBe('1000');
    expect(q.buy_amount).toBe('3422325');
    expect(() => priceUsdcToCop(rate, {})).toThrow(HttpError);
    expect(() => priceUsdcToCop(rate, { sell_amount: '1', buy_amount: '1' })).toThrow(HttpError);
    expect(() => priceUsdcToCop(rate, { sell_amount: '-5' })).toThrow(HttpError);
    expect(() => priceUsdcToCop(rate, { buy_amount: 'abc' })).toThrow(HttpError);
  });
});

describe('sep31 status machine', () => {
  const stores = openStores(join(dataDir, 'sep31'));
  const auth = { sub: RECEIVER, account: 'GSENDER', memo: null };
  const t0 = Date.parse('2026-06-17T12:00:00Z');

  const setup = (): { quoteId: string; senderId: string; receiverId: string } => {
    const quote = priceUsdcToCop(3422.325, { buy_amount: '12358167' });
    const quoteId = `q-${stores.quotes.size}`;
    stores.quotes.put({ id: quoteId, account: auth.account, sell_asset: usdcAsset(ISSUER), buy_asset: COP_ASSET, ...quote, expires_at: new Date(t0 + 600_000).toISOString(), created_at: new Date(t0).toISOString() });
    const sender = putCustomer(stores.customers, auth, { type: 'sep31-sender', memo: `s${quoteId}`, first_name: 'María', last_name: 'Gómez', email_address: 'maria@example.com' });
    const receiver = putCustomer(stores.customers, auth, { type: 'sep31-receiver', memo: `r${quoteId}`, first_name: 'María', last_name: 'Gómez', bank_account_number: 'FD-OLV-0142', bank_name: 'Fidudavivienda' });
    return { quoteId, senderId: (sender.json as { id: string }).id, receiverId: (receiver.json as { id: string }).id };
  };

  it('creates a pending_sender transaction from a quote and two accepted customers', () => {
    const { quoteId, senderId, receiverId } = setup();
    const amount = stores.quotes.get(quoteId)!.sell_amount;
    const res = createTransaction({ stores, auth, body: { amount, asset_code: 'USDC', destination_asset: COP_ASSET, quote_id: quoteId, sender_id: senderId, receiver_id: receiverId, funding_method: 'ACH' }, receiverAccount: RECEIVER, usdcIssuer: ISSUER, nowMs: t0 });
    expect(res.status).toBe(201);
    const body = res.json as { id: string; stellar_account_id: string; stellar_memo_type: string; stellar_memo: string };
    expect(body.stellar_account_id).toBe(RECEIVER);
    expect(body.stellar_memo_type).toBe('text');
    expect(body.stellar_memo.length).toBeLessThanOrEqual(28);
    const tx = stores.transactions.get(body.id)!;
    expect(tx).toMatchObject({ status: 'pending_sender', amount_in: amount, amount_in_asset: usdcAsset(ISSUER), amount_out: '12358167', amount_out_asset: COP_ASSET, amount_fee: '0', quote_id: quoteId, refunded: false });

    const payment = (overrides: Partial<IncomingPayment>): IncomingPayment => ({ type: 'payment', transaction_hash: 'ab'.repeat(32), to: RECEIVER, asset_code: 'USDC', asset_issuer: ISSUER, amount, memo: tx.stellar_memo, memo_type: 'text', ...overrides });
    expect(paymentMatches(tx, payment({ memo: 'someone-else' }), RECEIVER, ISSUER)).toBe(false);
    expect(paymentMatches(tx, payment({ amount: String(Number(amount) - 0.01) }), RECEIVER, ISSUER)).toBe(false);
    expect(paymentMatches(tx, payment({ asset_issuer: Keypair.random().publicKey() }), RECEIVER, ISSUER)).toBe(false);
    expect(paymentMatches(tx, payment({ amount: String(Number(amount) + 0.5) }), RECEIVER, ISSUER)).toBe(true);
    expect(paymentMatches(tx, payment({}), RECEIVER, ISSUER)).toBe(true);

    const t1 = t0 + 30_000;
    const paid = applyPayment(tx, payment({}), t1);
    expect(paid).toMatchObject({ status: 'pending_stellar', stellar_transaction_id: 'ab'.repeat(32) });
    expect(advance(paid, t1 + PENDING_STELLAR_MS - 1)).toBeNull();
    const receiverSide = advance(paid, t1 + PENDING_STELLAR_MS)!;
    expect(receiverSide.status).toBe('pending_receiver');
    expect(advance(receiverSide, t1 + PENDING_STELLAR_MS + PENDING_RECEIVER_MS - 1)).toBeNull();
    const done = advance(receiverSide, t1 + PENDING_STELLAR_MS + PENDING_RECEIVER_MS)!;
    expect(done.status).toBe('completed');
    expect(done.completed_at).toBe(new Date(t1 + PENDING_STELLAR_MS + PENDING_RECEIVER_MS).toISOString());
    expect(done.external_transaction_id).toMatch(/^ACH-CO-[0-9A-F]{8}$/);
    expect(advance(done, t1 + 10_000_000)).toBeNull();
    expect(paymentMatches(done, payment({}), RECEIVER, ISSUER)).toBe(false);
  });

  it('expires an unpaid transaction after 15 minutes and rejects bad requests with the SEP-31 error shapes', () => {
    const { quoteId, senderId, receiverId } = setup();
    const amount = stores.quotes.get(quoteId)!.sell_amount;
    const base = { amount, asset_code: 'USDC', quote_id: quoteId, sender_id: senderId, receiver_id: receiverId };
    const created = createTransaction({ stores, auth, body: base, receiverAccount: RECEIVER, usdcIssuer: ISSUER, nowMs: t0 });
    const tx = stores.transactions.get((created.json as { id: string }).id) as Sep31Transaction;
    expect(advance(tx, t0 + SENDER_TIMEOUT_MS - 1)).toBeNull();
    expect(advance(tx, t0 + SENDER_TIMEOUT_MS)?.status).toBe('expired');

    const attempt = (body: Record<string, unknown>, nowMs = t0) => {
      try {
        createTransaction({ stores, auth, body, receiverAccount: RECEIVER, usdcIssuer: ISSUER, nowMs });
        return null;
      } catch (e) {
        return e instanceof HttpError ? { status: e.status, ...e.body } : e;
      }
    };
    expect(attempt({ ...base, quote_id: undefined })).toMatchObject({ status: 400, error: 'transaction_info_needed' });
    expect(attempt({ ...base, amount: '1.00' })).toMatchObject({ status: 400 });
    expect(attempt(base, t0 + 600_000)).toMatchObject({ status: 400, error: expect.stringContaining('expired') });
    expect(attempt({ ...base, sender_id: receiverId })).toMatchObject({ status: 400, error: 'customer_info_needed', type: 'sep31-sender' });
    const incomplete = putCustomer(stores.customers, auth, { type: 'sep31-receiver', memo: 'incomplete', first_name: 'Sin', last_name: 'Encargo' });
    expect(attempt({ ...base, receiver_id: (incomplete.json as { id: string }).id })).toMatchObject({ status: 400, error: 'customer_info_needed', type: 'sep31-receiver' });
    expect(attempt({ ...base, sender_id: 'nope' })).toMatchObject({ status: 400, error: 'customer_info_needed', type: 'sep31-sender' });
  });
});

describe('multipart', () => {
  it('reads text fields and skips files', () => {
    const b = 'XyZ';
    const raw = [`--${b}`, 'Content-Disposition: form-data; name="first_name"', '', 'María', `--${b}`, 'Content-Disposition: form-data; name="photo_id_front"; filename="id.png"', 'Content-Type: image/png', '', 'PNG...', `--${b}--`, ''].join('\r\n');
    expect(parseMultipart(raw, b)).toEqual({ first_name: 'María' });
  });
});
