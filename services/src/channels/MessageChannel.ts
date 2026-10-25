// MessageChannel: the seam the real WhatsApp sender will implement. The demo ships OutboxChannel,
// which writes every message the system would send into the `wa_outbox` table (deterministic ids,
// demo timestamps, `simulated: true`). The body is rendered by an injected TemplateRenderer: the
// web app passes `dictionaryRenderer` over its i18n dictionaries (`whatsapp.<template>.body`), the
// services default to `plainRenderer`. A body over 1,024 characters is refused, never truncated, and
// a message carries exactly one deep link (`link`); a body that names a different link is refused.

import type { OutboxMessage, WhatsAppTemplate } from '../domain/types';
import type { Store } from '../store/Store';

export const MAX_BODY_CHARS = 1024;

export type MessageLocale = 'es' | 'en';

export type TemplateParams = Record<string, string | number>;

export type TemplateRenderer = (template: WhatsAppTemplate, locale: MessageLocale, params: TemplateParams) => string;

export type OutgoingMessage = Omit<OutboxMessage, 'id' | 'createdAt' | 'body' | 'channel' | 'simulated'> & { body?: string };

export interface MessageChannel {
  readonly name: string;
  send(msg: OutgoingMessage): Promise<OutboxMessage>;
}

export class MessageTooLongError extends Error {
  constructor(public readonly template: WhatsAppTemplate, public readonly length: number) {
    super(`rendered ${template} is ${length} characters; the limit is ${MAX_BODY_CHARS}`);
    this.name = 'MessageTooLongError';
  }
}

export class MessageLinkError extends Error {
  constructor(public readonly template: WhatsAppTemplate, message: string) {
    super(`${template}: ${message}`);
    this.name = 'MessageLinkError';
  }
}

/** `{name}` interpolation, the same as the web app's i18n (web/src/app/i18n.tsx). */
export function interpolate(template: string, params?: TemplateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
}

/** Dot-path lookup in a dictionary object, the same as the web app's i18n. */
export function lookup(dict: Record<string, unknown>, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[p];
    else return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Fallback renderer: the template name and its parameters, one per line (link last). */
export const plainRenderer: TemplateRenderer = (template, locale, params) => {
  const lines = Object.entries(params)
    .filter(([k]) => k !== 'link')
    .map(([k, v]) => `${k}: ${v}`);
  const link = params.link != null ? [`${String(params.link)}`] : [];
  return [`[${locale}] ${template}`, ...lines, ...link].join('\n');
};

/**
 * Renders `whatsapp.<template>.body` from the given dictionaries (es first, then en, then the plain
 * fallback), with the same interpolation the web app uses.
 */
export function dictionaryRenderer(dicts: Record<MessageLocale, unknown>): TemplateRenderer {
  return (template, locale, params) => {
    const key = `whatsapp.${template}.body`;
    const own = lookup(dicts[locale] as Record<string, unknown>, key);
    const fallback = own ?? lookup(dicts.es as Record<string, unknown>, key);
    return fallback ? interpolate(fallback, params) : plainRenderer(template, locale, params);
  };
}

/** The deep links a body may name; anything else that looks like one is refused. */
const DEEP_LINK = /#\/[\w/-]+/g;

export interface OutboxChannelOptions {
  store: Store;
  render?: TemplateRenderer;
  /** The demo timestamp (`today` plus the wall-clock time of day). */
  timestamp: () => Promise<string> | string;
}

export class OutboxChannel implements MessageChannel {
  readonly name = 'WhatsApp (simulado · bandeja de salida)';
  private readonly store: Store;
  private readonly render: TemplateRenderer;
  private readonly timestamp: () => Promise<string> | string;

  constructor(opts: OutboxChannelOptions) {
    this.store = opts.store;
    this.render = opts.render ?? plainRenderer;
    this.timestamp = opts.timestamp;
  }

  async send(msg: OutgoingMessage): Promise<OutboxMessage> {
    if (!msg.link) throw new MessageLinkError(msg.template, 'a message carries exactly one deep link');
    const params: TemplateParams = { ...msg.params, link: msg.link };
    const body = msg.body ?? this.render(msg.template, msg.locale, params);
    if (body.length > MAX_BODY_CHARS) throw new MessageTooLongError(msg.template, body.length);
    const links = new Set(body.match(DEEP_LINK) ?? []);
    if (links.size > 1 || (links.size === 1 && !links.has(msg.link))) throw new MessageLinkError(msg.template, `body names ${[...links].join(', ')}; the message link is ${msg.link}`);
    const existing = await this.store.all('wa_outbox');
    const seq = existing.filter((m) => m.planId === msg.planId && m.template === msg.template).length + 1;
    const out: OutboxMessage = {
      id: `wa-${msg.planId}-${msg.template}-${seq}`,
      planId: msg.planId,
      buyerId: msg.buyerId,
      to: msg.to,
      template: msg.template,
      locale: msg.locale,
      params,
      body,
      link: msg.link,
      createdAt: await this.timestamp(),
      channel: 'whatsapp',
      simulated: true,
    };
    await this.store.upsert('wa_outbox', out);
    return out;
  }
}

/** The deep link each template opens, by plan (and installment for receipts). */
export function deepLinkFor(template: WhatsAppTemplate, planId: string, idx?: number | null): string {
  switch (template) {
    case 'recordatorio':
    case 'referencia_moneygram':
    case 'pago_atrasado':
      return `#/c/${planId}/pagar`;
    case 'pago_recibido':
    case 'pago_entregado':
      return `#/c/${planId}/recibo/${idx ?? 0}`;
    case 'plan_en_pausa':
    case 'renovacion_bloqueo':
      return `#/comprador/${planId}`;
  }
}
