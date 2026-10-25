// "simulado" marker for anything the demo simulates (cash network, title registry, agencies, bank debit).

import { Badge } from '../../components/ui';
import { usePortalT } from './copy';

export function SimBadge({ className = '' }: { className?: string }) {
  const tp = usePortalT();
  return (
    <Badge tone="warn" className={className}>
      {tp('simulated')}
    </Badge>
  );
}
