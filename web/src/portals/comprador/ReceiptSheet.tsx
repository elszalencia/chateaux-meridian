// One receipt, opened from a message link (#/c/<plan>/recibo/<idx>) or from the receipts list.
// Corridors that keep the lock screens show the original receipt unchanged; the others show the
// corridor's receipt fields with the delivery status.

import type { PayoutView, PlanView, Receipt } from '@casa-puente/services';
import type { AsyncState } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Button, EmptyState, ErrorState, Modal, Spinner } from '../../components/ui';
import { ReceiptView } from '../../views/comprador/ReceiptView';
import { usePortalT } from './copy';
import { CorridorReceipt } from './CorridorReceipt';
import { corridorOfView, keepsLockScreens } from './corridorUi';
import { payoutFor } from './ReceiptsPanel';

export function ReceiptSheet({
  view,
  idx,
  receipts,
  payouts,
  onClose,
}: {
  view: PlanView;
  idx: number;
  receipts: AsyncState<Receipt[]>;
  payouts: AsyncState<PayoutView[]>;
  onClose: () => void;
}) {
  const t = useT();
  const tp = usePortalT();
  const legacy = keepsLockScreens(corridorOfView(view));
  const receipt = receipts.data?.find((r) => r.installmentIdx === idx) ?? null;
  let body;
  if (receipts.status === 'error' && !receipts.data) body = <ErrorState error={receipts.error} onRetry={receipts.reload} />;
  else if (!receipts.data) body = <Spinner />;
  else if (!receipt) body = <EmptyState title={tp('receipts.missing', { n: idx + 1 })} body={tp('receipts.missingBody')} />;
  else if (legacy) body = <ReceiptView receipt={receipt} trust={view.plan.trustCompany} variant="full" withTestIds />;
  else body = <CorridorReceipt receipt={receipt} view={view} payout={payoutFor(receipt, payouts.data)} variant="full" withTestIds />;

  return (
    <Modal title={t('comprador.receipt.title', { n: idx + 1 })} onClose={onClose} labelClose={t('common.close')} wide>
      <div data-testid="receipt-sheet" data-idx={idx}>
        {body}
        <div className="mt-4 flex justify-end">
          <Button label={t('comprador.receipt.close')} data-testid="receipt-close" onClick={onClose} className="w-full sm:w-auto">
            {t('comprador.receipt.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
