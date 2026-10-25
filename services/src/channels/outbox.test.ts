// The mock WhatsApp channel: deterministic ids, demo timestamps, rendering through the injected
// renderer, the 1,024-character limit (refused, never truncated) and the one-deep-link rule.
import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../store/MemoryStore';
import { emptySnapshot } from '../store/Store';
import { MAX_BODY_CHARS, MessageLinkError, MessageTooLongError, OutboxChannel, deepLinkFor, dictionaryRenderer, interpolate, lookup, plainRenderer, type OutgoingMessage } from './MessageChannel';

const STAMP = '2026-10-20T14:00:00.000Z';

function channel(render = plainRenderer) {
  const store = new MemoryStore(emptySnapshot());
  return { store, ch: new OutboxChannel({ store, render, timestamp: () => STAMP }) };
}

const reminder = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  planId: 'plan-x',
  buyerId: 'buyer-x',
  to: '+17035550187',
  template: 'recordatorio',
  locale: 'es',
  params: { name: 'Roxana', n: 6, usd: '750.00', date: '2026-10-24' },
  link: '#/c/plan-x/pagar',
  ...over,
});

describe('OutboxChannel', () => {
  it('writes wa_outbox rows with deterministic ids, the demo timestamp, channel whatsapp and simulated true', async () => {
    const { store, ch } = channel();
    const a = await ch.send(reminder());
    const b = await ch.send(reminder());
    const c = await ch.send(reminder({ template: 'pago_recibido', link: '#/c/plan-x/recibo/5' }));
    expect(a.id).toBe('wa-plan-x-recordatorio-1');
    expect(b.id).toBe('wa-plan-x-recordatorio-2');
    expect(c.id).toBe('wa-plan-x-pago_recibido-1');
    expect(a).toMatchObject({ createdAt: STAMP, channel: 'whatsapp', simulated: true, link: '#/c/plan-x/pagar', locale: 'es', to: '+17035550187' });
    expect(a.params.link).toBe('#/c/plan-x/pagar');
    expect(a.body).toContain('recordatorio');
    expect(a.body).toContain('usd: 750.00');
    expect(a.body.match(/#\//g)).toHaveLength(1);
    expect(await store.all('wa_outbox')).toHaveLength(3);
    expect(ch.name).toContain('simulado');
  });

  it('refuses a body over 1,024 characters instead of truncating it', async () => {
    const { ch } = channel();
    await expect(ch.send(reminder({ body: 'x'.repeat(MAX_BODY_CHARS) }))).resolves.toBeTruthy();
    await expect(ch.send(reminder({ body: 'x'.repeat(MAX_BODY_CHARS + 1) }))).rejects.toBeInstanceOf(MessageTooLongError);
    await expect(ch.send(reminder({ body: 'x'.repeat(MAX_BODY_CHARS + 1) }))).rejects.toThrow(/1025/);
  });

  it('carries exactly one deep link: a missing link or a body naming another link is refused', async () => {
    const { ch } = channel();
    await expect(ch.send(reminder({ link: '' }))).rejects.toBeInstanceOf(MessageLinkError);
    await expect(ch.send(reminder({ body: 'Paga aquí #/c/plan-x/pagar y aquí #/c/plan-y/pagar' }))).rejects.toBeInstanceOf(MessageLinkError);
    await expect(ch.send(reminder({ body: 'Paga aquí #/comprador/plan-x' }))).rejects.toBeInstanceOf(MessageLinkError);
    await expect(ch.send(reminder({ body: 'Paga aquí #/c/plan-x/pagar' }))).resolves.toMatchObject({ body: 'Paga aquí #/c/plan-x/pagar' });
    await expect(ch.send(reminder({ body: 'Sin enlace en el texto' }))).resolves.toMatchObject({ link: '#/c/plan-x/pagar' });
  });

  it('renders through the injected dictionary renderer with {name} interpolation and falls back per locale', async () => {
    const dicts = {
      es: { whatsapp: { recordatorio: { body: 'Hola {name}, tu cuota {n} de USD {usd} vence el {date}: {link}' } } },
      en: { whatsapp: {} },
    };
    const { ch } = channel(dictionaryRenderer(dicts));
    const es = await ch.send(reminder());
    expect(es.body).toBe('Hola Roxana, tu cuota 6 de USD 750.00 vence el 2026-10-24: #/c/plan-x/pagar');
    const en = await ch.send(reminder({ locale: 'en' }));
    expect(en.body).toBe(es.body); // en falls back to es
    const plain = await ch.send(reminder({ template: 'pago_atrasado' }));
    expect(plain.body.startsWith('[es] pago_atrasado')).toBe(true); // no dictionary entry: plain fallback
  });

  it('interpolate and lookup match the web app helpers', () => {
    expect(interpolate('{a} y {b} y {c}', { a: 1, b: 'dos' })).toBe('1 y dos y {c}');
    expect(interpolate('sin params')).toBe('sin params');
    expect(lookup({ a: { b: { c: 'x' } } }, 'a.b.c')).toBe('x');
    expect(lookup({ a: { b: 1 } }, 'a.b')).toBeUndefined();
    expect(lookup({}, 'a.b')).toBeUndefined();
  });

  it('deepLinkFor maps every template to its one screen', () => {
    expect(deepLinkFor('recordatorio', 'p')).toBe('#/c/p/pagar');
    expect(deepLinkFor('referencia_moneygram', 'p')).toBe('#/c/p/pagar');
    expect(deepLinkFor('pago_atrasado', 'p')).toBe('#/c/p/pagar');
    expect(deepLinkFor('pago_recibido', 'p', 5)).toBe('#/c/p/recibo/5');
    expect(deepLinkFor('pago_entregado', 'p', 5)).toBe('#/c/p/recibo/5');
    expect(deepLinkFor('plan_en_pausa', 'p')).toBe('#/comprador/p');
    expect(deepLinkFor('renovacion_bloqueo', 'p')).toBe('#/comprador/p');
  });
});
