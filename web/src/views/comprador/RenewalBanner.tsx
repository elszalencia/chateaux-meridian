// Renewal banner: shown only while the plan has an active renewal offer. It names the installment
// where the current securing ends and the quarter on offer, and its button opens the lock flow
// with "Trimestral" preselected. Nothing is renewed without the buyer pressing the button.

import type { PlanView } from '@chateaux/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Button } from '../../components/ui';

export function RenewalBanner({ view, onAccept }: { view: PlanView; onAccept: () => void }) {
  const t = useT();
  const f = useFormat();
  const offer = view.activeOffer;
  if (!offer || offer.idxs.length === 0) return null;
  const first = offer.idxs[0]!;
  const last = offer.idxs[offer.idxs.length - 1]!;
  const previous = view.installments.find((i) => i.idx === first - 1 && i.lockId != null);
  const params = { from: first + 1, to: last + 1 };

  return (
    <div role="region" aria-label={t('comprador.renewal.button')} data-testid="renewal-banner" className="flex flex-col gap-3 rounded-xl border border-brand-200 bg-brand-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-ink-900">
        {previous
          ? t('comprador.renewal.text', { ...params, n: previous.number, date: f.date(previous.dueDate) })
          : t('comprador.renewal.textNoPrevious', params)}
      </p>
      <Button label={t('comprador.renewal.buttonHint', params)} data-testid="renewal-accept" onClick={onAccept} className="shrink-0">
        {t('comprador.renewal.button')}
      </Button>
    </div>
  );
}
