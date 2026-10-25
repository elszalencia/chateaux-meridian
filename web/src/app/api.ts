// Single API instance for the web app. DEMO_MODE (VITE_DEMO_MODE, the only VITE_ variable in
// `.env.testnet`) picks the transport without touching any view:
// - mock: the whole stack runs in the page (`createMockApi`) with localStorage persistence, so a
//   refresh during a rehearsal keeps the state; `?reset=1` or "Reiniciar demo" wipes it.
// - testnet: every call goes over HTTP to the Node server (services/server, localhost:8787, proxied
//   by Vite under /api), which holds the Stellar keys. The page holds no key and no chain client.

import { ApiError, createMockApi, type ApiErrorCode, type CasaPuenteApi, type PayStep, type Persistence, type Snapshot } from '@casa-puente/services';

const STORAGE_KEY = 'casa-puente-demo-v1';

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
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
}

export const DEMO_MODE = (import.meta.env.VITE_DEMO_MODE as string | undefined) ?? 'mock';

type ErrorBody = { error: { code: string; message: string } };

const toApiError = (b: ErrorBody) => new ApiError(b.error.code as ApiErrorCode, b.error.message);

/** CasaPuenteApi over HTTP: `POST /api/<method>` with `{args}`; pay/payAhead stream NDJSON progress. */
export class HttpApi implements CasaPuenteApi {
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

  getDemoState: CasaPuenteApi['getDemoState'] = () => this.call('getDemoState');
  listBuyers: CasaPuenteApi['listBuyers'] = () => this.call('listBuyers');
  listPlans: CasaPuenteApi['listPlans'] = () => this.call('listPlans');
  getPlan: CasaPuenteApi['getPlan'] = (planId) => this.call('getPlan', planId);
  getReceipts: CasaPuenteApi['getReceipts'] = (planId) => this.call('getReceipts', planId);
  getSpot: CasaPuenteApi['getSpot'] = () => this.call('getSpot');
  quoteLock: CasaPuenteApi['quoteLock'] = (planId, tenor) => this.call('quoteLock', planId, tenor);
  acceptLock: CasaPuenteApi['acceptLock'] = (lockId) => this.call('acceptLock', lockId);
  pay: CasaPuenteApi['pay'] = (planId, idx, onProgress) => this.stream('pay', onProgress, planId, idx);
  payAhead: CasaPuenteApi['payAhead'] = (planId, onProgress) => this.stream('payAhead', onProgress, planId);
  getUnitSummaries: CasaPuenteApi['getUnitSummaries'] = () => this.call('getUnitSummaries');
  getReconciliation: CasaPuenteApi['getReconciliation'] = (filter) => this.call('getReconciliation', filter);
  getHedgeBook: CasaPuenteApi['getHedgeBook'] = () => this.call('getHedgeBook');
  bookStrip: CasaPuenteApi['bookStrip'] = () => this.call('bookStrip');
  setPassThrough: CasaPuenteApi['setPassThrough'] = (p) => this.call('setPassThrough', p);
  advanceClock: CasaPuenteApi['advanceClock'] = (months) => this.call('advanceClock', months);
  reset: CasaPuenteApi['reset'] = () => this.call('reset');
  setErrorMode: CasaPuenteApi['setErrorMode'] = (on) => this.call('setErrorMode', on);
}

function buildApi(): CasaPuenteApi {
  if (DEMO_MODE === 'testnet') return new HttpApi();
  return createMockApi({ persistence: localPersistence });
}

export const api: CasaPuenteApi = buildApi();

export function clearPersistedDemo(): void {
  localPersistence.clear();
}
