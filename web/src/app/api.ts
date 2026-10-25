// Single API instance for the web app. DEMO_MODE (VITE_DEMO_MODE, the only VITE_ variable in
// `.env.testnet`) picks the transport without touching any view:
// - mock: the whole stack runs in the page (`createMockApi`) with localStorage persistence, so a
//   refresh during a rehearsal keeps the state; `?reset=1` or "Reiniciar demo" wipes it.
// - testnet: every call goes over HTTP to the Node server (services/server, localhost:8787, proxied
//   by Vite under /api), which holds the Stellar keys. The page holds no key and no chain client.

import { ApiError, createMockApi, type ApiErrorCode, type ChateauxApi, type PayStep, type Persistence, type Snapshot } from '@chateaux/services';

const STORAGE_KEY = 'chateaux-demo-v1';

const localPersistence: Persistence = {
  load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Snapshot) : null;
    } catch {
      return null;
    }
  },
  save(snapshot) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // storage unavailable (private mode, quota): the demo keeps running in memory
    }
  },
  clear() {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
};

function shouldResetFromUrl(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('reset') === '1';
  } catch {
    return false;
  }
}

if (shouldResetFromUrl()) {
  localPersistence.clear();
  try {
    window.localStorage.removeItem('chateaux-demo-corridor');
  } catch {
    // ignore
  }
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
}

export const DEMO_MODE = (import.meta.env.VITE_DEMO_MODE as string | undefined) ?? 'mock';

type ErrorBody = { error: { code: string; message: string } };

const toApiError = (b: ErrorBody) => new ApiError(b.error.code as ApiErrorCode, b.error.message);

