// A WhatsApp message as office staff read it. With template text, the rendered body. Without it
// (this build has no WhatsApp templates, so the services fall back to a plain body), the template's
// name in plain words and its parameters as a short list, never the raw fallback body.

import { Fragment } from 'react';
import { isPlainBody, type OutboxMessage } from '@chateaux/services';
import { useFormat } from '../../../app/format';
import { useT } from '../../../app/i18n';
import { useOT } from './i18n';
import { useMoney } from './money';

export function MessageText({ message }: { message: OutboxMessage }) {
  const t = useT();
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  if (!isPlainBody(message)) {
    return <p className="mt-2 whitespace-pre-line text-ink-900">{message.body}</p>;
  }
  const value = (key: string, v: string | number): string => {
    if (key === 'usd') return money.usd(Number(v));
    if (key === 'date' || key === 'since' || key === 'graceEnds') return f.date(String(v));
    if (key === 'expiresAt') return f.dateTime(String(v));
    if (key === 'reason') return t(`reasons.${v}`);
    return String(v);
  };
  const params = Object.entries(message.params).filter(([k]) => k !== 'link');
  return (
    <div data-testid="message-summary" className="mt-2 text-ink-900">
      <p className="font-semibold">{ot('outbox.summary', { template: ot(`outbox.template.${message.template}`) })}</p>
      {params.length > 0 && (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5">
          {params.map(([k, v]) => (
            <Fragment key={k}>
              <dt className="text-ink-700">{ot(`outbox.params.${k}`)}</dt>
              <dd data-param={k}>{value(k, v)}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}
