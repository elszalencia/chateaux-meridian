// Demo control bar: shows the demo date and mode, advances the clock one month, resets to step 1
// (and shows the measured reset time), and toggles the error mode. On the buyer view it also picks
// which buyer is shown ("Ver como"), so each adverse state can be demoed. Presenter chrome only; it
// is not part of any product screen.

import { useState } from 'react';
import { CORRIDOR_IDS, DEFAULT_PLAN_BY_CORRIDOR } from '@chateaux/services';
import { useDemo } from '../app/demo';
import { useFormat } from '../app/format';
import { useAsync } from '../app/hooks';
import { useT } from '../app/i18n';
import { navigateTo, useBuyerPlan, useFullRoute } from '../app/router';
import { Button } from './ui';
import { api, DEMO_MODE } from '../app/api';

function BuyerPicker() {
  const t = useT();
  const { version, corridor } = useDemo();
  const [planId, selectPlan] = useBuyerPlan();
  const plans = useAsync(() => api.listPlans(), [version]);
  return (
    <label className="flex items-center gap-2 text-ink-700" title={t('demo.viewAsHint')}>
      {t('demo.viewAs')}
      <select
        data-testid="demo-buyer"
        aria-label={t('demo.viewAs')}
        className="min-h-9 rounded-md border border-ink-300 bg-white px-2 text-sm text-ink-900"
        value={planId ?? DEFAULT_PLAN_BY_CORRIDOR[corridor]}
        onChange={(e) => selectPlan(e.target.value)}
      >
        {(plans.data ?? []).map(({ plan, buyer }) => (
          <option key={plan.id} value={plan.id}>
            {buyer.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function DemoBar() {
  const t = useT();
  const f = useFormat();
  const demo = useDemo();
  const [resetMs, setResetMs] = useState<number | null>(null);
  const route = useFullRoute();
  const view = route.view;

  return (
    <div role="region" aria-label={t('demo.bar')} data-testid="demo-bar" className="border-b border-warn-500/40 bg-warn-100/60">
      <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 text-sm">
        <span className="font-semibold text-warn-700">{t('demo.mode', { mode: DEMO_MODE })}</span>
        <label className="flex items-center gap-2 text-ink-700" title={t('demo.corridorHint')}>
          {t('demo.corridor')}
          <select
            data-testid="demo-corridor"
            aria-label={t('demo.corridor')}
            className="min-h-9 rounded-md border border-ink-300 bg-white px-2 text-sm text-ink-900"
            value={demo.corridor}
            onChange={(e) => {
              demo.setCorridor(e.target.value as typeof demo.corridor);
              // The bar follows the plan on screen: a buyer plan of the other corridor gives way to
              // the chosen corridor's default buyer.
              if (route.view === 'comprador' && route.planId) navigateTo('#/comprador');
            }}
          >
            {CORRIDOR_IDS.map((c) => (
              <option key={c} value={c}>
                {t(`corridors.${c}.name`)}
              </option>
            ))}
          </select>
        </label>
        <span className="text-ink-700">
          {t('demo.today')}: <strong data-testid="demo-today" className="tabular">{demo.state ? f.date(demo.state.today) : '…'}</strong>
        </span>
        {view === 'comprador' && <BuyerPicker />}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button label={t('demo.advanceMonthHint')} variant="secondary" size="sm" busy={demo.busy} data-testid="demo-advance" onClick={() => void demo.advanceMonth()}>
            {t('demo.advanceMonth')}
          </Button>
          <Button
            label={t('demo.resetHint')}
            variant="secondary"
            size="sm"
            busy={demo.busy}
            data-testid="demo-reset"
            onClick={() => {
              void demo.reset().then((ms) => setResetMs(ms));
            }}
          >
            {t('demo.reset')}
          </Button>
          {resetMs != null && (
            <span data-testid="demo-reset-time" role="status" className="tabular text-xs text-ink-700">
              {t('demo.resetDone', { seconds: (resetMs / 1000).toFixed(2) })}
            </span>
          )}
          <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-ink-700 hover:bg-white/60" title={t('demo.errorModeHint')}>
            <input
              type="checkbox"
              aria-label={t('demo.errorMode')}
              data-testid="demo-error-mode"
              className="h-4 w-4 accent-danger-600"
              checked={demo.state?.errorMode ?? false}
              onChange={(e) => void demo.setErrorMode(e.target.checked)}
            />
            {t('demo.errorMode')}
          </label>
        </div>
      </div>
    </div>
  );
}
