// Server configuration: the repo-root `.env.testnet` (written by `npm run deploy:testnet`) with
// `process.env` on top, key by key. Every Stellar secret of the demo is read here and stays in this
// process; the browser only ever talks to the HTTP API.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TESTNET_HORIZON_URL,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
  chainConfigFromEnv,
  chainPlansFromEnv,
  parseDotenv,
  type ChainClientConfig,
  type EnvVars,
} from '../../src/index';

/** Repo root: this file lives in services/server/src. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  chain: ChainClientConfig;
  chainPlans: Record<string, number>;
  /** First ledger the indexer reads when it has no cursor; 0 = the oldest the RPC still holds. */
  indexerStartLedger: number;
  indexerPollMs: number;
  /** `sep24` (SDF test anchor) or `mock`. */
  onRamp: 'sep24' | 'mock';
  onRampHomeDomain: string;
  /** `sep31` (receiving anchor at offRampHomeUrl) or `mock`. */
  offRamp: 'sep31' | 'mock';
  offRampHomeUrl: string;
  usdcIssuer: string;
  payeeBackendSecret: string;
  buyerSecrets: Record<string, string>;
  /** Seconds a payment waits for the indexer to see its release before answering. */
  receiptWaitMs: number;
}

export function loadEnv(file = path.join(REPO_ROOT, '.env.testnet')): EnvVars {
  if (!existsSync(file)) throw new Error(`${file} not found: run \`npm run deploy:testnet\` first`);
  return { ...parseDotenv(readFileSync(file, 'utf8')), ...process.env };
}

export function configFromEnv(env: EnvVars): ServerConfig {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set in .env.testnet; run \`npm run deploy:testnet\``);
    return v;
  };
  if (env.VITE_OPERATOR_SECRET && !env.OPERATOR_SECRET) {
    throw new Error('.env.testnet still uses the old VITE_-prefixed names; run `npm run deploy:testnet` once to migrate it');
  }
  const chain = chainConfigFromEnv(env);
  const onRamp = (env.ONRAMP || 'sep24') as ServerConfig['onRamp'];
  const offRamp = (env.OFFRAMP || 'sep31') as ServerConfig['offRamp'];
  if (onRamp !== 'sep24' && onRamp !== 'mock') throw new Error(`ONRAMP must be sep24 or mock, not ${onRamp}`);
  if (offRamp !== 'sep31' && offRamp !== 'mock') throw new Error(`OFFRAMP must be sep31 or mock, not ${offRamp}`);
  return {
    host: env.SERVER_HOST || 'localhost',
    port: Number(env.SERVER_PORT || 8787),
    dataDir: path.resolve(REPO_ROOT, env.SERVER_DATA_DIR || '.data/server'),
    rpcUrl: env.STELLAR_RPC_URL || TESTNET_RPC_URL,
    horizonUrl: env.HORIZON_URL || TESTNET_HORIZON_URL,
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    chain,
    chainPlans: chainPlansFromEnv(env),
    indexerStartLedger: Number(env.INDEXER_START_LEDGER || 0),
    indexerPollMs: Number(env.INDEXER_POLL_MS || 5_000),
    onRamp,
    onRampHomeDomain: env.ONRAMP_HOME_DOMAIN || 'testanchor.stellar.org',
    offRamp,
    offRampHomeUrl: env.OFFRAMP_HOME_URL || 'http://localhost:8788',
    usdcIssuer: need('USDC_ISSUER'),
    payeeBackendSecret: need('PAYEE_BACKEND_SECRET'),
    buyerSecrets: chain.buyers,
    receiptWaitMs: Number(env.RECEIPT_WAIT_MS || 45_000),
  };
}
