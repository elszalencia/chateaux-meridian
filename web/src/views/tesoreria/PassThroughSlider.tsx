// Pass-through slider: the value is local while dragging and committed to the demo state after a
// short debounce, so the preview updates on every step while the API is called once per gesture.
// The preview applies the engine's own `lockedRate` to the curve in use, so what treasury sees here
// is exactly what a buyer would be quoted for a quarterly lock at that pass-through.

import { useEffect, useRef, useState } from 'react';
import { lockedRate, roundUsd, usdDue, type HedgeBookView } from '@chateaux/services';
import { useDemo } from '../../app/demo';
import { useFormat } from '../../app/format';
import { useAction } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Card, ErrorState } from '../../components/ui';

const SAMPLE_INSTALLMENT_COP = 4_093_125;
const DEBOUNCE_MS = 350;

export function PassThroughSlider({ book }: { book: HedgeBookView }) {
  const t = useT();
  const f = useFormat();
  const demo = useDemo();
  const [pct, setPct] = useState(Math.round(book.passThrough * 100));
  const timer = useRef<number | null>(null);
  const apply = useAction((p: number) => demo.setPassThrough(p));

  useEffect(() => {
    setPct(Math.round(book.passThrough * 100));
  }, [book.passThrough]);

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
  }, []);

  const onChange = (next: number) => {
    setPct(next);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (next !== Math.round(book.passThrough * 100)) void apply.run(next / 100);
    }, DEBOUNCE_MS);
  };

  const spot = book.curve.find((p) => p.tenor === 'spot')?.rate;
  const fwds = (['1M', '2M', '3M'] as const).map((tn) => book.curve.find((p) => p.tenor === tn)?.rate).filter((r): r is number => r != null);
  const preview = spot != null && fwds.length === 3 ? previewQuote(spot, fwds, pct / 100) : null;

  return (
    <Card title={t('tesoreria.passThrough.title')}>
      <label className="block text-sm font-medium text-ink-700">
        {t('tesoreria.passThrough.label')}
        <div className="mt-2 flex items-center gap-3">
          <input
            id="pass-through-slider"
            data-testid="pass-through-slider"
            type="range"
            min={0}
            max={100}
            step={5}
            value={pct}
            aria-label={t('tesoreria.passThrough.aria')}
            aria-valuetext={f.pct(pct / 100)}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-11 w-full accent-brand-700"
          />
          <output data-testid="pass-through-value" htmlFor="pass-through-slider" className="tabular w-16 text-right text-lg font-semibold text-ink-900">
            {f.pct(pct / 100)}
          </output>
        </div>
      </label>
      <p className="mt-1 text-xs text-ink-500">{t('tesoreria.passThrough.caption')}</p>
      <p role="status" aria-live="polite" className="mt-1 min-h-4 text-xs text-ink-500">
        {apply.busy ? t('tesoreria.passThrough.applying') : apply.status === 'success' ? t('tesoreria.passThrough.applied', { pct: f.pct(book.passThrough) }) : ''}
      </p>
      {apply.status === 'error' && <ErrorState error={apply.error} compact onRetry={() => void apply.run(pct / 100)} />}

      {preview && (
        <div className="mt-4 rounded-lg bg-ink-50 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{t('tesoreria.passThrough.preview')}</p>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-500">{t('tesoreria.passThrough.spot')}</dt>
            <dd className="tabular text-right text-ink-900">{f.rate(preview.spot)}</dd>
            <dt className="text-ink-500">{t('tesoreria.passThrough.avgFwd')}</dt>
            <dd className="tabular text-right text-ink-900">{f.rate(preview.avgFwd)}</dd>
            <dt className="text-ink-500">{t('tesoreria.passThrough.points')}</dt>
            <dd className="tabular text-right text-ink-900">{`+${f.rate(preview.locked - preview.spot)}`}</dd>
            <dt className="font-semibold text-ink-900">{t('tesoreria.passThrough.locked')}</dt>
            <dd className="tabular text-right text-lg font-semibold text-brand-800">{f.rate(preview.locked)}</dd>
            <dt className="text-ink-500">{t('tesoreria.passThrough.usdFor', { cop: f.cop(SAMPLE_INSTALLMENT_COP) })}</dt>
            <dd className="tabular text-right font-semibold text-ink-900">{f.usd(preview.usd)}</dd>
          </dl>
          <p className="mt-2 text-xs text-ink-500">{t('tesoreria.passThrough.formula')}</p>
        </div>
      )}
    </Card>
  );
}

function previewQuote(spot: number, fwds: number[], passThrough: number) {
  const locked = lockedRate({ spot, fwdRates: fwds, passThrough });
  const avgFwd = fwds.reduce((a, b) => a + b, 0) / fwds.length;
  return { spot, avgFwd, locked, usd: roundUsd(usdDue(SAMPLE_INSTALLMENT_COP, locked)) };
}
