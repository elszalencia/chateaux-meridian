// "Propiedad verificada · CNR": the seller passed verification and the unit's title check is clean,
// with the date of the certificate checked. A lien registered on the unit, or a seller still in
// verification, reads as "en revisión" instead. The registry feed is simulated, so it says so.

import type { PlanView } from '@casa-puente/services';
import { useFormat } from '../../app/format';
import { CheckIcon } from '../../views/comprador/shared';
import { usePortalT } from './copy';
import { SimBadge } from './SimBadge';

export function PropertyBadge({ seller }: { seller: NonNullable<PlanView['seller']> }) {
  const tp = usePortalT();
  const f = useFormat();
  const cnr = seller.cnr;
  const verified = seller.verificationStatus === 'verified' && cnr != null && cnr.alertStatus !== 'lien_registered';
  return (
    <div
      data-testid="property-badge"
      data-verified={verified ? 'true' : 'false'}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 ${verified ? 'border-brand-200 bg-brand-50 text-brand-900' : 'border-warn-500 bg-warn-100 text-warn-700'}`}
    >
      {verified && (
        <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-700 text-white">
          <CheckIcon className="h-4 w-4" />
        </span>
      )}
      <span className="font-semibold">{tp(verified ? 'property.verified' : 'property.inReview')}</span>
      {cnr && <span className="text-sm">{tp('property.checkedOn', { date: f.date(cnr.certDate) })}</span>}
      <SimBadge />
    </div>
  );
}
