// Receipts for a corridor without an FX leg: newest first, each a compact receipt with its delivery
// status and a link that opens the full receipt (the same deep link the messages carry). Keeps its
// own loading, error and empty states so a failure here never hides the calendar.

import type { PayoutView, PlanView, Receipt } from '@casa-puente/services';
import type { AsyncState } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Button, Card, EmptyState, ErrorState, Spinner } from '../../components/ui';
import { usePortalT } from './copy';
import { CorridorReceipt } from './CorridorReceipt';

export function payoutFor(r: Receipt, payouts: PayoutView[] | null): PayoutView | null {
  if (!payouts) return null;
  return payouts.find((p) => (r.payoutId ? p.id === r.payoutId : p.receiptId === r.id)) ?? null;
}

export function ReceiptsPanel({
  view,
  receipts,
  payouts,
  onOpen,
}: {
  view: PlanView;
  receipts: AsyncState<Receipt[]>;
  payouts: AsyncState<PayoutView[]>;
  onOpen: (idx: number) => void;
}) {
  const t = useT();
  const tp = usePortalT();
  let body;
  if (receipts.status === 'error' && !receipts.data) body = <ErrorState error={receipts.error} onRetry={receipts.reload} />;
  else if (!receipts.data) body = <Spinner />;
  else if (receipts.data.length === 0) body = <EmptyState title={tp('receipts.empty')} body={tp('receipts.emptyBody')} />;
  else {
    const rows = [...receipts.data].sort((a, b) => b.paidAt.localeCompare(a.paidAt));
    body = (
      <ol className="divide-y divide-ink-200">
        {rows.map((r) => (
          <li key={r.id} data-testid={`receipt-row-${r.installmentIdx + 1}`} className="py-4 first:pt-0 last:pb-0">
            <CorridorReceipt receipt={r} view={view} payout={payoutFor(r, payouts.data)} variant="row" />
            <Button
              label={tp('receipts.open', { n: r.installmentIdx + 1 })}
              variant="secondary"
              data-testid={`receipt-open-${r.installmentIdx + 1}`}
              onClick={() => onOpen(r.installmentIdx)}
              className="mt-2 w-full sm:w-auto"
            >
              {tp('receipts.openShort')}
            </Button>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <Card title={t('comprador.receipts.title')}>
      {payouts.status === 'error' && receipts.data && receipts.data.length > 0 && (
        <div className="mb-3">
          <ErrorState error={payouts.error} onRetry={payouts.reload} compact />
        </div>
      )}
      <div data-testid="receipts-list">{body}</div>
    </Card>
  );
}
