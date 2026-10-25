// Oficina: one route, two surfaces. Without an explicit surface in the URL, a touch device or a
// narrow landscape screen opens the counter (Mostrador) and a desktop opens the desk (Escritorio).
// The toggle in the header overrides the default for this tab (sessionStorage). The corridor of
// what each surface shows comes from the plans and offices it lists, never from this shell.

import { Suspense, lazy, useEffect, useState } from 'react';
import { useT } from '../../app/i18n';
import { useFullRoute, type OficinaSurface } from '../../app/router';
import { Spinner } from '../../components/ui';
import { useOT } from './shared/i18n';

const Mostrador = lazy(() => import('./mostrador/MostradorView'));
const Escritorio = lazy(() => import('./escritorio/EscritorioView'));

const SURFACE_KEY = 'chateaux-oficina-surface';

/** Counter on touch or narrow landscape screens, desk otherwise (brief §3). */
export function defaultSurface(win: Pick<Window, 'matchMedia' | 'innerWidth'> = window): OficinaSurface {
  const coarse = win.matchMedia('(pointer: coarse)').matches;
  const narrowLandscape = win.innerWidth < 1400 && win.matchMedia('(orientation: landscape)').matches;
  return coarse || narrowLandscape ? 'mostrador' : 'escritorio';
}

function readOverride(): OficinaSurface | null {
  try {
    const v = window.sessionStorage.getItem(SURFACE_KEY);
    return v === 'mostrador' || v === 'escritorio' ? v : null;
  } catch {
    return null;
  }
}

export default function OficinaView() {
  const t = useT();
  const ot = useOT();
  const route = useFullRoute();
  const [override, setOverride] = useState<OficinaSurface | null>(readOverride);
  const surface: OficinaSurface = route.surface ?? override ?? defaultSurface();

  useEffect(() => {
    if (route.surface) setOverride(route.surface);
  }, [route.surface]);

  const choose = (s: OficinaSurface) => {
    setOverride(s);
    try {
      window.sessionStorage.setItem(SURFACE_KEY, s);
    } catch {
      // ignore
    }
    window.location.hash = `#/oficina/${s}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">{t('oficina.title')}</h1>
          <p data-testid="oficina-role" className="text-sm text-ink-700">
            {ot(`role.${surface}`)}
          </p>
        </div>
        <div role="group" aria-label={t('oficina.surfaceToggle')} className="flex overflow-hidden rounded-lg border border-ink-300">
          {(['mostrador', 'escritorio'] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={surface === s}
              data-testid={`oficina-surface-${s}`}
              onClick={() => choose(s)}
              className={`min-h-11 px-4 text-sm font-semibold ${surface === s ? 'bg-brand-700 text-white' : 'bg-white text-ink-700 hover:bg-ink-100'}`}
            >
              {t(`oficina.surfaces.${s}`)}
            </button>
          ))}
        </div>
      </div>
      <Suspense fallback={<Spinner />}>{surface === 'mostrador' ? <Mostrador /> : <Escritorio />}</Suspense>
    </div>
  );
}
