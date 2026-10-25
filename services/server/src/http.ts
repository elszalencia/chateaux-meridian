// HTTP surface of the testnet server, on node:http with no framework.
//
//   POST /api/<method>       body {"args": [...]} → 200 {"result": ...} or 4xx/5xx {"error": {code, message}}
//                            `pay` and `payAhead` answer as NDJSON: {"progress": step} lines, then the
//                            {"result"} or {"error"} line, so the UI shows the three steps as they happen.
//   GET  /health, /api/health  mode, contract, needsReset, plan checks, indexer, jobs, rails
//   GET  /jobs               registered jobs and their last runs
//   POST /jobs/<name>/run    manual trigger; answers with the run
//   GET  /indexer            indexer stats; ?plan=<chain plan id> lists that plan's events
//   GET  /rails              recent SEP-24 deposits and SEP-31 payouts
//
// Values are JSON with bigints as strings. The server listens on localhost only; Vite proxies
// /api to it in testnet mode, so the browser never needs a key or a CORS exception.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ApiError, type ChateauxApi, type PayStep } from '../../src/index';
import type { TestnetService } from './service';

/** The ChateauxApi methods the browser may call. New API methods are added here. */
export const API_METHODS = [
  'getDemoState',
  'listBuyers',
  'listPlans',
  'getPlan',
  'getReceipts',
  'getSpot',
  'quoteLock',
  'acceptLock',
  'pay',
  'payAhead',
  'getUnitSummaries',
  'getReconciliation',
  'getHedgeBook',
  'bookStrip',
  'setPassThrough',
  'advanceClock',
  'reset',
  'setErrorMode',
  'listOffices',
  'getPayOptions',
  'requestCashReference',
  'renewCashReference',
  'completeCashReference',
  'getPayment',
  'listPayments',
  'searchBuyers',
  'takeCounterPayment',
  'getShiftTotal',
  'sendReceiptMessage',
  'listPlanRows',
  'listSellers',
  'getSeller',
  'setSellerVerification',
  'changeSellerPayoutAccount',
  'raiseCnrAlert',
  'listPayouts',
  'retryPayout',
  'listOutbox',
  'runAdverseAction',
] as const satisfies readonly (keyof ChateauxApi)[];

const STREAMING = new Set<string>(['pay', 'payAhead', 'completeCashReference', 'takeCounterPayment']);
const MAX_BODY = 1_000_000;

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json(body));
}

function errorBody(e: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (e instanceof ApiError) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'PROVIDER' ? 502 : 409;
    return { status, body: { error: { code: e.code, message: e.message } } };
  }
  return { status: 500, body: { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } } };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new ApiError('NOT_FOUND', 'request body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function callApi(svc: TestnetService, method: string, args: unknown[], onProgress?: (s: PayStep) => void): Promise<unknown> {
  // pay, payAhead, getReceipts and reset go through the service (indexed receipts, reset flag).
  switch (method) {
    case 'pay':
      return svc.pay(String(args[0]), Number(args[1]), onProgress);
    case 'payAhead':
      return svc.payAhead(String(args[0]), onProgress);
    case 'completeCashReference':
      return svc.api.completeCashReference(String(args[0]), onProgress);
    case 'takeCounterPayment':
      return svc.api.takeCounterPayment(args[0] as Parameters<ChateauxApi['takeCounterPayment']>[0], onProgress);
    case 'getReceipts':
      return svc.getReceipts(String(args[0]));
    case 'reset':
      return svc.reset();
    default: {
      const api = svc.api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
      return api[method]!.apply(svc.api, args);
    }
  }
}

async function handleApi(svc: TestnetService, method: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!(API_METHODS as readonly string[]).includes(method)) {
    send(res, 404, { error: { code: 'NOT_FOUND', message: `unknown API method ${method}` } });
    return;
  }
  const body = (await readBody(req)) as { args?: unknown[] };
  const args = Array.isArray(body.args) ? body.args : [];
  if (!STREAMING.has(method)) {
    try {
      send(res, 200, { result: await callApi(svc, method, args) });
    } catch (e) {
      const { status, body: b } = errorBody(e);
      send(res, status, b);
    }
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  try {
    const result = await callApi(svc, method, args, (step) => res.write(`${json({ progress: step })}\n`));
    res.end(`${json({ result })}\n`);
  } catch (e) {
    res.end(`${json(errorBody(e).body)}\n`);
  }
}

async function route(svc: TestnetService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  if (method === 'GET' && (p === '/health' || p === '/api/health')) {
    if (url.searchParams.get('check') === '1') await svc.checkPlans();
    return send(res, 200, svc.health());
  }
  const api = /^\/api\/([A-Za-z]+)$/.exec(p);
  if (api && method === 'POST') return handleApi(svc, api[1]!, req, res);
  if (method === 'GET' && p === '/jobs') return send(res, 200, { jobs: svc.jobs.status() });
  const job = /^\/jobs\/([a-z0-9-]+)\/run$/.exec(p);
  if (job && method === 'POST') {
    try {
      return send(res, 200, { run: await svc.jobs.run(job[1]!, 'manual') });
    } catch (e) {
      return send(res, 404, { error: { code: 'NOT_FOUND', message: e instanceof Error ? e.message : String(e) } });
    }
  }
  if (method === 'GET' && p === '/indexer') {
    const plan = url.searchParams.get('plan');
    return send(res, 200, { stats: svc.indexer.stats(), ...(plan ? { events: svc.indexer.eventsForPlan(Number(plan)) } : {}) });
  }
  if (method === 'GET' && p === '/rails') {
    // Payouts still pending are asked once more, so the list shows where each SEP-31 transfer is.
    const off = svc.offRamp;
    if (off) await Promise.all(off.entries.filter((e) => e.status === 'pending').map((e) => off.status(e.txId).catch(() => e.status)));
    return send(res, 200, { onRamp: svc.onRamp?.entries ?? [], offRamp: off?.entries ?? [] });
  }
  send(res, 404, { error: { code: 'NOT_FOUND', message: `${method} ${p}` } });
}

export function startHttp(svc: TestnetService, host: string, port: number, log: (m: string) => void): Promise<Server> {
  const server = createServer((req, res) => {
    route(svc, req, res).catch((e: unknown) => {
      log(`request ${req.method} ${req.url} failed: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) send(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
      else res.end();
    });
  });
  // Payments wait for chain transactions and the indexer; keep idle sockets open long enough.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}
