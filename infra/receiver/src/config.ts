// Configuration of the simulated receiving anchor. The gitignored repo-root `.env.testnet` is read
// with the parser the services use, then `process.env` overrides it key by key, so a throwaway
// RECEIVER_SECRET can be passed on the command line without touching the file. The JWT secret
// defaults to a digest of the account secret: tokens survive a restart without one more variable.
// Nothing here writes to disk; a missing RECEIVER_SECRET is reported and replaced by a keypair for
// this run only, never saved.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@stellar/stellar-sdk';
import { parseDotenv, TESTNET_PASSPHRASE } from '../../../services/src/chain/env.ts';

export const RECEIVER_NAME = 'Ancla receptora simulada (Colombia)';
/** Repo root: this file lives in infra/receiver/src. */
export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

export type Env = Record<string, string | undefined>;

export interface ReceiverConfig {
  host: string;
  port: number;
  /** `http://host:port`, the base of every URL advertised in stellar.toml. */
  baseUrl: string;
  keypair: Keypair;
  /** True when RECEIVER_SECRET was missing and a keypair was generated for this run only. */
  ephemeralKey: boolean;
  jwtSecret: string;
  horizonUrl: string;
  networkPassphrase: string;
  usdcIssuer: string;
  dataDir: string;
}

/** `.env.testnet` (when present) with `process.env` on top. */
export function loadEnv(root = REPO_ROOT): Env {
  const file = resolve(root, '.env.testnet');
  const fromFile = existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {};
  return { ...fromFile, ...process.env };
}

export function configFromEnv(env: Env): ReceiverConfig {
  const host = env.RECEIVER_HOST || 'localhost';
  const port = Number(env.RECEIVER_PORT || 8788);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`RECEIVER_PORT is not a port: ${env.RECEIVER_PORT}`);
  const usdcIssuer = env.USDC_ISSUER || env.VITE_USDC_ISSUER;
  if (!usdcIssuer) throw new Error('USDC_ISSUER (or VITE_USDC_ISSUER) is not set; run `npm run deploy:testnet` to create .env.testnet');
  const ephemeralKey = !env.RECEIVER_SECRET;
  const keypair = env.RECEIVER_SECRET ? Keypair.fromSecret(env.RECEIVER_SECRET) : Keypair.random();
  const jwtSecret = env.RECEIVER_JWT_SECRET || createHash('sha256').update(`receiver-jwt:${keypair.secret()}`).digest('hex');
  return {
    host,
    port,
    baseUrl: `http://${host}:${port}`,
    keypair,
    ephemeralKey,
    jwtSecret,
    horizonUrl: (env.RECEIVER_HORIZON_URL || 'https://horizon-testnet.stellar.org').replace(/\/$/, ''),
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE || TESTNET_PASSPHRASE,
    usdcIssuer,
    dataDir: resolve(REPO_ROOT, env.RECEIVER_DATA_DIR || '.data/receiver'),
  };
}
