// App shell: header (brand, view switcher, ES/EN toggle, "Modo demo" badge), the demo control bar
// (clock, +1 month, reset, error switch) and the active view. The shell never reads domain data
// itself; views load what they need through the API and refresh on the demo `version`.

import { Suspense, lazy } from 'react';
import { CORRIDORS } from '@casa-puente/services';
import { useDemo } from './app/demo';
import { useI18n } from './app/i18n';
import { useRoute, VIEWS } from './app/router';
import { DemoBar } from './components/DemoBar';
import { Spinner } from './components/ui';

const Comprador = lazy(() => import('./views/comprador/CompradorView'));
const Oficina = lazy(() => import('./portals/oficina/OficinaView'));
const Constructora = lazy(() => import('./views/constructora/ConstructoraView'));
const Tesoreria = lazy(() => import('./views/tesoreria/TesoreriaView'));

export default function App() {
  const { t, lang, setLang } = useI18n();
  const [view, navigate] = useRoute();
  const { corridor } = useDemo();
  // The nav lists the views the presenter corridor has (config/corridors.ts `views`); a view reached
  // by URL still renders, since the corridor of what it shows comes from the plan, not from here.
  const navViews = VIEWS.filter((v) => CORRIDORS[corridor].views[v]);

  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        {t('app.views.' + view)}
      </a>
      <header className="border-b border-ink-200 bg-white">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-700 text-lg font-bold text-white">
              CP
            </span>
            <div>
              <p className="text-lg font-semibold leading-tight">{t('app.title')}</p>
              <p className="hidden text-xs text-ink-500 sm:block">{t('app.tagline')}</p>
            </div>
            <span data-testid="demo-badge" className="ml-1 rounded-full border border-warn-500 bg-warn-100 px-2.5 py-0.5 text-xs font-semibold text-warn-700">
              {t('app.demoBadge')}
            </span>
          </div>
          <nav aria-label={t('app.viewSwitcher')} className="order-3 flex w-full gap-1 overflow-x-auto rounded-lg bg-ink-100 p-1 sm:order-none sm:ml-auto sm:w-auto">
            {navViews.map((v) => (
              <button
                key={v}
                type="button"
                aria-label={t('app.views.' + v)}
                aria-current={view === v ? 'page' : undefined}
                data-testid={`nav-${v}`}
                onClick={() => navigate(v)}
                className={`min-h-11 whitespace-nowrap rounded-md px-4 text-sm font-semibold transition-colors ${
                  view === v ? 'bg-white text-brand-800 shadow-sm' : 'text-ink-700 hover:bg-white/60'
                }`}
              >
                {t('app.views.' + v)}
              </button>
            ))}
          </nav>
          <div role="group" aria-label={t('app.language')} className="flex overflow-hidden rounded-lg border border-ink-300">
            {(['es', 'en'] as const).map((l) => (
              <button
                key={l}
                type="button"
                aria-pressed={lang === l}
                data-testid={`lang-${l}`}
                onClick={() => setLang(l)}
                className={`min-h-11 min-w-11 px-3 text-sm font-semibold ${lang === l ? 'bg-brand-700 text-white' : 'bg-white text-ink-700 hover:bg-ink-100'}`}
              >
                {l === 'es' ? t('app.langEs') : t('app.langEn')}
                {/* The spoken name starts with the visible abbreviation, then the full language name. */}
                <span className="sr-only">{l === 'es' ? ' Español' : ' English'}</span>
              </button>
            ))}
          </div>
        </div>
      </header>
      <DemoBar />
      <main id="main" className="mx-auto max-w-[1360px] px-4 py-6">
        <Suspense fallback={<Spinner />}>
          {view === 'comprador' && <Comprador />}
          {view === 'oficina' && <Oficina />}
          {view === 'constructora' && <Constructora />}
          {view === 'tesoreria' && <Tesoreria />}
        </Suspense>
      </main>
    </div>
  );
}
