// Sep31OffRampProvider against a fake anchor (injected fetch) and a fake Stellar payment: both the
// simulated receiver shape (destination in the POST) and the Anchor Platform v4 shape (POST returns
// only {id}, GET shows pending_sender with an id memo). No network.

import { describe, expect, it } from 'vitest';
import { Keypair, Memo, WebAuth } from '@stellar/stellar-sdk';
import { usdToCoverCop } from '../lock/engine';
import { buildMemo, customerMemoFor, mapSep31Status, Sep31OffRampProvider, type Sep31PaymentArgs } from './sep31OffRamp';

const PASS = 'Test SDF Network ; September 2015';
const HOME = 'http://anchor.test';
const ISSUER = Keypair.random().publicKey();
const RATE = 4000;

type Shape = 'receiver' | 'platform';

function fakeAnchor(shape: Shape) {
  const server = Keypair.random();
  const anchorAccount = Keypair.random().publicKey();
  const calls: { method: string; path: string; headers: Record<string, string>; body: any }[] = [];
  const customers = new Map<string, { id: string; type: string; memo: string | null; fields: Record<string, string> }>();
  const quotes = new Map<string, { sell_amount: string; buy_amount: string }>();
  const txs = new Map<string, { id: string; status: string; amount_in: string; amount_out: string; polls: number; [k: string]: unknown }>();
  const state = { authGets: 0, receiverIncomplete: false, nextStatus: null as string | null };
  let seq = 0;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchFn = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, headers, body });
    const authed = (headers.Authorization ?? '').startsWith('Bearer h.');
    const p = url.pathname;
    if (p === '/.well-known/stellar.toml') {
      return new Response(
        [`NETWORK_PASSPHRASE = "${PASS}"`, `SIGNING_KEY = "${server.publicKey()}"`, `WEB_AUTH_ENDPOINT = "${HOME}/auth"`, `KYC_SERVER = "${HOME}/sep12"`, `ANCHOR_QUOTE_SERVER = "${HOME}/sep38"`, `DIRECT_PAYMENT_SERVER = "${HOME}/sep31"`, '', '[[CURRENCIES]]', 'code = "USDC"'].join('\n'),
        { status: 200 },
      );
    }
    if (p === '/auth' && method === 'GET') {
      state.authGets += 1;
      const transaction = WebAuth.buildChallengeTx(server, url.searchParams.get('account')!, 'anchor.test', 300, PASS, 'anchor.test');
      return json(200, { transaction, network_passphrase: PASS });
    }
    if (p === '/auth' && method === 'POST') {
      const read = WebAuth.readChallengeTx(body.transaction, server.publicKey(), PASS, 'anchor.test', 'anchor.test');
      WebAuth.verifyChallengeTxSigners(body.transaction, server.publicKey(), PASS, [read.clientAccountID], 'anchor.test', 'anchor.test');
      const payload = Buffer.from(JSON.stringify({ sub: read.clientAccountID, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      return json(200, { token: `h.${payload}.s` });
    }
    if (!authed) return json(401, { error: 'unauthorized' });
    if (p === '/sep12/customer' && method === 'GET') {
      const memo = url.searchParams.get('memo');
      const c = [...customers.values()].find((x) => x.type === url.searchParams.get('type') && x.memo === memo);
      if (!c) return json(404, { error: 'customer not found' });
      return json(200, { id: c.id, status: 'ACCEPTED' });
    }
    if (p === '/sep12/customer' && method === 'PUT') {
      const { account: _a, type, memo, memo_type: _m, ...fields } = body;
      const id = `cust-${++seq}`;
      customers.set(id, { id, type, memo: memo ?? null, fields });
      return json(202, { id });
    }
    if (p === '/sep38/quote' && method === 'POST') {
      const offset = Number(headers['X-Demo-Clock-Offset'] ?? 0);
      const rate = RATE + offset * 10;
      const sell = body.buy_amount ? usdToCoverCop(Number(body.buy_amount), rate).toFixed(2) : body.sell_amount;
      const buy = body.buy_amount ? body.buy_amount : String(Math.round(Number(sell) * rate));
      const id = `quote-${++seq}`;
      quotes.set(id, { sell_amount: sell, buy_amount: buy });
      return json(201, { id, expires_at: '2030-01-01T00:00:00.000Z', sell_amount: sell, buy_amount: buy, price: '0', total_price: '0' });
    }
    if (p === '/sep31/transactions' && method === 'POST') {
      if (shape === 'platform' && !body.fields) return json(400, { error: "'fields' field cannot be empty" });
      if (state.receiverIncomplete) return json(400, { error: 'customer_info_needed', type: 'sep31-receiver' });
      const q = quotes.get(body.quote_id)!;
      const id = `tx-${++seq}`;
      if (shape === 'receiver') {
        txs.set(id, { id, status: 'pending_sender', amount_in: q.sell_amount, amount_out: q.buy_amount, polls: 0, stellar_account_id: anchorAccount, stellar_memo_type: 'text', stellar_memo: 'abc123' });
        return json(201, { id, stellar_account_id: anchorAccount, stellar_memo_type: 'text', stellar_memo: 'abc123' });
      }
      txs.set(id, { id, status: 'pending_receiver', amount_in: q.sell_amount, amount_out: q.buy_amount, polls: 0 });
      return json(201, { id });
    }
    const m = /^\/sep31\/transactions\/(.+)$/.exec(p);
    if (m && method === 'GET') {
      const tx = txs.get(m[1]!);
      if (!tx) return json(404, { error: 'not found' });
      tx.polls += 1;
      if (shape === 'platform' && tx.status === 'pending_receiver' && tx.polls >= 2) {
        Object.assign(tx, { status: 'pending_sender', stellar_account_id: anchorAccount, stellar_memo_type: 'id', stellar_memo: '123456789' });
      }
      if (state.nextStatus && tx.polls >= 3) tx.status = state.nextStatus;
      const { polls: _p, ...rest } = tx;
      return json(200, { transaction: rest });
    }
    return json(404, { error: `no route ${method} ${p}` });
  }) as typeof fetch;

  return { fetchFn, calls, state, txs, anchorAccount, customers };
}

