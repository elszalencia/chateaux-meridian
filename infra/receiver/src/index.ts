// Entry point of the simulated receiving anchor: `tsx infra/receiver/src/index.ts`. Wires the
// configuration, the JSON stores, the HTTP routes and the Horizon watcher, and makes sure the
// receiver account exists on testnet with a USDC trustline before it advertises itself. The account
// bootstrap is retried in the background when Horizon is unreachable, so a flaky network delays the
// receiver instead of killing it; the HTTP server comes up right away either way.

import { Account, Asset, BASE_FEE, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { explorerAccountUrl } from '../../../services/src/chain/env.ts';
import { configFromEnv, loadEnv, RECEIVER_NAME, type ReceiverConfig } from './config.ts';
import { friendbot, HorizonClient } from './horizon.ts';
import { ok, Router, startServer } from './http.ts';
import { log, messageOf } from './log.ts';
import { buildChallenge, requireAuth, verifyChallenge, type Sep10Options } from './sep10.ts';
import { deleteCustomer, getCustomer, putCustomer } from './sep12.ts';
import { createTransaction, getTransaction, putCallback, sep31Info } from './sep31.ts';
import { getQuote, postQuote, sep38Info, sep38Price, sep38Prices } from './sep38.ts';
import { openStores, type Stores } from './store.ts';
import { stellarToml } from './toml.ts';
import { Watcher } from './watcher.ts';

const BOOTSTRAP_RETRY_MS = 10_000;

async function ensureAccount(cfg: ReceiverConfig, horizon: HorizonClient): Promise<void> {
  const pk = cfg.keypair.publicKey();
  let account = await horizon.account(pk);
  if (!account) {
    log(`account ${pk} is not on testnet yet, asking friendbot`);
    await friendbot(pk);
    account = await horizon.account(pk);
    if (!account) throw new Error(`friendbot returned but ${pk} is still unknown to Horizon`);
  }
  const hasTrustline = account.balances.some((b) => b.asset_code === 'USDC' && b.asset_issuer === cfg.usdcIssuer);
  if (!hasTrustline) {
    const tx = new TransactionBuilder(new Account(pk, account.sequence), { fee: BASE_FEE, networkPassphrase: cfg.networkPassphrase })
      .addOperation(Operation.changeTrust({ asset: new Asset('USDC', cfg.usdcIssuer) }))
      .setTimeout(60)
      .build();
    tx.sign(cfg.keypair);
    const { hash } = await horizon.submit(tx.toXDR());
    log(`trustline to USDC:${cfg.usdcIssuer} created in ${hash}`);
  }
  log(`receiver account ${pk} ready: ${explorerAccountUrl(pk)}`);
}

function buildRouter(cfg: ReceiverConfig, stores: Stores, horizon: HorizonClient): Router {
  const pk = cfg.keypair.publicKey();
  const sep10: Sep10Options = {
    serverKeypair: cfg.keypair,
    homeDomain: `${cfg.host}:${cfg.port}`,
    webAuthDomain: `${cfg.host}:${cfg.port}`,
    networkPassphrase: cfg.networkPassphrase,
    webAuthEndpoint: `${cfg.baseUrl}/auth`,
    jwtSecret: cfg.jwtSecret,
    loadSigners: async (account) => {
      const found = await horizon.account(account);
      return found ? { signers: found.signers, threshold: found.thresholds.med_threshold } : null;
    },
  };
  const auth = (req: Parameters<typeof requireAuth>[0]) => requireAuth(req, cfg.jwtSecret);
  const r = new Router();
  r.add('GET', '/health', () => ok({ status: 'ok', name: RECEIVER_NAME, account: pk, network: 'testnet', transactions: stores.transactions.size }));
  r.add('GET', '/.well-known/stellar.toml', () => ({ status: 200, text: stellarToml(cfg), contentType: 'text/plain; charset=utf-8' }));
  // SEP-10
  r.add('GET', '/auth', (req) => {
    const account = req.query.get('account');
    if (!account) return { status: 400, json: { error: 'account is required' } };
    return ok(buildChallenge(sep10, account, req.query.get('memo'), req.query.get('home_domain')));
  });
  r.add('POST', '/auth', async (req) => {
    const xdr = req.body.transaction;
    if (typeof xdr !== 'string' || !xdr) return { status: 400, json: { error: 'transaction is required' } };
    return ok(await verifyChallenge(sep10, xdr));
  });
  // SEP-12
  r.add('PUT', '/sep12/customer', (req) => putCustomer(stores.customers, auth(req), req.body));
  r.add('GET', '/sep12/customer', (req) => getCustomer(stores.customers, auth(req), req.query));
  r.add('DELETE', '/sep12/customer/:account', (req) => deleteCustomer(stores.customers, auth(req), req.params.account ?? '', req.query.get('memo')));
  // SEP-38
  r.add('GET', '/sep38/info', () => ok(sep38Info(cfg.usdcIssuer)));
  r.add('GET', '/sep38/prices', (req) => sep38Prices(req, cfg.usdcIssuer));
  r.add('GET', '/sep38/price', (req) => sep38Price(req, cfg.usdcIssuer));
  r.add('POST', '/sep38/quote', (req) => postQuote(stores.quotes, auth(req), req, cfg.usdcIssuer));
  r.add('GET', '/sep38/quote/:id', (req) => getQuote(stores.quotes, auth(req), req.params.id ?? '', cfg.usdcIssuer));
  // SEP-31
  r.add('GET', '/sep31/info', () => ok(sep31Info()));
  r.add('POST', '/sep31/transactions', (req) => createTransaction({ stores, auth: auth(req), body: req.body, receiverAccount: pk, usdcIssuer: cfg.usdcIssuer }));
  r.add('GET', '/sep31/transactions/:id', (req) => getTransaction(stores, auth(req), req.params.id ?? ''));
  r.add('PUT', '/sep31/transactions/:id/callback', (req) => putCallback(stores, auth(req), req.params.id ?? '', req.body));
  return r;
}

async function main(): Promise<void> {
  const cfg = configFromEnv(loadEnv());
  const pk = cfg.keypair.publicKey();
  log(`starting on ${cfg.baseUrl} (data in ${cfg.dataDir})`);
  if (cfg.ephemeralKey) {
    log('RECEIVER_SECRET is not set: generated a keypair for this run only. To keep the same account across restarts add this line to .env.testnet:');
    log(`RECEIVER_SECRET=${cfg.keypair.secret()}`);
  }
  log(`public key ${pk} (${explorerAccountUrl(pk)})`);

  const stores = openStores(cfg.dataDir);
  const horizon = new HorizonClient(cfg.horizonUrl);
  const server = await startServer(buildRouter(cfg, stores, horizon), cfg.host, cfg.port, (e) => log(`request failed: ${messageOf(e)}`));
  log(`listening; stellar.toml at ${cfg.baseUrl}/.well-known/stellar.toml`);

  const watcher = new Watcher({ horizon, stores, receiverAccount: pk, usdcIssuer: cfg.usdcIssuer, log });
  const bootstrap = async (): Promise<void> => {
    try {
      await ensureAccount(cfg, horizon);
      watcher.start();
      log('watching Horizon for incoming USDC payments');
    } catch (e) {
      log(`account bootstrap failed (${messageOf(e)}); retrying in ${BOOTSTRAP_RETRY_MS / 1000} s`);
      setTimeout(() => void bootstrap(), BOOTSTRAP_RETRY_MS);
    }
  };
  void bootstrap();

  const shutdown = (): void => {
    log('stopping');
    watcher.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  log(`fatal: ${messageOf(e)}`);
  process.exit(1);
});
