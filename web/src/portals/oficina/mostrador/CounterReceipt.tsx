// Counter receipt: an 80 mm ticket (what the POS printer prints; the print stylesheet hides the
// rest of the page), "Enviar por WhatsApp" through the simulated channel, and "Siguiente cliente"
// back to an empty search. The ticket says when the money reaches the seller: on the due date for
// an installment paid ahead, or that it was sent when the release already ran.

import { CORRIDORS, type CounterSearchResult, type Office, type Payment, type Receipt } from '@casa-puente/services';
import { api } from '../../../app/api';
import { useFormat } from '../../../app/format';
import { useT } from '../../../app/i18n';
import { useAction } from '../../../app/hooks';
import { ErrorState, SpinnerIcon } from '../../../components/ui';
import { useOT } from '../shared/i18n';
import { useMoney } from '../shared/money';
import { MessageText } from '../shared/MessageText';
import { Simulado } from '../shared/Simulado';
import type { DueItem } from './BuyerCard';

const PRINT_CSS = `@media print {
  body * { visibility: hidden !important; }
  #counter-ticket, #counter-ticket * { visibility: visible !important; }
  #counter-ticket { position: absolute; left: 0; top: 0; width: 80mm; border: 0; box-shadow: none; }
  @page { size: 80mm auto; margin: 4mm; }
}`;

export function CounterReceipt({ result, item, payment, receipt, office, onNext }: { result: CounterSearchResult; item: DueItem; payment: Payment; receipt: Receipt; office: Office; onNext: () => void }) {
  const t = useT();
  const ot = useOT();
  const f = useFormat();
  const money = useMoney();
  const c = CORRIDORS[result.corridor];
  const send = useAction(() => api.sendReceiptMessage(result.plan.id, item.idx));
  const rows: [string, string][] = [
    [ot('mostrador.receipt.ticket'), payment.externalRef ?? payment.id],
    [ot('mostrador.receipt.date'), f.dateTime(payment.receivedAt ?? receipt.paidAt)],
    [ot('mostrador.receipt.buyer'), result.buyer.name],
    [ot('mostrador.receipt.plan'), result.plan.encargoRef],
    [ot('mostrador.receipt.unit'), result.unitLabel],
    [ot('mostrador.receipt.installment'), ot('mostrador.receipt.installmentValue', { n: item.number, date: f.date(item.dueDate) })],
    [t(c.payoutTargetKey), result.plan.trustCompany],
    [ot('mostrador.receipt.tender'), ot(`mostrador.pay.tenders.${payment.tender ?? 'cash'}`)],
    [ot('mostrador.receipt.paid'), money.usd(receipt.usdPaid)],
    [ot('mostrador.receipt.fee'), money.usd(receipt.feeUsd)],
  ];
  if (payment.tender === 'cash' && payment.amountReceived != null) {
    // Cash received and change are US cents in every corridor.
    rows.push([ot('mostrador.receipt.received'), money.cents(payment.amountReceived)]);
    rows.push([ot('mostrador.receipt.change'), money.cents(payment.changeDue ?? 0)]);
  }

  return (
    <section data-testid="counter-receipt" aria-labelledby="counter-receipt-title" className="rounded-2xl border border-ink-200 bg-white p-5 shadow-sm">
      <style>{PRINT_CSS}</style>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div role="status">
          <h3 id="counter-receipt-title" className="text-2xl font-semibold text-brand-800">
            {ot('mostrador.receipt.done')}
          </h3>
          <p className="mt-1 text-base text-ink-700">{ot('mostrador.receipt.doneBody', { name: result.buyer.name })}</p>
        </div>
      </div>

      <div className="mt-4 grid gap-5 md:grid-cols-[80mm_minmax(0,1fr)]">
        <article id="counter-ticket" data-testid="counter-ticket" aria-label={ot('mostrador.receipt.ticketLabel')} className="w-[80mm] max-w-full rounded-lg border border-dashed border-ink-300 bg-white p-4 font-mono text-[13px] leading-snug text-ink-900">
          <p className="text-center text-sm font-bold">{ot('mostrador.receipt.brand')}</p>
          <p className="text-center">{office.name}</p>
          <p className="text-center">
            {office.address}, {office.city} {office.state}
          </p>
          <hr className="my-2 border-dashed border-ink-300" />
          <dl>
            {rows.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <dt className="shrink-0">{k}</dt>
                <dd className="min-w-0 text-right">{v}</dd>
              </div>
            ))}
          </dl>
          <hr className="my-2 border-dashed border-ink-300" />
          <p data-testid="counter-ticket-delivered" className="flex justify-between gap-2 font-bold">
            <span>{ot('mostrador.receipt.toSeller')}</span>
            <span>{money.usd(receipt.usdDelivered ?? receipt.usdPaid - receipt.feeUsd)}</span>
          </p>
          <p className="mt-1">{receipt.payoutId ? ot('mostrador.receipt.released') : ot('mostrador.receipt.releaseOn', { date: f.date(item.dueDate) })}</p>
          <p className="mt-2 text-center">{ot('mostrador.receipt.thanks')}</p>
          <p className="mt-1 text-center">{ot('mostrador.receipt.simulatedTicket')}</p>
        </article>

        <div className="space-y-4">
          <button type="button" data-testid="receipt-print" onClick={() => window.print()} className="min-h-14 w-full rounded-xl border-2 border-brand-700 bg-white px-6 text-xl font-semibold text-brand-800 active:bg-brand-50">
            {ot('mostrador.receipt.print')}
          </button>
          <div className="space-y-2">
            <button
              type="button"
              data-testid="receipt-whatsapp"
              onClick={() => void send.run()}
              disabled={send.busy || send.status === 'success'}
              aria-busy={send.busy || undefined}
              className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border-2 border-brand-700 bg-white px-6 text-xl font-semibold text-brand-800 active:bg-brand-50 disabled:border-ink-300 disabled:text-ink-700"
            >
              {send.busy && <SpinnerIcon className="h-5 w-5" />}
              {send.status === 'success' ? ot('mostrador.receipt.whatsappSent') : ot('mostrador.receipt.whatsapp')}
              <Simulado />
            </button>
            {send.status === 'error' && <ErrorState error={send.error} onRetry={() => void send.run()} compact />}
            {send.result && (
              <div data-testid="receipt-whatsapp-preview" role="status" className="rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-700">
                <p>{ot('mostrador.receipt.whatsappTo', { to: send.result.to, template: ot(`outbox.template.${send.result.template}`), link: send.result.link })}</p>
                <MessageText message={send.result} />
              </div>
            )}
          </div>
          <button type="button" data-testid="next-customer" onClick={onNext} className="min-h-16 w-full rounded-xl bg-brand-700 px-6 text-2xl font-bold text-white active:bg-brand-800">
            {ot('mostrador.receipt.next')}
          </button>
        </div>
      </div>
    </section>
  );
}
