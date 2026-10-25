// Route switcher without a router dependency. Hash routes, one per surface, so the e2e tests and
// the presenter can deep-link:
//   #/comprador[/<plan-id>]            buyer portal (María's plan, or the presenter corridor's default, when no plan is named)
//   #/c/<plan-id>/pagar                buyer deep link from a WhatsApp message: opens the pay sheet
//   #/c/<plan-id>/recibo/<idx>         buyer deep link: opens one receipt (0-based installment index)
//   #/oficina[/mostrador|/escritorio]  office portal; without a surface the device decides (see OficinaView)
//   #/constructora, #/tesoreria        Colombia office views (unchanged)
// Path URLs (/oficina, /comprador, /c/...) are turned into the same hash routes by pathRedirect.ts.

import { useEffect, useState } from 'react';

export type ViewKey = 'comprador' | 'oficina' | 'constructora' | 'tesoreria';
export const VIEWS: ViewKey[] = ['comprador', 'oficina', 'constructora', 'tesoreria'];

export type OficinaSurface = 'mostrador' | 'escritorio';

export interface Route {
  view: ViewKey;
  /** `#/comprador/<plan>` or `#/c/<plan>/...` */
  planId: string | null;
  /** Buyer deep-link action. */
  action: 'pagar' | 'recibo' | null;
  /** Installment index of `#/c/<plan>/recibo/<idx>`. */
  idx: number | null;
  /** Explicit office surface, or null to let the device decide. */
  surface: OficinaSurface | null;
}

export function parseFullRoute(hash: string): Route {
  const none: Route = { view: 'comprador', planId: null, action: null, idx: null, surface: null };
  const deep = /^#\/?c\/([a-z0-9-]+)(?:\/(pagar|recibo)(?:\/(\d+))?)?/.exec(hash);
  if (deep) {
    const action = (deep[2] as Route['action']) ?? null;
    return { ...none, planId: deep[1]!, action, idx: action === 'recibo' && deep[3] != null ? Number(deep[3]) : null };
  }
  const m = /^#\/?([a-z]+)(?:\/([a-z0-9-]+))?/.exec(hash);
  const key = m?.[1];
  if (!VIEWS.includes(key as ViewKey)) return none;
  const view = key as ViewKey;
  if (view === 'comprador') return { ...none, planId: m?.[2] ?? null };
  if (view === 'oficina') return { ...none, view, surface: m?.[2] === 'mostrador' || m?.[2] === 'escritorio' ? m[2] : null };
  return { ...none, view };
}

export function parseRoute(hash: string): ViewKey {
  return parseFullRoute(hash).view;
}

/** The plan id in `#/comprador/<plan-id>` or `#/c/<plan-id>/...`, or null. */
export function parseBuyerPlan(hash: string): string | null {
  return parseFullRoute(hash).planId;
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

export function useFullRoute(): Route {
  return parseFullRoute(useHash());
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

/** Deep links the WhatsApp templates carry; one per template. */
export const deepLinks = {
  pay: (planId: string) => `#/c/${planId}/pagar`,
  receipt: (planId: string, idx: number) => `#/c/${planId}/recibo/${idx}`,
  plan: (planId: string) => `#/comprador/${planId}`,
};

export function navigateTo(hash: string): void {
  window.location.hash = hash;
}
