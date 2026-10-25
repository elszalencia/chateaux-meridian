// Sep24OnRampProvider without network: a fake anchor client stands in for SEP-10/SEP-24 and a fake
// fetch for the anchor's business server.

import { describe, expect, it } from 'vitest';
import { Sep24OnRampProvider, jwtExpiryMs, mapSep24Status, type AnchorAuth, type Sep24AnchorClient, type Sep24Transaction } from './sep24OnRamp';

const ACCOUNT = 'GBUYERTESTACCOUNT';

class FakeAnchor implements Sep24AnchorClient {
  authCalls = 0;
  deposits: { amount: string; assetCode: string }[] = [];
  /** Statuses returned by successive polls; the last one repeats. */
  constructor(private readonly statuses: string[] = ['pending_user_transfer_start', 'pending_anchor', 'completed']) {}
  private polls = new Map<string, number>();

  async authenticate(_secret: string): Promise<AnchorAuth> {
    this.authCalls += 1;
    return { token: `jwt-${this.authCalls}`, account: ACCOUNT, expiresAtMs: Date.now() + 3_600_000 };
  }

  async deposit(_auth: AnchorAuth, req: { assetCode: string; amount: string }): Promise<{ id: string; url: string }> {
    this.deposits.push(req);
    const id = `tx-${this.deposits.length}`;
    return { id, url: `https://ui.example?transaction_id=${id}&token=itok-${id}` };
  }

  async getTransaction(_auth: AnchorAuth, id: string): Promise<Sep24Transaction> {
    const n = this.polls.get(id) ?? 0;
    this.polls.set(id, n + 1);
    const status = this.statuses[Math.min(n, this.statuses.length - 1)]!;
    const amount = this.deposits[Number(id.split('-')[1]) - 1]!.amount;
    return {
      id,
      status,
      amount_in: amount,
      amount_out: String(Number(amount) * 0.9),
      stellar_transaction_id: status === 'completed' ? `hash-${id}` : null,
    };
  }
}

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: unknown;
}

