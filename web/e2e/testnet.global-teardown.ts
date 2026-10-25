// globalTeardown of the testnet Playwright run: stops the receiver and server that
// testnet.global-setup.ts started (a server that was already running is left alone).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { PIDS_FILE } from './testnet.global-setup';

export default function globalTeardown(): void {
  if (!existsSync(PIDS_FILE)) return;
  const pids = JSON.parse(readFileSync(PIDS_FILE, 'utf8')) as number[];
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
      else process.kill(-pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  rmSync(PIDS_FILE, { force: true });
}
