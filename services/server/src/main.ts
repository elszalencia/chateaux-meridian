// Entry point of the testnet server: `npx tsx services/server/src/main.ts` (started by
// `npm run demo:testnet` next to Vite). Holds every testnet secret, serves the demo API over HTTP
// on localhost:8787, runs the event indexer and the jobs, and checks at startup whether the seeded
// plans are still in the step-1 state.

import { configFromEnv, loadEnv } from './config';
import { startHttp } from './http';
import { TestnetService } from './service';

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg: string) => console.log(`${stamp()} ${msg}`);

async function main(): Promise<void> {
  const cfg = configFromEnv(loadEnv());
  const svc = new TestnetService(cfg, { log });
  const server = await startHttp(svc, cfg.host, cfg.port, log);
  log(`Casa Puente testnet server on http://${cfg.host}:${cfg.port} (contract ${cfg.chain.contractId}, channels ${cfg.chain.channelSecrets?.length ?? 0})`);
  log(`rails: on-ramp ${svc.onRamp?.name ?? 'mock'} · off-ramp ${svc.offRamp?.name ?? 'mock'}${svc.offRamp ? ` at ${cfg.offRampHomeUrl}` : ''}`);
  await svc.start();
  log(`jobs: ${svc.jobs.names().join(', ')} (manual trigger: POST /jobs/<name>/run)`);

  const shutdown = () => {
    log('stopping');
    svc.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e: unknown) => {
  console.error(`server failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
