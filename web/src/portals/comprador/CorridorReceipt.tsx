// A receipt for a corridor without an FX leg: the shared ReceiptView with the rows the corridor's
// `receiptFields` list (USD paid, fee, USD to the seller, delivery status, method, seller, unit).
// The delivery status reads the linked payout: held (with its reason), sent, in transit, credited,
// delivered or failed; a receipt with no payout yet waits for the installment's due date.

import type { InstallmentView, PayoutView, PlanView, Receipt, ReceiptField } from '@chateaux/services';
import type { ReactNode } from 'react';
import { useFormat } from '../../app/format';
import { Badge, type Tone } from '../../components/ui';
import { Row } from '../../views/comprador/shared';
import { ReceiptView } from '../../views/comprador/ReceiptView';
import { usePortalT } from './copy';
import { corridorOfView } from './corridorUi';

type DeliveryKey = 'pending' | PayoutView['status'];

const DELIVERY_TONE: Record<DeliveryKey, Tone> = {
  pending: 'info',
  retenido: 'warn',
  enviado: 'info',
  en_transito: 'info',
  acreditado: 'brand',
  transferido: 'brand',
  error: 'danger',
};

export function deliveryOf(payout: PayoutView | null | undefined): DeliveryKey {
  return payout ? payout.status : 'pending';
}

/** One sentence on where the seller's money is. */
export function DeliveryText({ payout, installment }: { payout: PayoutView | null | undefined; installment: InstallmentView | undefined }) {
  const tp = usePortalT();
  const f = useFormat();
  const key = deliveryOf(payout);
  let text: string;
  if (!payout) text = installment ? tp('delivery.pendingOn', { date: f.date(installment.dueDate) }) : tp('delivery.pending');
  else if (payout.status === 'retenido') text = tp('delivery.retenido', { reason: tp(`holdReasons.${payout.holdReason ?? 'seller_unverified'}`) });
  else if (payout.status === 'acreditado' || payout.status === 'transferido') text = tp(`delivery.${payout.status}`, { date: f.date(payout.creditedAt ?? payout.sentAt ?? '') });
  else if (payout.status === 'en_transito' || payout.status === 'enviado')
    text = payout.expectedCreditDate ? tp(`delivery.${payout.status}By`, { date: f.date(payout.expectedCreditDate) }) : tp(`delivery.${payout.status}`);
  else text = tp('delivery.error');
  return <span data-delivery={key}>{text}</span>;
}

export function DeliveryBadge({ payout }: { payout: PayoutView | null | undefined }) {
  const tp = usePortalT();
  const key = deliveryOf(payout);
  return <Badge tone={DELIVERY_TONE[key]}>{tp(`deliveryBadge.${key}`)}</Badge>;
}

export function CorridorReceipt({
  receipt: r,
  view,
  payout,
  variant,
  withTestIds,
}: {
  receipt: Receipt;
  view: PlanView;
  payout: PayoutView | null | undefined;
  variant: 'full' | 'row';
  withTestIds?: boolean;
}) {
  const tp = usePortalT();
  const f = useFormat();
  const c = corridorOfView(view);
  const installment = view.installments.find((i) => i.idx === r.installmentIdx);
  const id = (s: string) => (withTestIds ? `receipt-${s}` : undefined);
  const usdToSeller = r.usdDelivered ?? Math.round((r.usdPaid - r.feeUsd) * 100) / 100;

  // usdPaid is the headline amount of every receipt, so it is not repeated as a row.
  const render: Partial<Record<ReceiptField, () => ReactNode>> = {
    fee: () => <Row key="fee" label={tp('receipt.fee')} value={f.usd(r.feeUsd)} testId={id('fee')} />,
    usdDelivered: () => <Row key="usdDelivered" label={tp('receipt.usdToSeller')} value={f.usd(usdToSeller)} testId={id('usd-to-seller')} />,
    payoutStatus: () => <Row key="payoutStatus" label={tp('receipt.delivery')} value={<DeliveryText payout={payout} installment={installment} />} testId={id('delivery')} />,
    method: () => <Row key="method" label={tp('receipt.method')} value={r.method ? tp(`methods.${r.method}.name`) : '—'} testId={id('method')} />,
    seller: () => <Row key="seller" label={tp('receipt.seller')} value={view.seller?.tradeName ?? view.plan.trustCompany} testId={id('seller')} />,
    unit: () => <Row key="unit" label={tp('receipt.unit')} value={tp('unitLabel', { unit: view.unit.unitName, project: view.unit.project })} testId={id('unit')} />,
  };
  const rows = c.receiptFields.map((field) => render[field]?.() ?? null);

  return (
    <ReceiptView
      receipt={r}
      trust={view.plan.trustCompany}
      variant={variant}
      withTestIds={withTestIds}
      rows={rows}
      badge={<DeliveryBadge payout={payout} />}
      showLockId={false}
    />
  );
}
