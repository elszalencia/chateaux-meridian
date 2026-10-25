// Oficina · Escritorio: the back office at 1440 px, keyboard first. Ctrl+K (⌘K) jumps to the desk
// search (plans, buyers, sellers); arrow keys move between tabs; Esc closes the open drawer. Tabs:
// Planes, Vendedores, Pagos al vendedor and the WhatsApp outbox, plus the Colombia views
// (Constructora/Fiducia, Tesorería) unchanged, listed only when some plan's corridor has them
// (config `views`). Details open in drawers; only irreversible actions confirm in a modal.

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CORRIDORS, type PlanRow } from '@casa-puente/services';
import { api } from '../../../app/api';
import { useDemo } from '../../../app/demo';
import { useAsync } from '../../../app/hooks';
import { ErrorState, Spinner } from '../../../components/ui';
import { useOT } from '../shared/i18n';
import { DeskSearch } from './DeskSearch';
import { OutboxTab } from './outbox/OutboxTab';
import { PagosTab } from './pagos/PagosTab';
import { PlanDrawer } from './planes/PlanDrawer';
import { PlanesTab } from './planes/PlanesTab';
import { SellerDrawer } from './vendedores/SellerDrawer';
import { VendedoresTab } from './vendedores/VendedoresTab';

const Constructora = lazy(() => import('../../../views/constructora/ConstructoraView'));
const Tesoreria = lazy(() => import('../../../views/tesoreria/TesoreriaView'));

export type DeskTab = 'planes' | 'vendedores' | 'pagos' | 'mensajes' | 'constructora' | 'tesoreria';
const BASE_TABS: DeskTab[] = ['planes', 'vendedores', 'pagos', 'mensajes'];

/** Colombia views appear when a listed plan's corridor has them (config, not a country check). */
export function deskTabs(rows: PlanRow[]): DeskTab[] {
  const tabs = [...BASE_TABS];
  if (rows.some((r) => CORRIDORS[r.corridor].views.constructora)) tabs.push('constructora');
  if (rows.some((r) => CORRIDORS[r.corridor].views.tesoreria)) tabs.push('tesoreria');
  return tabs;
}

export default function EscritorioView({ initialTab = 'planes' }: { initialTab?: DeskTab }) {
  const ot = useOT();
  const { version } = useDemo();
  const [bump, setBump] = useState(0);
  const changed = useCallback(() => setBump((b) => b + 1), []);
  const rows = useAsync(() => api.listPlanRows(), [version, bump]);
  const sellers = useAsync(() => api.listSellers(), [version, bump]);
  const [tab, setTab] = useState<DeskTab>(initialTab);
  const [planId, setPlanId] = useState<string | null>(null);
  const [sellerId, setSellerId] = useState<string | null>(null);
  const tabs = useMemo(() => deskTabs(rows.data ?? []), [rows.data]);
  const tabRefs = useRef<Partial<Record<DeskTab, HTMLButtonElement | null>>>({});
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPlanId(null);
        setSellerId(null);
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openPlan = useCallback((id: string) => {
    setSellerId(null);
    setPlanId(id);
  }, []);
  const openSeller = useCallback((id: string) => {
    setPlanId(null);
    setSellerId(id);
  }, []);
  const goTab = useCallback((t: DeskTab) => {
    setPlanId(null);
    setSellerId(null);
    setTab(t);
  }, []);

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = tabs.indexOf(tab);
    const nextIdx = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -1;
    if (nextIdx < 0) return;
    e.preventDefault();
    const nextTab = tabs[nextIdx]!;
    setTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  };

  return (
    <div data-testid="escritorio" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div role="tablist" aria-label={ot('escritorio.tabsLabel')} className="flex flex-wrap gap-1 rounded-lg bg-ink-100 p-1">
          {tabs.map((t) => (
            <button
              key={t}
              ref={(el) => {
                tabRefs.current[t] = el;
              }}
              type="button"
              role="tab"
              id={`desk-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`desk-panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              data-testid={`desk-tab-${t}`}
              onClick={() => goTab(t)}
              onKeyDown={onTabKey}
              className={`min-h-11 whitespace-nowrap rounded-md px-4 text-sm font-semibold ${tab === t ? 'bg-white text-brand-800 shadow-sm' : 'text-ink-700 hover:bg-white/60'}`}
            >
              {ot(`escritorio.tabs.${t}`)}
            </button>
          ))}
        </div>
        <DeskSearch inputRef={searchRef} rows={rows.data ?? []} sellers={sellers.data ?? []} onPlan={openPlan} onSeller={openSeller} />
      </div>

      <div role="tabpanel" id={`desk-panel-${tab}`} aria-labelledby={`desk-tab-${tab}`} tabIndex={-1}>
        {tab === 'planes' && <PlanesTab rows={rows} onOpen={openPlan} />}
        {tab === 'vendedores' && <VendedoresTab sellers={sellers} onOpen={openSeller} />}
        {tab === 'pagos' && <PagosTab refreshKey={bump} onChanged={changed} onOpenPlan={openPlan} onOpenSeller={openSeller} />}
        {tab === 'mensajes' && <OutboxTab rows={rows.data ?? []} refreshKey={bump} onOpenPlan={openPlan} />}
        {(tab === 'constructora' || tab === 'tesoreria') && (
          <Suspense fallback={<Spinner />}>{tab === 'constructora' ? <Constructora /> : <Tesoreria />}</Suspense>
        )}
        {rows.status === 'error' && tab !== 'planes' && <ErrorState error={rows.error} onRetry={rows.reload} compact />}
      </div>

      {planId && <PlanDrawer planId={planId} onClose={() => setPlanId(null)} onChanged={changed} onOpenSeller={openSeller} onOpenTab={goTab} refreshKey={bump} />}
      {sellerId && <SellerDrawer sellerId={sellerId} rows={rows.data ?? []} onClose={() => setSellerId(null)} onChanged={changed} onOpenPlan={openPlan} refreshKey={bump} />}
    </div>
  );
}
