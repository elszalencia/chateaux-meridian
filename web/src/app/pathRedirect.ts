// Path URLs become hash routes before the app renders: /oficina → /#/oficina, /comprador/plan-x →
// /#/comprador/plan-x, /c/plan-x/pagar → /#/c/plan-x/pagar. The dev server and any static host serve
// index.html for every path, and the query string (for example ?reset=1) is kept.

const PORTAL_PATH = /^\/(oficina|comprador|c|constructora|tesoreria)(\/|$)/;

export function redirectPathToHash(loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location): string | null {
  if (!PORTAL_PATH.test(loc.pathname)) return null;
  const path = loc.pathname.replace(/\/+$/, '');
  return `/${loc.search}#${path}`;
}

const target = typeof window !== 'undefined' ? redirectPathToHash() : null;
if (target) window.history.replaceState({}, '', target);
