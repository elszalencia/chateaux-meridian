// `npm run demo:testnet`: the testnet demo in one command.
//  1. the simulated Colombian receiving anchor on :8788 (unless one already answers, or OFFRAMP=mock);
//  2. the Casa Puente server on :8787, which holds every key (unless a testnet server already answers);
//  3. waits for the server's /health; when its startup check finds that the seeded plans were used
//     by an earlier run, it re-seeds them with a reset (skip with --no-auto-reset);
//  4. Vite in testnet mode on :5174, proxying /api to the server (--no-open to keep the browser closed).
// Ctrl+C stops everything this script started.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(root, '.env.testnet');
const argv = new Set(process.argv.slice(2));
const SERVER = 'http://localhost:8787';
const RECEIVER = 'http://localhost:8788';
const WEB_PORT = '5174';

if (!existsSync(envFile)) {
  console.error('.env.testnet not found: run `npm run deploy:testnet` first.');
  process.exit(1);
}
const envText = readFileSync(envFile, 'utf8');
if (/^VITE_OPERATOR_SECRET=/m.test(envText)) {
  console.error('.env.testnet uses the old VITE_-prefixed key names: run `npm run deploy:testnet` once to migrate it.');
  process.exit(1);
}
const offRampMock = (process.env.OFFRAMP || /^OFFRAMP=(.*)$/m.exec(envText)?.[1] || 'sep31') === 'mock';

const children = [];
const isWin = process.platform === 'win32';
function start(label, cmd, args) {
  const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => `[${label}] ${l}`)
      .join('\n');
  child.stdout.on('data', (c) => console.log(prefix(c)));
  child.stderr.on('data', (c) => console.error(prefix(c)));
  child.on('exit', (code) => {
    console.log(`[${label}] exited with ${code}`);
    stopAll(code ?? 0);
  });
  children.push(child);
  return child;
}

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode != null) continue;
    if (isWin) spawn('taskkill', ['/pid', String(c.pid), '/t', '/f'], { stdio: 'ignore' });
    else c.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

async function getJson(url, timeoutMs = 3_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitFor(url, check, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await getJson(url);
    if (body && check(body)) return body;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`${label} did not become healthy at ${url} within ${timeoutMs / 1000} s`);
}

try {
  if (!offRampMock) {
    if (await getJson(`${RECEIVER}/health`)) console.log(`receiving anchor already running at ${RECEIVER}`);
    else {
      start('receiver', 'npx', ['tsx', 'infra/receiver/src/index.ts']);
      await waitFor(`${RECEIVER}/health`, (b) => b.status === 'ok', 'receiving anchor');
    }
  }
  let health = await getJson(`${SERVER}/health`);
  if (health?.mode === 'testnet') console.log(`server already running at ${SERVER}`);
  else {
    if (health) throw new Error(`port 8787 answers but not as the testnet server (${JSON.stringify(health).slice(0, 120)})`);
    start('server', 'npx', ['tsx', 'services/server/src/main.ts']);
    health = await waitFor(`${SERVER}/health`, (b) => b.mode === 'testnet' && Array.isArray(b.plans), 'server');
  }
  if (health.needsReset && !argv.has('--no-auto-reset')) {
    console.log('the seeded plans were used by an earlier run: re-seeding them now (Reiniciar demo)…');
    const t0 = Date.now();
    const res = await fetch(`${SERVER}/api/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"args":[]}' });
    const body = await res.json();
    if (body.error) throw new Error(`reset failed: ${body.error.message}`);
    console.log(`reset done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const viteArgs = ['run', 'dev', '-w', 'web', '--', '--mode', 'testnet', '--port', WEB_PORT];
  if (!argv.has('--no-open')) viteArgs.push('--open');
  start('web', 'npm', viteArgs);
  console.log(`Casa Puente testnet demo: http://localhost:${WEB_PORT} (API ${SERVER})`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  stopAll(1);
}
