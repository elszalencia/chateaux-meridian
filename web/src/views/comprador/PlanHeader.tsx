// Plan header: who, which unit, and the three numbers the buyer cares about (next payment, whether
// its rate is secured, pesos protected this year), followed by the three actions. The primary
// action is always "Pagar"; it stays visible but disabled before the due date with the date it
// opens, so the demo clock advance has a visible effect. While the plan is on hold, in default or
// cancelled, every money action is disabled and one line points to the notice that explains why.

import { yearOf, type PlanView } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { useT } from '../../app/i18n';
import { Badge, Button, Card, Stat } from '../../components/ui';

export function PlanHeader({
  view,
  refreshing,
  onPay,
  onLock,
  onPayAhead,
}: {
  view: PlanView;
  refreshing: boolean;
  onPay: (idx: number) => void;
  onLock: () => void;
  onPayAhead: () => void;
}) {
  const t = useT();
  const f = useFormat();
  const { unit, plan, buyer, summary } = view;
  const next = summary.nextInstallment;
  const blocked = view.governance.fundsBlocked;
  const year = yearOf(view.today);
  const protectedCount = view.installments.filter(
    (i) => yearOf(i.dueDate) === year && (i.status === 'locked' || (i.status === 'released' && i.lockId && i.lockedRate != null)),
  ).length;

  return (
    <Card as="section" className="relative">
      {refreshing && (
        <span role="status" className="absolute right-5 top-5 text-xs text-ink-500">
          {t('comprador.header.updating')}
        </span>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div>
          <p className="text-sm text-ink-500">{t('comprador.header.buyerLine', { name: buyer.name, city: buyer.city })}</p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-900">{t('comprador.header.unitLine', { unit: unit.unitName, project: unit.project, city: unit.city })}</h1>
          <p className="mt-1 text-sm text-ink-700">{t('comprador.header.encargo', { ref: plan.encargoRef, trust: plan.trustCompany })}</p>
          <p className="mt-1 text-sm text-ink-500">
            {t(unit.priceBasis === 'SMMLV' ? 'comprador.header.priceLine' : 'comprador.header.priceLineFixed', { price: f.cop(unit.priceCop), housingType: unit.housingType })}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-3 lg:min-w-[640px]">
          <Stat
            label={t('comprador.header.nextPayment')}
            value={next ? <span data-testid="next-payment-usd">{f.usd(next.usdShown)}</span> : <span data-testid="next-payment-usd">—</span>}
            hint={
              next ? (
                <>
                  <span data-testid="next-payment-cop">{f.cop(next.copDue)}</span>
                  {' · '}
                  <span data-testid="next-due">{t('comprador.header.nextDue', { date: f.date(next.dueDate) })}</span>
                  {' · '}
                  {t('comprador.header.nextInstallment', { n: next.number })}
                </>
              ) : (
                t('comprador.header.allPaid')
              )
            }
          />
          <Stat
            label={t('comprador.header.lockStatus')}
            value={
              <Badge tone={summary.nextIsLocked ? 'brand' : 'neutral'} className="text-sm">
                <span data-testid="lock-status">{t(summary.nextIsLocked ? 'comprador.header.locked' : 'comprador.header.unlocked')}</span>
              </Badge>
            }
            hint={
              summary.nextIsLocked && next?.lockedRate != null
                ? t('comprador.header.lockedHint', { rate: f.rate(next.lockedRate) })
                : t('comprador.header.unlockedHint', { rate: f.rate(view.spot) })
            }
          />
          <Stat
            label={t('comprador.header.protected')}
            value={<span data-testid="protected-cop">{f.cop(summary.protectedCopThisYear)}</span>}
            hint={t('comprador.header.protectedHint', { count: protectedCount, year })}
          />
        </div>
      </div>
      <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {next && (
          <div className="flex flex-col gap-1">
            <Button
              label={t('comprador.actions.payHint', { n: next.number, usd: f.usd(next.usdShown) })}
              data-testid="pay-button"
              disabled={!next.payable}
              onClick={() => onPay(next.idx)}
              className="w-full sm:w-auto"
            >
              {t('comprador.actions.pay', { usd: f.usd(next.usdShown) })}
            </Button>
            {!next.payable && !blocked && next.status !== 'missed' && (
              <p className="text-xs text-ink-500">{t('comprador.actions.payUnavailable', { date: f.date(next.dueDate) })}</p>
            )}
          </div>
        )}
        <Button label={t('comprador.actions.lockHint')} variant="secondary" data-testid="lock-open" disabled={blocked} onClick={onLock} className="w-full sm:w-auto">
          {t('comprador.actions.lock')}
        </Button>
        <Button label={t('comprador.actions.payAheadHint')} variant="ghost" data-testid="pay-ahead-button" disabled={blocked} onClick={onPayAhead} className="w-full sm:w-auto">
          {t('comprador.actions.payAhead')}
        </Button>
      </div>
      {blocked && (
        <p data-testid="actions-blocked" className="mt-3 text-sm text-ink-700">
          {t('comprador.actions.blocked')}
        </p>
      )}
    </Card>
  );
}
