// Oficina · Mostrador: the counter. Placeholder until the counter build lands (search, buyer card,
// payment, receipt, shift total).

import { useT } from '../../../app/i18n';
import { EmptyState } from '../../../components/ui';

export default function MostradorView() {
  const t = useT();
  return (
    <div data-testid="mostrador">
      <EmptyState title={t('oficina.mostrador.title')} body={t('oficina.mostrador.placeholder')} />
    </div>
  );
}
