// Receipts list: every payment on the plan, newest first, each as a compact receipt row with its
// own technical-details toggle. The list keeps its own loading / error / empty states so a failure
// here never hides the calendar above it.

import type { Receipt } from '@casa-puente/services';
import type { AsyncState } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Card, EmptyState, ErrorState, Spinner } from '../../components/ui';
import { ReceiptView } from './ReceiptView';

export function ReceiptsList({ receipts, trust }: { receipts: AsyncState<Receipt[]>; trust: string }) {
  const t = useT();
  let body;
  if (receipts.status === 'error') body = <ErrorState error={receipts.error} onRetry={receipts.reload} />;
  else if (!receipts.data) body = <Spinner />;
  else if (receipts.data.length === 0) body = <EmptyState title={t('comprador.receipts.empty')} body={t('comprador.receipts.emptyBody')} />;
  else
    body = (
      <ol className="divide-y divide-ink-200">
        {receipts.data.map((r) => (
          <li key={r.id} data-testid={`receipt-row-${r.installmentIdx + 1}`} className="py-4 first:pt-0 last:pb-0">
            <ReceiptView receipt={r} trust={trust} variant="row" />
          </li>
        ))}
      </ol>
    );
  return (
    <Card title={t('comprador.receipts.title')}>
      <div data-testid="receipts-list">{body}</div>
    </Card>
  );
}
