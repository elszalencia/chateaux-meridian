// Buyer notices for adverse states: late inside grace, unpaid after grace, plan on hold, plan in
// default, plan cancelled. Each notice says what happened, in plain Spanish and without blame, and
// then what to do next. Plan-level notices come first; the colour is amber for "act soon" and
// neutral for "nothing to do yet", never red, and the words carry the meaning on their own.

import type { BuyerNotice, PlanView } from '@chateaux/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';

const TONE: Record<BuyerNotice['kind'], string> = {
  late_in_grace: 'border-warn-500 bg-warn-100',
  missed: 'border-warn-500 bg-warn-100',
  on_hold: 'border-ink-300 bg-white',
  defaulted: 'border-warn-500 bg-warn-100',
  cancelled: 'border-ink-300 bg-white',
};

export function AdverseNotices({ view }: { view: PlanView }) {
  const t = useT();
  const f = useFormat();
  const notices = view.governance.notices;
  if (notices.length === 0) return null;

  return (
    <section aria-label={t('comprador.notices.region')} data-testid="adverse-notices" className="space-y-3">
      {notices.map((n) => {
        const key = `comprador.notices.${n.kind}`;
        const vars = {
          n: n.installmentNumber ?? '',
          due: n.dueDate ? f.date(n.dueDate) : '',
          graceEnds: n.graceEnds ? f.date(n.graceEnds) : '',
          since: n.since ? f.date(n.since) : '',
          reason: t('reasons.' + n.reasonKey),
        };
        return (
          <article
            key={`${n.kind}-${n.installmentNumber ?? 'plan'}`}
            data-testid={`notice-${n.kind}`}
            className={`rounded-xl border-l-4 px-5 py-4 text-ink-900 ${TONE[n.kind]}`}
          >
            <h2 className="font-semibold">{t(`${key}.title`, vars)}</h2>
            <p className="mt-1 text-sm text-ink-700">{t(`${key}.body`, vars)}</p>
            {n.heldUsd != null && <p className="mt-1 text-sm text-ink-700">{t(`${key}.held`, { usd: f.usd(n.heldUsd) })}</p>}
            <p className="mt-2 text-sm">
              <span className="font-semibold">{t('comprador.notices.nextStep')}: </span>
              {t(`${key}.next`, vars)}
            </p>
          </article>
        );
      })}
    </section>
  );
}
