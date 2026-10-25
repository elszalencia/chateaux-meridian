// The visible "simulado" marker every simulated partner, network or channel carries on office screens.

import { useOT } from './i18n';

export function Simulado({ className = '' }: { className?: string }) {
  const ot = useOT();
  return (
    <span data-testid="simulado" className={`inline-flex items-center rounded-full border border-warn-500 bg-warn-100 px-2 py-0.5 text-xs font-semibold text-warn-700 ${className}`}>
      {ot('simulado')}
    </span>
  );
}
