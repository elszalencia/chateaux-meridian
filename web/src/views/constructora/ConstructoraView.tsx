// Constructora / Fiducia: one project filter drives both the unit cards and the reconciliation
// table, so sales and the trust company look at the same slice of the portfolio. Both data sets
// are loaded once (no server-side filter) and filtered client-side, which keeps the filters instant
// and lets the empty states be exact. Loads refresh on the demo `version` (clock, reset, error mode).

import { useMemo, useState } from 'react';
import type { ReconStatus } from '@casa-puente/services';
import { api } from '../../app/api';
import { useDemo } from '../../app/demo';
import { useAsync } from '../../app/hooks';
import { useT } from '../../app/i18n';
import { Card, ErrorState, Spinner } from '../../components/ui';
import { UnitCards } from './UnitCards';
import { ReconTable } from './ReconTable';

const ALL = '__all__';
const STATUSES: ReconStatus[] = ['conciliado', 'pendiente', 'diferencia'];

export default function ConstructoraView() {
  const t = useT();
  const { version } = useDemo();
  const [project, setProject] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);

  const units = useAsync(() => api.getUnitSummaries(), [version]);
  const recon = useAsync(() => api.getReconciliation(), [version]);

  const projects = useMemo(() => {
    const names = new Set<string>();
    for (const u of units.data ?? []) names.add(u.unit.project);
    for (const r of recon.data ?? []) names.add(r.project);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [units.data, recon.data]);

  const filteredUnits = useMemo(() => (units.data ?? []).filter((u) => project === ALL || u.unit.project === project), [units.data, project]);
  const filteredRows = useMemo(
    () => (recon.data ?? []).filter((r) => (project === ALL || r.project === project) && (status === ALL || r.status === status)),
    [recon.data, project, status],
  );

  const selectClass = 'min-h-11 rounded-lg border border-ink-300 bg-white px-3 text-sm text-ink-900 focus:border-brand-500';

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-900">{t('constructora.title')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-ink-500">{t('constructora.subtitle')}</p>
        </div>
        <div role="group" aria-label={t('constructora.filters.region')} className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-ink-500">
            {t('constructora.filters.project')}
            <select
              data-testid="project-filter"
              aria-label={t('constructora.filters.project')}
              className={selectClass}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value={ALL}>{t('constructora.filters.allProjects')}</option>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium uppercase tracking-wide text-ink-500">
            {t('constructora.filters.status')}
            <select
              data-testid="status-filter"
              aria-label={t('constructora.filters.status')}
              className={selectClass}
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value={ALL}>{t('constructora.filters.allStatuses')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t('states.recon.' + s)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <Card
        title={t('constructora.units.title')}
        actions={units.data && <span className="tabular text-sm text-ink-500">{t('constructora.units.count', { n: filteredUnits.length })}</span>}
      >
        {units.loading && <Spinner />}
        {units.status === 'error' && <ErrorState error={units.error} onRetry={units.reload} />}
        {units.status === 'success' && <UnitCards units={filteredUnits} />}
      </Card>

      <Card
        title={t('constructora.recon.title')}
        actions={recon.data && <span className="tabular text-sm text-ink-500">{t('constructora.recon.count', { n: filteredRows.length })}</span>}
      >
        {recon.loading && <Spinner />}
        {recon.status === 'error' && <ErrorState error={recon.error} onRetry={recon.reload} />}
        {recon.status === 'success' && <ReconTable rows={filteredRows} />}
      </Card>
    </div>
  );
}
