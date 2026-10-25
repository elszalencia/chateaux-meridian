// SEP-38 quotes against the demo curve. The receiver sells pesos for USDC only, so every quote is
// USDC → COP at `spotAtOffset(offset)`, the same path the sending demo prints; the offset comes from
// the X-Demo-Clock-Offset header so both sides agree on which demo month it is. Amounts follow the
// lock engine: a COP target is covered by the smallest whole-cent USDC amount, a USDC amount buys
// whole pesos. `price` and `total_price` are sell units per buy unit as the SEP defines them (USDC
// per peso) and equal each other because the fee is zero; ten decimals keep the ratio meaningful.

import { randomUUID } from 'node:crypto';
import { spotAtOffset } from '../../../services/src/adapters/mockRuntime.ts';
import { roundCop, usdToCoverCop } from '../../../services/src/lock/engine.ts';
import { HttpError, ok, type Req, type Res } from './http.ts';
import type { Auth } from './sep10.ts';
import type { Collection, Quote } from './store.ts';

export const COP_ASSET = 'iso4217:COP';
export const usdcAsset = (issuer: string): string => `stellar:USDC:${issuer}`;
export const QUOTE_TTL_MS = 10 * 60 * 1000;
export const PRICE_DECIMALS = 10;

export interface PricedAmounts {
  sell_amount: string;
  buy_amount: string;
  price: string;
  total_price: string;
}

function parseAmount(value: unknown, name: string): number {
  const s = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(\.\d+)?$/.test(s) || Number(s) <= 0) throw new HttpError(400, { error: `${name} must be a positive decimal` });
  return Number(s);
}

/** USDC → COP amounts at `rate` (COP per USDC) from either side of the trade. */
export function priceUsdcToCop(rate: number, amounts: { sell_amount?: unknown; buy_amount?: unknown }): PricedAmounts {
  const hasSell = amounts.sell_amount !== undefined && amounts.sell_amount !== null;
  const hasBuy = amounts.buy_amount !== undefined && amounts.buy_amount !== null;
  if (hasSell === hasBuy) throw new HttpError(400, { error: 'exactly one of sell_amount or buy_amount is required' });
  let sell: string;
  let buy: string;
  if (hasBuy) {
    const cop = roundCop(parseAmount(amounts.buy_amount, 'buy_amount'));
    sell = usdToCoverCop(cop, rate).toFixed(2);
    buy = String(cop);
  } else {
    const usd = parseAmount(amounts.sell_amount, 'sell_amount');
    sell = String(amounts.sell_amount).trim();
    buy = String(roundCop(usd * rate));
  }
  if (Number(buy) <= 0) throw new HttpError(400, { error: 'amount too small to buy one peso' });
  const price = (Number(sell) / Number(buy)).toFixed(PRICE_DECIMALS);
  return { sell_amount: sell, buy_amount: buy, price, total_price: price };
}

/** Demo-month offset from the X-Demo-Clock-Offset header (default 0). */
export function demoOffset(req: Req): number {
  const raw = req.headers['x-demo-clock-offset'];
  if (raw === undefined || raw === '') return 0;
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, { error: 'X-Demo-Clock-Offset must be an integer number of months' });
  return Number(raw);
}

function assertPair(sell: unknown, buy: unknown, issuer: string): void {
  if (sell !== usdcAsset(issuer)) throw new HttpError(400, { error: `sell_asset must be ${usdcAsset(issuer)}` });
  if (buy !== undefined && buy !== null && buy !== COP_ASSET) throw new HttpError(400, { error: `buy_asset must be ${COP_ASSET}` });
}

export function sep38Info(issuer: string): Record<string, unknown> {
  return {
    assets: [
      { asset: usdcAsset(issuer) },
      { asset: COP_ASSET, country_codes: ['CO'], buy_delivery_methods: [{ name: 'ACH', description: 'Transferencia ACH al encargo fiduciario' }] },
    ],
  };
}

export function sep38Prices(req: Req, issuer: string): Res {
  const q = req.query;
  assertPair(q.get('sell_asset'), q.get('buy_asset') ?? undefined, issuer);
  const priced = priceUsdcToCop(spotAtOffset(demoOffset(req)), { sell_amount: q.get('sell_amount') ?? undefined });
  return ok({ buy_assets: [{ asset: COP_ASSET, price: priced.price, decimals: 7 }] });
}

export function sep38Price(req: Req, issuer: string): Res {
  const q = req.query;
  assertPair(q.get('sell_asset'), q.get('buy_asset'), issuer);
  if (q.get('buy_asset') !== COP_ASSET) throw new HttpError(400, { error: `buy_asset must be ${COP_ASSET}` });
  const priced = priceUsdcToCop(spotAtOffset(demoOffset(req)), { sell_amount: q.get('sell_amount') ?? undefined, buy_amount: q.get('buy_amount') ?? undefined });
  return ok({ ...priced, fee: { total: '0', asset: usdcAsset(issuer) } });
}

function projectQuote(quote: Quote, issuer: string): Record<string, unknown> {
  const { account: _account, created_at: _created, ...rest } = quote;
  return { ...rest, fee: { total: '0', asset: usdcAsset(issuer) } };
}

export function postQuote(quotes: Collection<Quote>, auth: Auth, req: Req, issuer: string, nowMs = Date.now()): Res {
  const b = req.body;
  assertPair(b.sell_asset, b.buy_asset, issuer);
  if (b.buy_asset !== COP_ASSET) throw new HttpError(400, { error: `buy_asset must be ${COP_ASSET}` });
  const priced = priceUsdcToCop(spotAtOffset(demoOffset(req)), { sell_amount: b.sell_amount, buy_amount: b.buy_amount });
  const expiresMs = nowMs + QUOTE_TTL_MS;
  if (typeof b.expire_after === 'string' && Date.parse(b.expire_after) > expiresMs) {
    throw new HttpError(400, { error: `quotes are firm for ${QUOTE_TTL_MS / 60000} minutes only; expire_after is too far ahead` });
  }
  const quote: Quote = {
    id: randomUUID(),
    account: auth.account,
    sell_asset: usdcAsset(issuer),
    buy_asset: COP_ASSET,
    ...priced,
    expires_at: new Date(expiresMs).toISOString(),
    created_at: new Date(nowMs).toISOString(),
  };
  quotes.put(quote);
  return ok(projectQuote(quote, issuer), 201);
}

export function getQuote(quotes: Collection<Quote>, auth: Auth, id: string, issuer: string): Res {
  const quote = quotes.get(id);
  if (!quote || quote.account !== auth.account) throw new HttpError(404, { error: 'quote not found' });
  return ok(projectQuote(quote, issuer));
}