function fakeBusiness() {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('Authorization'), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const id = calls.length;
    if (url.endsWith('/start')) return new Response(JSON.stringify({ sessionId: `session-${id}` }), { status: 200 });
    if (url.endsWith('/transaction')) return new Response(JSON.stringify({ status: 'incomplete' }), { status: 200 });
    if (url.endsWith('/submit')) return new Response(JSON.stringify({ sessionId: 'x' }), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function provider(anchor: Sep24AnchorClient, fetchFn: typeof fetch, extra: Partial<ConstructorParameters<typeof Sep24OnRampProvider>[0]> = {}) {
  return new Sep24OnRampProvider({
    buyerSecret: () => 'STEST',
    anchorClient: anchor,
    fetchFn,
    pollIntervalMs: 1,
    businessServerUrl: 'https://biz.example',
    ...extra,
  });
}

describe('Sep24OnRampProvider', () => {
  it('runs SEP-10, SEP-24 and the business server to completed', async () => {
    const anchor = new FakeAnchor();
    const biz = fakeBusiness();
    const p = provider(anchor, biz.fetchFn);
    const r = await p.initiateDeposit({ buyerId: 'buyer-maria', usdAmount: 5, memo: 'plan-maria M4' });

    expect(r.status).toBe('completed');
    expect(r.depositId).toBe('sep24:buyer-maria:tx-1');
    expect(r.sep24Id).toBe('tx-1');
    expect(r.amountIn).toBe('5');
    expect(r.amountOut).toBe('4.5');
    expect(r.stellarTransactionId).toBe('hash-tx-1');
    expect(r.anchor).toBe('testanchor.stellar.org');
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);

    expect(biz.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://biz.example/start',
      'GET https://biz.example/transaction',
      'POST https://biz.example/submit',
    ]);
    expect(biz.calls[0]!.auth).toBe('Bearer itok-tx-1');
    expect(biz.calls[1]!.auth).toBe('Bearer session-1');
    expect(biz.calls[2]!.auth).toBe('Bearer session-1');
    expect(biz.calls[2]!.body).toMatchObject({ amount: '5', email: expect.stringContaining('@') });

    expect(await p.status(r.depositId)).toBe('completed');
  });

  it('caps the deposit at maxDepositUsd', async () => {
    const anchor = new FakeAnchor();
    const p = provider(anchor, fakeBusiness().fetchFn);
    const r = await p.initiateDeposit({ buyerId: 'buyer-maria', usdAmount: 1188.37, memo: 'm' });
    expect(anchor.deposits[0]!.amount).toBe('10');
    expect(r.requestedUsd).toBe(1188.37);
    expect(r.depositedUsd).toBe(10);

    const p2 = provider(anchor, fakeBusiness().fetchFn, { maxDepositUsd: 7.5 });
    await p2.initiateDeposit({ buyerId: 'buyer-maria', usdAmount: 100, memo: 'm' });
    expect(anchor.deposits[1]!.amount).toBe('7.5');
  });

  it('rejects amounts below the anchor minimum', async () => {
    const p = provider(new FakeAnchor(), fakeBusiness().fetchFn);
    await expect(p.initiateDeposit({ buyerId: 'b', usdAmount: 0.5, memo: 'm' })).rejects.toThrow(/below the anchor minimum/);
  });

  it('maps an anchor error status to error', async () => {
    const p = provider(new FakeAnchor(['pending_anchor', 'error']), fakeBusiness().fetchFn);
    const r = await p.initiateDeposit({ buyerId: 'buyer-andres', usdAmount: 3, memo: 'm' });
    expect(r.status).toBe('error');
    expect(r.stellarTransactionId).toBeNull();
    expect(await p.status(r.depositId)).toBe('error');
  });

  it('returns pending on timeout and keeps asking the anchor in status()', async () => {
    const anchor = new FakeAnchor(['pending_anchor', 'pending_anchor', 'pending_anchor', 'completed']);
    const p = provider(anchor, fakeBusiness().fetchFn, { timeoutMs: 15, pollIntervalMs: 10 });
    const r = await p.initiateDeposit({ buyerId: 'buyer-camila', usdAmount: 5, memo: 'm' });
    expect(r.status).toBe('pending');
    expect(r.anchorStatus).toBe('pending_anchor');
    let s = await p.status(r.depositId);
    while (s === 'pending') s = await p.status(r.depositId);
    expect(s).toBe('completed');
    expect(p.deposit(r.depositId)?.stellarTransactionId).toBe('hash-tx-1');
  });

  it('resubmits the form once when the transaction stays incomplete', async () => {
    const anchor = new FakeAnchor(['incomplete', 'incomplete', 'incomplete', 'pending_anchor', 'completed']);
    const biz = fakeBusiness();
    const p = provider(anchor, biz.fetchFn, { resubmitAfterMs: 0 });
    const r = await p.initiateDeposit({ buyerId: 'buyer-maria', usdAmount: 5, memo: 'm' });
    expect(r.status).toBe('completed');
    const submits = biz.calls.filter((c) => c.url.endsWith('/submit'));
    expect(submits).toHaveLength(2);
    expect(submits[1]!.auth).toBe(submits[0]!.auth);
  });

  it('reuses the SEP-10 token across deposits', async () => {
    const anchor = new FakeAnchor();
    const p = provider(anchor, fakeBusiness().fetchFn);
    await p.initiateDeposit({ buyerId: 'buyer-maria', usdAmount: 2, memo: 'a' });
    await p.initiateDeposit({ buyerId: 'buyer-maria', usdAmount: 3, memo: 'b' });
    expect(anchor.authCalls).toBe(1);
  });

  it('names the step when the business server fails', async () => {
    const fetchFn = (async () => new Response('{"msg":"Invalid or expired session"}', { status: 401 })) as typeof fetch;
    const p = provider(new FakeAnchor(), fetchFn);
    await expect(p.initiateDeposit({ buyerId: 'b', usdAmount: 5, memo: 'm' })).rejects.toThrow(/SEP-24 business POST \/start returned HTTP 401/);
  });

  it('maps statuses and reads JWT expiry', () => {
    expect(mapSep24Status('completed')).toBe('completed');
    expect(mapSep24Status('refunded')).toBe('error');
    expect(mapSep24Status('pending_trust')).toBe('pending');
    const payload = btoa(JSON.stringify({ exp: 1_800_000_000 })).replace(/=+$/, '');
    expect(jwtExpiryMs(`h.${payload}.s`)).toBe(1_800_000_000_000);
    expect(jwtExpiryMs('garbage')).toBeNull();
  });
});
