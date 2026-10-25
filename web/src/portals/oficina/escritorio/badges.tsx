// Status vocabulary of the desk, one place for label and tone: plan status, seller verification,
// payout status, and the seller gate explained in plain words (why a release is held and what
// clears it).

import { ApiError, type PayoutStatus, type PlanDeskStatus, type SellerGateReason, type SellerVerificationStatus } from '@casa-puente/services';
import { Badge, type Tone } from '../../../components/ui';
import { useOT } from '../shared/i18n';

const PLAN_TONE: Record<PlanDeskStatus, Tone> = { activo: 'brand', atrasado: 'warn', en_mora: 'danger', en_pausa: 'info', cancelado: 'neutral', completado: 'brand' };
const SELLER_TONE: Record<SellerVerificationStatus, Tone> = { pending: 'warn', verified: 'brand', paused: 'info', rejected: 'danger' };
const PAYOUT_TONE: Record<PayoutStatus, Tone> = { enviado: 'info', en_transito: 'info', acreditado: 'brand', transferido: 'brand', error: 'danger', retenido: 'warn' };

export const PLAN_STATUSES: PlanDeskStatus[] = ['activo', 'atrasado', 'en_mora', 'en_pausa', 'cancelado', 'completado'];
export const SELLER_STATUSES: SellerVerificationStatus[] = ['pending', 'verified', 'paused', 'rejected'];
export const PAYOUT_STATUSES: PayoutStatus[] = ['enviado', 'en_transito', 'acreditado', 'error', 'transferido', 'retenido'];

export function PlanStatusBadge({ status }: { status: PlanDeskStatus }) {
  const ot = useOT();
  return (
    <Badge tone={PLAN_TONE[status]} className="whitespace-nowrap">
      <span data-status={status}>{ot(`planStatus.${status}`)}</span>
    </Badge>
  );
}

export function SellerStatusBadge({ status }: { status: SellerVerificationStatus }) {
  const ot = useOT();
  return (
    <Badge tone={SELLER_TONE[status]} className="whitespace-nowrap">
      <span data-status={status}>{ot(`sellerStatus.${status}`)}</span>
    </Badge>
  );
}

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  const ot = useOT();
  return (
    <Badge tone={PAYOUT_TONE[status]} className="whitespace-nowrap">
      <span data-status={status}>{ot(`payoutStatus.${status}`)}</span>
    </Badge>
  );
}

/** The gate reason behind a typed error code (`SELLER_COOLING_OFF` → `seller_cooling_off`), or null. */
export function gateReasonOf(e: unknown): SellerGateReason | null {
  if (!(e instanceof ApiError)) return null;
  const reason = e.code.toLowerCase();
  return reason === 'seller_unverified' || reason === 'seller_paused' || reason === 'seller_rejected' || reason === 'seller_cooling_off' || reason === 'cnr_alert' ? reason : null;
}

/** Why releases to a seller are held, and what clears the hold. */
export function GateNote({ reason, testId }: { reason: SellerGateReason; testId?: string }) {
  const ot = useOT();
  return (
    <div data-testid={testId} data-gate={reason} role="note" className="rounded-lg border border-warn-500/60 bg-warn-100 px-3 py-2 text-sm text-warn-700">
      <p className="font-semibold">{ot(`gate.${reason}.title`)}</p>
      <p className="mt-0.5">{ot(`gate.${reason}.body`)}</p>
    </div>
  );
}
