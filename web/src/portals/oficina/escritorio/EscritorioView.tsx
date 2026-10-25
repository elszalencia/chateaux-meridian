// Oficina · Escritorio: the desk. Placeholder until the desk build lands (planes, vendedores, pagos
// al vendedor, outbox).

import { useT } from '../../../app/i18n';
import { EmptyState } from '../../../components/ui';

export default function EscritorioView() {
  const t = useT();
  return (
    <div data-testid="escritorio">
      <EmptyState title={t('oficina.escritorio.title')} body={t('oficina.escritorio.placeholder')} />
    </div>
  );
}
