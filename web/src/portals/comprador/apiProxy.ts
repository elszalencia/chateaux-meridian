// Test seam: a stand-in for the `api` export that forwards to whichever services stack the holder
// has now, so each test swaps in its own stack and can spy on single methods of it. Kept free of
// app imports so a `vi.mock` factory can load it.

import type { DemoApi } from '@casa-puente/services';

/** A stand-in for the `api` export that forwards to whichever stack the holder has now. */
export function apiProxy(holder: { api: DemoApi | null }): DemoApi {
  return new Proxy({} as DemoApi, {
    get: (_t, key) => {
      const target = holder.api as unknown as Record<string | symbol, unknown>;
      const v = target[key];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(holder.api) : v;
    },
  });
}
