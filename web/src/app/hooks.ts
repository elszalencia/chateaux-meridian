// useAsync: one hook for every data load so each screen has the same loading / error / success
// states. `deps` re-run the loader (views pass the demo version so the clock, reset and error mode
// refresh every screen). `run` wraps user actions with the same bookkeeping.

import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { ApiError, MockProviderError } from '@chateaux/services';

export type AsyncStatus = 'idle' | 'loading' | 'success' | 'error';

export interface AsyncState<T> {
  status: AsyncStatus;
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(loader: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setStatus('loading');
    setError(null);
    loader().then(
      (d) => {
        if (my !== seq.current) return;
        setData(d);
        setStatus('success');
      },
      (e: unknown) => {
        if (my !== seq.current) return;
        setError(e);
        setStatus('error');
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { status, data, error, loading: status === 'loading', reload };
}

export interface ActionState<A extends unknown[], R> {
  status: AsyncStatus;
  error: unknown;
  result: R | null;
  busy: boolean;
  run: (...args: A) => Promise<R | undefined>;
  resetAction: () => void;
}

export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): ActionState<A, R> {
  const [status, setStatus] = useState<AsyncStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<R | null>(null);
  const run = useCallback(
    async (...args: A) => {
      setStatus('loading');
      setError(null);
      try {
        const r = await fn(...args);
        setResult(r);
        setStatus('success');
        return r;
      } catch (e) {
        setError(e);
        setStatus('error');
        return undefined;
      }
    },
    [fn],
  );
  const resetAction = useCallback(() => {
    setStatus('idle');
    setError(null);
    setResult(null);
  }, []);
  return { status, error, result, busy: status === 'loading', run, resetAction };
}

/** Maps any thrown value to an i18n key under `errors.*`. */
export function errorKey(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'PROVIDER' && e.cause instanceof MockProviderError) return 'errors.provider';
    return `errors.${e.code.toLowerCase()}`;
  }
  if (e instanceof MockProviderError) return 'errors.provider';
  return 'errors.unknown';
}