function provider(shape: Shape, extra: Partial<ConstructorParameters<typeof Sep31OffRampProvider>[0]> = {}) {
  const anchor = fakeAnchor(shape);
  const payments: Sep31PaymentArgs[] = [];
  const p = new Sep31OffRampProvider({
    homeUrl: HOME,
    senderSecret: Keypair.random().secret(),
    usdc: { code: 'USDC', issuer: ISSUER },
    sender: { first_name: 'Chateaux', last_name: 'Operaciones', email_address: 'ops@example.com' },
    fetchFn: anchor.fetchFn,
    pollIntervalMs: 1,
    sendPayment: async (args) => {
      payments.push(args);
      // The anchor sees the payment and moves the transaction forward.
      for (const tx of anchor.txs.values()) if (tx.status === 'pending_sender') tx.status = 'pending_stellar';
      return { hash: 'f'.repeat(64) };
    },
    ...extra,
  });
  return { p, anchor, payments };
}

describe('Sep31OffRampProvider', () => {
  it('quotes by sell_amount', async () => {
    const { p, anchor } = provider('receiver');
    const q = await p.quote({ usdc: '1000.0000000' });
    expect(q.usdc).toBe('1000.0000000');
    expect(q.copDelivered).toBe(4_000_000);
    expect(q.rate).toBe(4000);
    const body = anchor.calls.find((c) => c.path === '/sep38/quote')!.body;
    expect(body).toMatchObject({ context: 'sep31', sell_asset: `stellar:USDC:${ISSUER}`, buy_asset: 'iso4217:COP', sell_amount: '1000.0000000' });
    expect(body.buy_amount).toBeUndefined();
  });

  it('quotes by COP target and delivers exactly that COP, with the demo clock header', async () => {
    const { p, anchor } = provider('receiver', { clockOffset: () => 2 });
    const q = await p.quote({ copTarget: 4_093_125 });
    expect(q.copDelivered).toBe(4_093_125);
    expect(q.usdc).toBe(usdToCoverCop(4_093_125, 4020).toFixed(7));
    const call = anchor.calls.find((c) => c.path === '/sep38/quote')!;
    expect(call.body.buy_amount).toBe('4093125');
    expect(call.headers['X-Demo-Clock-Offset']).toBe('2');
  });

  it('pays with the receiver shape (destination and text memo in the POST)', async () => {
    const { p, anchor, payments } = provider('receiver');
    const q = await p.quote({ copTarget: 4_093_125 });
    const r = await p.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'FD-OLV-0142', memo: 'M4' });
    expect(r.txId).toMatch(/^tx-/);
    expect(r.stellarTxHash).toBe('f'.repeat(64));
    expect(r.status).toBe('pending');
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ destination: anchor.anchorAccount, amount: (Number(q.usdc)).toFixed(2), memo: { type: 'text', value: 'abc123' } });
    const post = anchor.calls.find((c) => c.path === '/sep31/transactions')!.body;
    expect(post).toMatchObject({ asset_code: 'USDC', asset_issuer: ISSUER, destination_asset: 'iso4217:COP', quote_id: q.quoteId, funding_method: 'ACH' });
    const receiver = [...anchor.customers.values()].find((c) => c.type === 'sep31-receiver')!;
    expect(receiver.fields).toMatchObject({ bank_account_number: 'FD-OLV-0142', bank_name: 'Fidudavivienda' });
    expect(receiver.memo).toBe(customerMemoFor('FD-OLV-0142'));
  });

  it('pays with the Anchor Platform shape (POST returns only id, then pending_sender with an id memo)', async () => {
    const { p, anchor, payments } = provider('platform');
    const q = await p.quote({ usdc: '50.00' });
    const r = await p.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'FD-OLV-0142', memo: 'M5' });
    expect(payments[0]).toMatchObject({ destination: anchor.anchorAccount, amount: '50.00', memo: { type: 'id', value: '123456789' } });
    expect(p.statusesSeen(r.txId)).toEqual(['pending_receiver', 'pending_sender', 'pending_stellar']);
    anchor.state.nextStatus = 'completed';
    const final = await p.waitFor(r.txId, 5_000);
    expect(final.status).toBe('completed');
    expect(await p.status(r.txId)).toBe('completed');
  });

  it('reuses customers and the SEP-10 token across payments', async () => {
    const { p, anchor } = provider('receiver');
    for (const ref of ['FD-OLV-0142', 'FD-OLV-0142', 'FD-OLV-0007']) {
      const q = await p.quote({ usdc: '10' });
      await p.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: ref, memo: 'x' });
    }
    expect(anchor.state.authGets).toBe(1);
    const puts = anchor.calls.filter((c) => c.path === '/sep12/customer' && c.method === 'PUT');
    expect(puts.map((c) => c.body.type)).toEqual(['sep31-sender', 'sep31-receiver', 'sep31-receiver']);
  });

  it('reports customer_info_needed clearly', async () => {
    const { p, anchor, payments } = provider('receiver');
    const q = await p.quote({ usdc: '10' });
    anchor.state.receiverIncomplete = true;
    await expect(p.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'FD-OLV-0142', memo: 'x' })).rejects.toThrow(
      /SEP-31 transaction failed: customer_info_needed.*sep31-receiver/,
    );
    expect(payments).toHaveLength(0);
  });

  it('maps refunded and expired', async () => {
    for (const [final, mapped] of [
      ['refunded', 'refunded'],
      ['expired', 'error'],
      ['error', 'error'],
    ] as const) {
      const { p, anchor } = provider('receiver');
      const q = await p.quote({ usdc: '10' });
      const r = await p.pay({ quoteId: q.quoteId, usdc: q.usdc, beneficiaryRef: 'FD-OLV-0142', memo: 'x' });
      anchor.state.nextStatus = final;
      expect((await p.waitFor(r.txId, 5_000)).status).toBe(final);
      expect(await p.status(r.txId)).toBe(mapped);
    }
    expect(mapSep31Status('pending_receiver')).toBe('pending');
  });

  it('names the SEP step on HTTP errors and timeouts', async () => {
    const failing = (async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 })) as typeof fetch;
    const { p } = provider('receiver', { fetchFn: failing });
    await expect(p.quote({ usdc: '1' })).rejects.toThrow(/SEP-1 stellar.toml failed: HTTP 500: boom/);
    const hanging = ((_u: unknown, init: any) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const { p: slow } = provider('receiver', { fetchFn: hanging, timeoutMs: 20 });
    await expect(slow.quote({ usdc: '1' })).rejects.toThrow(/SEP-1 stellar.toml failed: no answer/);
  });

  it('builds text, id and hash memos', () => {
    expect(buildMemo({ type: 'text', value: 'abc' }).value).toBe('abc');
    expect(buildMemo({ type: 'id', value: '42' }).value).toBe('42');
    const raw = Buffer.alloc(32, 7);
    const hashMemo = buildMemo({ type: 'hash', value: raw.toString('base64') });
    expect(Buffer.from(hashMemo.value as Buffer).equals(raw)).toBe(true);
    expect(buildMemo({ type: 'none', value: null }).type).toBe(Memo.none().type);
  });
});
