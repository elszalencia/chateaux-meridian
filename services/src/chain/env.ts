// Testnet configuration from environment variables, read only on the server side: the Node server
// (services/server), the deploy script and the other scripts parse the repo-root `.env.testnet`.
// None of these names carries the VITE_ prefix, so Vite never puts them in the browser bundle; the
// only VITE_ variable in that file is VITE_DEMO_MODE.

import { CORRIDORS, type CorridorId } from '../../../config/corridors';
import type { ChainClientConfig } from './client';

export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const FRIENDBOT_URL = 'https://friendbot.stellar.org';
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
/** Fee-paying channel accounts the deploy script creates (`CHANNEL_SECRET_1..N`). */
export const CHANNEL_COUNT = 8;

/**
 * Demo buyer id → suffix of its `BUYER_SECRET_*` / `BUYER_PUBLIC_*` variables, for every corridor.
 * `deploy:testnet` creates, funds and trustlines all of them; `deploy:sv` does the same for the
 * El Salvador buyers when it runs first.
 */
export const BUYER_ENV_KEYS: Record<string, string> = {
  'buyer-maria': 'MARIA',
  'buyer-andres': 'ANDRES',
  'buyer-camila': 'CAMILA',
  'buyer-roxana': 'ROXANA',
  'buyer-marvin': 'MARVIN',
  'buyer-doris': 'DORIS',
  'buyer-oscar': 'OSCAR',
};

/** Demo buyers whose accounts each corridor's contract instance uses (`chainConfigFor` requires their secrets). */
export const CORRIDOR_BUYERS: Readonly<Record<CorridorId, readonly string[]>> = {
  co: ['buyer-maria', 'buyer-andres', 'buyer-camila'],
  sv: ['buyer-roxana', 'buyer-marvin', 'buyer-doris', 'buyer-oscar'],
};

/**
 * Colombia demo plan id → suffix of its `CHAIN_PLAN_*` variable. Only these are seeded by
 * `deploy:testnet` on the Colombia instance; the El Salvador plans are in `SV_PLAN_ENV_KEYS` and
 * are seeded by the server's reset on the El Salvador instance.
 */
export const PLAN_ENV_KEYS: Record<string, string> = {
  'plan-maria': 'MARIA',
  'plan-andres': 'ANDRES',
  'plan-camila': 'CAMILA',
};

/** El Salvador demo plan id → suffix of its `CHAIN_PLAN_*` variable. */
export const SV_PLAN_ENV_KEYS: Record<string, string> = {
  'plan-roxana': 'ROXANA',
  'plan-marvin': 'MARVIN',
  'plan-doris': 'DORIS',
  'plan-oscar': 'OSCAR',
};

/** Every demo plan with a `CHAIN_PLAN_*` variable, both corridors. */
export const ALL_PLAN_ENV_KEYS: Record<string, string> = { ...PLAN_ENV_KEYS, ...SV_PLAN_ENV_KEYS };

export type EnvVars = Record<string, string | undefined>;

/** Minimal dotenv parser: `KEY=value` lines, `#` comments, optional single or double quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function required(env: EnvVars, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is not set; run \`npm run deploy:testnet\` (and \`npm run deploy:sv\` for the El Salvador instance) to write .env.testnet`);
  return v;
}

/**
 * Variables of `.env.testnet` files written before the server existed carried a VITE_ prefix.
 * The deploy script reads an old file through this map once and rewrites it with the new names.
 */
export function withoutVitePrefix(env: EnvVars): EnvVars {
  const out: EnvVars = {};
  for (const [k, v] of Object.entries(env)) if (k.startsWith('VITE_') && k !== 'VITE_DEMO_MODE') out[k.slice(5)] = v;
  return { ...out, ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('VITE_') || k === 'VITE_DEMO_MODE')) };
}

export function channelSecretsFromEnv(env: EnvVars): string[] {
  const out: string[] = [];
  for (let n = 1; n <= CHANNEL_COUNT; n += 1) {
    const v = env[`CHANNEL_SECRET_${n}`];
    if (v) out.push(v);
  }
  return out;
}

/**
 * Secrets of every demo buyer that has one in the environment. A corridor's own buyers are
 * required (`chainConfigFor`); the other corridor's are included when present so one ChainClient
 * can also mint test USDC to them.
 */
export function buyerSecretsFromEnv(env: EnvVars): Record<string, string> {
  const buyers: Record<string, string> = {};
  for (const [buyerId, suffix] of Object.entries(BUYER_ENV_KEYS)) {
    const v = env[`BUYER_SECRET_${suffix}`];
    if (v) buyers[buyerId] = v;
  }
  return buyers;
}

/**
 * ChainClient configuration of one corridor's payment_plan instance. The contract id and the payee
 * come from the variables `config/corridors.ts` names for the corridor (`chainEnv`); the operator,
 * the test USDC and the channel accounts are shared by every instance.
 */
export function chainConfigFor(corridor: CorridorId, env: EnvVars): ChainClientConfig {
  const keys = CORRIDORS[corridor].chainEnv;
  const buyers = buyerSecretsFromEnv(env);
  for (const buyerId of CORRIDOR_BUYERS[corridor]) if (!buyers[buyerId]) required(env, `BUYER_SECRET_${BUYER_ENV_KEYS[buyerId]}`);
  return {
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC_URL,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    contractId: required(env, keys.contractIdKey),
    usdcSacId: required(env, 'USDC_SAC_ID'),
    usdcIssuerSecret: required(env, 'USDC_ISSUER_SECRET'),
    operatorSecret: required(env, 'OPERATOR_SECRET'),
    buyers,
    payeeBackendPublic: required(env, keys.payeePublicKey),
    channelSecrets: channelSecretsFromEnv(env),
  };
}

/** The Colombia instance (the original, required configuration). */
export function chainConfigFromEnv(env: EnvVars): ChainClientConfig {
  return chainConfigFor('co', env);
}

/**
 * A corridor's instance when it has been deployed: null while its contract id variable is absent,
 * so the server can run with the Colombia instance alone and keep that corridor's plans off chain.
 * Any other missing variable is an error, not a silent downgrade.
 */
export function optionalChainConfigFor(corridor: CorridorId, env: EnvVars): ChainClientConfig | null {
  return env[CORRIDORS[corridor].chainEnv.contractIdKey] ? chainConfigFor(corridor, env) : null;
}

/** Chain plan ids written by the deploy scripts, keyed by demo plan id (both corridors); missing ones are skipped. */
export function chainPlansFromEnv(env: EnvVars): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [planId, suffix] of Object.entries(ALL_PLAN_ENV_KEYS)) {
    const v = env[`CHAIN_PLAN_${suffix}`];
    if (v && /^\d+$/.test(v)) out[planId] = Number(v);
  }
  return out;
}

export function explorerContractUrl(contractId: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${contractId}`;
}

export function explorerAccountUrl(publicKey: string): string {
  return `https://stellar.expert/explorer/testnet/account/${publicKey}`;
}

export function explorerTxUrl(txHash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${txHash}`;
}
