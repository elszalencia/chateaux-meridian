// Route switcher: three views, one URL each (#/comprador, #/constructora, #/tesoreria), so the e2e test
// and the presenter can deep-link without a router dependency. The buyer view takes an optional plan
// (#/comprador/plan-luis) so the presenter can show each adverse state; without one it is María's.

import { useEffect, useState } from 'react';

export type ViewKey = 'comprador' | 'constructora' | 'tesoreria';
export const VIEWS: ViewKey[] = ['comprador', 'constructora', 'tesoreria'];

export function parseRoute(hash: string): ViewKey {
  const m = /^#\/?([a-z]+)/.exec(hash);
  const key = m?.[1];
  return VIEWS.includes(key as ViewKey) ? (key as ViewKey) : 'comprador';
}

/** The plan id in `#/comprador/<plan-id>`, or null. */
export function parseBuyerPlan(hash: string): string | null {
  return /^#\/?comprador\/([a-z0-9-]+)/.exec(hash)?.[1] ?? null;
}

function useHash(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function useRoute(): [ViewKey, (v: ViewKey) => void] {
  const view = parseRoute(useHash());
  const navigate = (v: ViewKey) => {
    window.location.hash = `#/${v}`;
  };
  return [view, navigate];
}

/** The buyer plan on screen (null = the default buyer) and a setter that keeps the buyer view. */
export function useBuyerPlan(): [string | null, (planId: string) => void] {
  const plan = parseBuyerPlan(useHash());
  const select = (planId: string) => {
    window.location.hash = `#/comprador/${planId}`;
  };
  return [plan, select];
}