/** ChateauxApi over HTTP: `POST /api/<method>` with `{args}`; pay/payAhead stream NDJSON progress. */
export class HttpApi implements ChateauxApi {
  constructor(private readonly base = '/api') {}

  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) });
    } catch (e) {
      throw new ApiError('PROVIDER', `server unreachable (${e instanceof Error ? e.message : String(e)}); is \`npm run demo:testnet\` running?`);
    }
    const body = (await res.json().catch(() => null)) as ({ result: T } & Partial<ErrorBody>) | null;
    if (!body) throw new ApiError('PROVIDER', `server answered HTTP ${res.status} without a body`);
    if (body.error) throw toApiError(body as ErrorBody);
    return body.result;
  }

  private async stream<T>(method: string, onProgress: ((s: PayStep) => void) | undefined, ...args: unknown[]): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }) }).catch((e: unknown) => {
      throw new ApiError('PROVIDER', `server unreachable (${e instanceof Error ? e.message : String(e)})`);
    });
    if (!res.body) throw new ApiError('PROVIDER', `server answered HTTP ${res.status} without a body`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as { progress?: PayStep; result?: T } & Partial<ErrorBody>;
        if (msg.progress) onProgress?.(msg.progress);
        else if (msg.error) throw toApiError(msg as ErrorBody);
        else if ('result' in msg) return msg.result as T;
      }
      if (done) throw new ApiError('PROVIDER', `${method}: the server closed the stream without a result`);
    }
  }

  getDemoState: ChateauxApi['getDemoState'] = () => this.call('getDemoState');
  listBuyers: ChateauxApi['listBuyers'] = () => this.call('listBuyers');
  listPlans: ChateauxApi['listPlans'] = () => this.call('listPlans');
  getPlan: ChateauxApi['getPlan'] = (planId) => this.call('getPlan', planId);
  getReceipts: ChateauxApi['getReceipts'] = (planId) => this.call('getReceipts', planId);
  getSpot: ChateauxApi['getSpot'] = () => this.call('getSpot');
  quoteLock: ChateauxApi['quoteLock'] = (planId, tenor) => this.call('quoteLock', planId, tenor);
  acceptLock: ChateauxApi['acceptLock'] = (lockId) => this.call('acceptLock', lockId);
  pay: ChateauxApi['pay'] = (planId, idx, onProgress) => this.stream('pay', onProgress, planId, idx);
  payAhead: ChateauxApi['payAhead'] = (planId, onProgress) => this.stream('payAhead', onProgress, planId);
  getUnitSummaries: ChateauxApi['getUnitSummaries'] = () => this.call('getUnitSummaries');
  getReconciliation: ChateauxApi['getReconciliation'] = (filter) => this.call('getReconciliation', filter);
  getHedgeBook: ChateauxApi['getHedgeBook'] = () => this.call('getHedgeBook');
  bookStrip: ChateauxApi['bookStrip'] = () => this.call('bookStrip');
  setPassThrough: ChateauxApi['setPassThrough'] = (p) => this.call('setPassThrough', p);
  advanceClock: ChateauxApi['advanceClock'] = (months) => this.call('advanceClock', months);
  reset: ChateauxApi['reset'] = () => this.call('reset');
  setErrorMode: ChateauxApi['setErrorMode'] = (on) => this.call('setErrorMode', on);
  listOffices: ChateauxApi['listOffices'] = () => this.call('listOffices');
  getPayOptions: ChateauxApi['getPayOptions'] = (planId, idx) => this.call('getPayOptions', planId, idx);
  requestCashReference: ChateauxApi['requestCashReference'] = (planId, idx) => this.call('requestCashReference', planId, idx);
  renewCashReference: ChateauxApi['renewCashReference'] = (paymentId) => this.call('renewCashReference', paymentId);
  completeCashReference: ChateauxApi['completeCashReference'] = (paymentId, onProgress) => this.stream('completeCashReference', onProgress, paymentId);
  getPayment: ChateauxApi['getPayment'] = (paymentId) => this.call('getPayment', paymentId);
  listPayments: ChateauxApi['listPayments'] = (filter) => this.call('listPayments', filter);
  searchBuyers: ChateauxApi['searchBuyers'] = (query) => this.call('searchBuyers', query);
  takeCounterPayment: ChateauxApi['takeCounterPayment'] = (args, onProgress) => this.stream('takeCounterPayment', onProgress, args);
  getShiftTotal: ChateauxApi['getShiftTotal'] = (args) => this.call('getShiftTotal', args);
  sendReceiptMessage: ChateauxApi['sendReceiptMessage'] = (planId, idx) => this.call('sendReceiptMessage', planId, idx);
  listPlanRows: ChateauxApi['listPlanRows'] = () => this.call('listPlanRows');
  listSellers: ChateauxApi['listSellers'] = () => this.call('listSellers');
  getSeller: ChateauxApi['getSeller'] = (sellerId) => this.call('getSeller', sellerId);
  setSellerVerification: ChateauxApi['setSellerVerification'] = (sellerId, status, note) => this.call('setSellerVerification', sellerId, status, note);
  changeSellerPayoutAccount: ChateauxApi['changeSellerPayoutAccount'] = (sellerId, account) => this.call('changeSellerPayoutAccount', sellerId, account);
  raiseCnrAlert: ChateauxApi['raiseCnrAlert'] = (sellerId, unitId, detail) => this.call('raiseCnrAlert', sellerId, unitId, detail);
  listPayouts: ChateauxApi['listPayouts'] = (filter) => this.call('listPayouts', filter);
  retryPayout: ChateauxApi['retryPayout'] = (payoutId) => this.call('retryPayout', payoutId);
  listOutbox: ChateauxApi['listOutbox'] = (planId) => this.call('listOutbox', planId);
  runAdverseAction: ChateauxApi['runAdverseAction'] = (action, detail) => this.call('runAdverseAction', action, detail);
}

function buildApi(): ChateauxApi {
  if (DEMO_MODE === 'testnet') return new HttpApi();
  return createMockApi({ persistence: localPersistence });
}

export const api: ChateauxApi = buildApi();

export function clearPersistedDemo(): void {
  localPersistence.clear();
}
