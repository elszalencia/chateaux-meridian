// Testnet configuration from environment variables, read only on the server side: the Node server
// (services/server), the deploy script and the other scripts parse the repo-root `.env.testnet`.
// None of these names carries the VITE_ prefix, so Vite never puts them in the browser bundle; the
// only VITE_ variable in that file is VITE_DEMO_MODE.

import type { ChainClientConfig } from './client';

export const TESTNET_RPC_URL = 'https://soroban-testnet.stellar.org';
export const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';
export const FRIENDBOT_URL = 'https://friendbot.stellar.org';
export const TESTNET_HORIZON_URL = 'https://horizon-testnet.stellar.org';
/** Fee-paying channel accounts the deploy script creates (`CHANNEL_SECRET_1..N`). */
export const CHANNEL_COUNT = 8;

/** Demo buyer id → suffix of its `BUYER_SECRET_*` / `CHAIN_PLAN_*` variables. */
export const BUYER_ENV_KEYS: Record<string, string> = {
  'buyer-maria': 'MARIA',
  'buyer-andres': 'ANDRES',
  'buyer-camila': 'CAMILA',
};

/** Demo plan id → the buyer whose variables carry its chain plan id. */
export const PLAN_ENV_KEYS: Record<string, string> = {
  'plan-maria': 'MARIA',
  'plan-andres': 'ANDRES',
  'plan-camila': 'CAMILA',
};

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
  if (!v) throw new Error(`${key} is not set; run \`npm run deploy:testnet\` to create .env.testnet`);
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

export function chainConfigFromEnv(env: EnvVars): ChainClientConfig {
  const buyers: Record<string, string> = {};
  for (const [buyerId, suffix] of Object.entries(BUYER_ENV_KEYS)) buyers[buyerId] = required(env, `BUYER_SECRET_${suffix}`);
  return {
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC_URL,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    contractId: required(env, 'PAYMENT_PLAN_CONTRACT_ID'),
    usdcSacId: required(env, 'USDC_SAC_ID'),
    usdcIssuerSecret: required(env, 'USDC_ISSUER_SECRET'),
    operatorSecret: required(env, 'OPERATOR_SECRET'),
    buyers,
    payeeBackendPublic: required(env, 'PAYEE_BACKEND_PUBLIC'),
    channelSecrets: channelSecretsFromEnv(env),
  };
}

/** Chain plan ids written by the deploy script, keyed by demo plan id; missing ones are skipped. */
export function chainPlansFromEnv(env: EnvVars): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [planId, suffix] of Object.entries(PLAN_ENV_KEYS)) {
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
