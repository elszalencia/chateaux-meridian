// Lock flow in two steps: pick a term (monthly = next open installment, quarterly = next three),
// then review the quote. The quote card leads with what Constructora Bolívar secures for the buyer,
// shows the countdown computed from the quote's expiry against the wall clock, and lists the three
// disclosures before the accept button. Expiry (countdown or server) sends the buyer back to the
// term step with the expired-quote message; nothing is accepted automatically.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, type LockQuote, type Tenor } from '@chateaux/services';
import { api } from '../../app/api';
import { useFormat } from '../../app/format';
import { useAction } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Button, ErrorState, Modal, Spinner } from '../../components/ui';
import { Row } from './shared';

function Countdown({ expiresAt, onExpire }: { expiresAt: string; onExpire: () => void }) {
  const t = useT();
  const target = Date.parse(expiresAt);
  const [remainingMs, setRemainingMs] = useState(() => Math.max(0, target - Date.now()));
  const fired = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  useEffect(() => {
    const tick = () => {
      const left = Math.max(0, target - Date.now());
      setRemainingMs(left);
      if (left <= 0 && !fired.current) {
        fired.current = true;
        onExpireRef.current();
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [target]);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const ss = String(totalSeconds % 60).padStart(2, '0');
  return (
    <span data-testid="lock-countdown" aria-label={t('comprador.lock.countdownLabel')} className="tabular rounded-md bg-ink-900 px-2 py-0.5 font-mono text-lg text-white">
      {mm}:{ss}
    </span>
  );
}

export function LockFlow({ planId, initialTenor, onClose, onLocked }: { planId: string; initialTenor: Tenor | null; onClose: () => void; onLocked: (quote: LockQuote) => void }) {
  const t = useT();
  const f = useFormat();
  const [step, setStep] = useState<'tenor' | 'quote'>('tenor');
  const [tenor, setTenor] = useState<Tenor | null>(initialTenor);
  const [notice, setNotice] = useState<string | null>(null);
  const quoteAction = useAction(useCallback((tn: Tenor) => api.quoteLock(planId, tn), [planId]));
  const acceptAction = useAction(useCallback((lockId: string) => api.acceptLock(lockId), []));
  const quote = quoteAction.result;
  const { run: runQuote, resetAction: resetQuote } = quoteAction;
  const { resetAction: resetAccept } = acceptAction;

  const requestQuote = useCallback(
    async (tn: Tenor) => {
      setTenor(tn);
      setNotice(null);
      resetAccept();
      const q = await runQuote(tn);
      if (q) setStep('quote');
    },
    [runQuote, resetAccept],
  );

  const started = useRef(false);
  useEffect(() => {
    if (initialTenor && !started.current) {
      started.current = true;
      void requestQuote(initialTenor);
    }
  }, [initialTenor, requestQuote]);

  const backToTenor = useCallback(() => {
    setStep('tenor');
    resetQuote();
    resetAccept();
  }, [resetQuote, resetAccept]);

  const expire = useCallback(() => {
    backToTenor();
    setNotice(t('errors.quote_expired'));
  }, [backToTenor, t]);

  useEffect(() => {
    if (acceptAction.status === 'error' && acceptAction.error instanceof ApiError && acceptAction.error.code === 'QUOTE_EXPIRED') expire();
  }, [acceptAction.status, acceptAction.error, expire]);

  const accept = async () => {
    if (!quote) return;
    const view = await acceptAction.run(quote.lock.id);
    if (view) onLocked(quote);
  };

  const tenorStep = (
    <div>
      <p className="text-ink-700">{t('comprador.lock.intro')}</p>
      {notice && (
        <p role="status" className="mt-3 rounded-lg border border-warn-500/40 bg-warn-100 px-3 py-2 text-sm text-warn-700">
          {notice}
        </p>
      )}
      <h3 className="mt-4 font-semibold text-ink-900">{t('comprador.lock.chooseTenor')}</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {(['mensual', 'trimestral'] as const).map((tn) => (
          <button
            key={tn}
            type="button"
            data-testid={`lock-tenor-${tn}`}
            aria-pressed={tenor === tn}
            disabled={quoteAction.busy}
            onClick={() => void requestQuote(tn)}
            className={`min-h-11 rounded-lg border-2 px-4 py-3 text-left transition-colors disabled:cursor-not-allowed ${tenor === tn ? 'border-brand-700 bg-brand-50' : 'border-ink-200 bg-white hover:border-brand-500'}`}
          >
            <span className="block font-semibold text-ink-900">{t(`comprador.lock.${tn}`)}</span>{' '}
            <span className="block text-sm text-ink-500">{t(`comprador.lock.${tn}Hint`)}</span>
          </button>
        ))}
      </div>
      {quoteAction.busy && <Spinner label={t('comprador.lock.quoting')} />}
      {quoteAction.status === 'error' && (
        <div className="mt-3">
          <ErrorState error={quoteAction.error} onRetry={tenor ? () => void requestQuote(tenor) : undefined} compact />
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button label={t('comprador.lock.cancelHint')} variant="secondary" data-testid="lock-cancel" onClick={onClose}>
          {t('comprador.lock.cancel')}
        </Button>
      </div>
    </div>
  );

  const quoteStep = quote && (
    <div>
      <div data-testid="lock-quote" className="rounded-xl border border-brand-200 bg-brand-50 p-5">
        <p className="text-lg font-semibold text-brand-900">{t('comprador.lock.headline', { usd: f.usd(quote.usdPerInstallment) })}</p>
        <dl className="mt-2 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <Row label={t('comprador.lock.perInstallment')} value={<span data-testid="lock-quote-usd">{f.usd(quote.usdPerInstallment)}</span>} />
          <Row label={t('comprador.lock.lockedRate')} value={<span data-testid="lock-quote-rate">{f.rate(quote.lockedRate)}</span>} />
          <Row
            label={t('comprador.lock.covers')}
            value={
              <ul className="space-y-0.5 text-sm">
                {quote.installments.map((i) => (
                  <li key={i.idx}>{t('comprador.lock.coverRow', { n: i.number, date: f.date(i.dueDate) })}</li>
                ))}
              </ul>
            }
          />
          <Row label={t('comprador.lock.total')} value={f.usd(quote.usdTotal)} hint={t('comprador.lock.atSpot', { rate: f.rate(quote.spot), usd: f.usd(quote.usdAtSpotTotal) })} />
        </dl>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-brand-200 pt-3 text-sm text-ink-700">
          <span>{t('comprador.lock.countdown')}</span>
          <Countdown expiresAt={quote.quoteExpiresAt} onExpire={expire} />
          <span className="basis-full text-ink-500 sm:basis-auto sm:ml-auto">{t('comprador.lock.cutoff', { date: f.date(quote.cutoffDate) })}</span>
        </div>
      </div>
      <section data-testid="lock-disclosures" aria-label={t('comprador.lock.disclosuresTitle')} className="mt-4 rounded-lg border border-ink-200 bg-ink-50 p-4 text-sm text-ink-700">
        <h3 className="mb-2 font-semibold text-ink-900">{t('comprador.lock.disclosuresTitle')}</h3>
        <ol className="list-decimal space-y-2 pl-5">
          <li>{t('comprador.lock.disclosure1')}</li>
          <li>{t('comprador.lock.disclosure2')}</li>
          <li>{t('comprador.lock.disclosure3')}</li>
        </ol>
      </section>
      {acceptAction.status === 'error' && (
        <div className="mt-3">
          <ErrorState error={acceptAction.error} compact />
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
        <Button label={t('comprador.lock.back')} variant="ghost" onClick={backToTenor} className="sm:mr-auto">
          {t('comprador.lock.back')}
        </Button>
        <Button label={t('comprador.lock.cancelHint')} variant="secondary" data-testid="lock-cancel" onClick={onClose}>
          {t('comprador.lock.cancel')}
        </Button>
        <Button label={t('comprador.lock.acceptHint')} data-testid="lock-accept" busy={acceptAction.busy} onClick={() => void accept()}>
          {t('comprador.lock.accept')}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal title={t('comprador.lock.title')} onClose={onClose} labelClose={t('common.close')} wide>
      {step === 'quote' && quote ? quoteStep : tenorStep}
    </Modal>
  );
}
