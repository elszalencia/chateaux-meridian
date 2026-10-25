// Confirmation for the three irreversible desk actions (declare default, cancel plan, reject
// seller). Everything else opens in a drawer. The confirm button carries the action's own words;
// loading and error states stay inside the dialog until the action succeeds.

import type { ReactNode } from 'react';
import { useT } from '../../../app/i18n';
import { Button, ErrorState, Modal } from '../../../components/ui';

export function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
  error,
  children,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy: boolean;
  error: unknown;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <Modal title={title} onClose={onClose} labelClose={t('common.close')}>
      <div data-testid="confirm-modal" className="space-y-4">
        <p className="text-ink-700">{body}</p>
        {children}
        {error != null && <ErrorState error={error} compact />}
        <div className="flex justify-end gap-3">
          <Button label={t('common.cancel')} variant="secondary" onClick={onClose} disabled={busy} />
          <Button label={confirmLabel} variant="danger" onClick={onConfirm} busy={busy} data-testid="confirm-modal-ok" />
        </div>
      </div>
    </Modal>
  );
}
