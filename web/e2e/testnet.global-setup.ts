// globalSetup of the testnet Playwright run (playwright.testnet.config.ts):
//  1. without .env.testnet or a healthy RPC it does nothing, and the spec skips itself;
//  2. reuses a server on :8787 only when /health says `mode: testnet` (anything else on the port
//     fails the run instead of testing the wrong thing);
//  3. with no server running: `npm run deploy:testnet` (idempotent: deploys or upgrades the contract
//     and seeds the plans), then starts the receiving anchor (:8788, unless one answers) and the
//     server, and waits for their health;
//  4. re-seeds the plans when the server's startup check says they were used (POST /api/reset).
// Vite (:5174) is Playwright's webServer; the spec checks /api/health through its proxy before the
// first step, so a Vite left running in mock mode is never reused. Processes started here are
// stopped by testnet.global-teardown.ts.
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = path.join(ROOT, '.env.testnet');
export const PIDS_FILE = path.join(ROOT, '.data', 'e2e-testnet-pids.json');
const SERVER = 'http://localhost:8787';
const RECEIVER = 'http://localhost:8788';
const isWin = process.platform === 'win32';

async function getJson(url: string, timeoutMs = 3_000): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function waitFor(url: string, ok: (b: Record<string, unknown>) => boolean, label: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await getJson(url);
    if (body && ok(body)) return body;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${label} did not become healthy at ${url} within ${timeoutMs / 1000} s`);
}

async function rpcHealthy(): Promise<boolean> {
  const rpc = /^STELLAR_RPC_URL=(\S+)/m.exec(readFileSync(ENV_FILE, 'utf8'))?.[1] ?? 'https://soroban-testnet.stellar.org';
  try {
    const res = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }) });
    return ((await res.json()) as { result?: { status?: string } }).result?.status === 'healthy';
  } catch {
    return false;
  }
}

function start(label: string, args: string[]): number {
  const child = spawn('npx', ['tsx', ...args], { cwd: ROOT, stdio: 'ignore', shell: isWin, detached: !isWin });
  child.unref();
  console.log(`[testnet setup] started ${label} (pid ${child.pid})`);
  return child.pid!;
}

export default async function globalSetup(): Promise<void> {
  if (!existsSync(ENV_FILE) || !(await rpcHealthy())) {
    console.log('[testnet setup] no .env.testnet or the RPC is unhealthy: the testnet spec will skip');
    return;
  }
  const pids: number[] = [];
  let health = await getJson(`${SERVER}/health`);
  if (health && health.mode !== 'testnet') throw new Error(`port 8787 answers but not as the testnet server (mode ${String(health.mode)}); stop it first`);
  if (health) console.log('[testnet setup] reusing the testnet server on :8787');
  else {
    const t0 = Date.now();
    execSync('npm run deploy:testnet', { cwd: ROOT, stdio: 'inherit' });
    console.log(`[testnet setup] deploy:testnet done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (!(await getJson(`${RECEIVER}/health`))) {
      pids.push(start('receiving anchor', ['infra/receiver/src/index.ts']));
      await waitFor(`${RECEIVER}/health`, (b) => b.status === 'ok', 'receiving anchor');
    }
    pids.push(start('server', ['services/server/src/main.ts']));
    health = await waitFor(`${SERVER}/health`, (b) => b.mode === 'testnet' && Array.isArray(b.plans), 'server');
  }
  writeFileSync(PIDS_FILE, JSON.stringify(pids));
  if (health.needsReset) {
    const t0 = Date.now();
    const res = await fetch(`${SERVER}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}' });
    const body = (await res.json()) as { error?: { message: string } };
    if (body.error) throw new Error(`reset failed: ${body.error.message}`);
    console.log(`[testnet setup] plans were used: re-seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
