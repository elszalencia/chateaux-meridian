// Installment detail: the numbers behind one cell. The two rates sit side by side and the COP
// difference is signed from the buyer's point of view (positive = the secured rate is better than
// today's), with words rather than colour alone. Grace and break-cost rows appear only when they
// apply, so an open cell reads short and a broken one explains itself. An unpaid or waived cell
// says so in one sentence, with the next step, before the numbers.

import { GRACE_BUSINESS_DAYS, type InstallmentView } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Badge, Button, Modal } from '../../components/ui';
import { CELL_TONE, Row } from './shared';

export function InstallmentCard({ installment: i, onClose }: { installment: InstallmentView; onClose: () => void }) {
  const t = useT();
  const f = useFormat();
  const locked = i.status === 'locked' && i.lockedRate != null;
  const paid = i.status === 'released';
  const rateForUsd = locked || (paid && i.lockedRate != null) ? i.lockedRate : null;
  const usdValue = paid && i.usdDue != null ? i.usdDue : i.usdShown;

  return (
    <Modal title={t('comprador.card.title', { n: i.number })} onClose={onClose} labelClose={t('common.close')}>
      <div data-testid="cell-card">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Badge tone={CELL_TONE[i.cellState]}>{t('states.' + i.cellState)}</Badge>
          {i.isLate && <Badge tone="warn">{t(i.inGrace ? 'comprador.calendar.inGrace' : 'comprador.calendar.late')}</Badge>}
          {paid && i.releasedAt && <span className="text-sm text-ink-500">{t('comprador.card.paidOn', { date: f.date(i.releasedAt) })}</span>}
        </div>
        {i.cellState === 'no_pagado' && <p className="mb-3 text-sm text-ink-700">{t('comprador.card.missed')}</p>}
        {i.cellState === 'condonado' && <p className="mb-3 text-sm text-ink-700">{t('comprador.card.waived')}</p>}
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          <Row label={t('comprador.card.copDue')} value={f.cop(i.copDue)} />
          <Row label={t(rateForUsd != null ? 'comprador.card.usdLocked' : 'comprador.card.usdToday')} value={f.usd(usdValue)} />
          <Row label={t('comprador.card.todayRate')} value={f.rate(i.todayRate)} />
          <Row label={t('comprador.card.lockedRate')} value={rateForUsd != null ? f.rate(rateForUsd) : t('comprador.card.notLocked')} />
          <Row
            label={t('comprador.card.diff')}
            value={locked ? f.copSigned(i.diffCop) : t('comprador.card.diffNone')}
            hint={locked ? t(i.diffCop >= 0 ? 'comprador.card.diffFavor' : 'comprador.card.diffAgainst') : undefined}
          />
          <Row label={t('comprador.card.dueDate')} value={f.date(i.dueDate)} />
          {locked && i.lockExpiry && (
            <Row
              label={t('comprador.card.grace')}
              value={t('comprador.card.graceUntil', { date: f.date(i.lockExpiry), days: GRACE_BUSINESS_DAYS })}
              hint={i.isLate ? t(i.inGrace ? 'comprador.card.inGrace' : 'comprador.card.lateBy', { days: i.businessDaysLate }) : undefined}
            />
          )}
          {!locked && i.isLate && !paid && <Row label={t('common.status')} value={t('comprador.card.lateBy', { days: i.businessDaysLate })} />}
          {i.cellState === 'roto' && (
            <Row label={t('comprador.card.breakCost')} value={f.cop(i.breakCostCop ?? 0)} hint={t('comprador.card.breakHint')} />
          )}
        </dl>
        <div className="mt-4 flex justify-end">
          <Button label={t('comprador.card.close')} variant="secondary" data-testid="cell-card-close" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
