// `npm run infra:up`: starts the off-ramp counterparty on testnet.
//  - default: the simulated Colombian receiving anchor (infra/receiver, plain Node, port 8788);
//  - `-- --anchor-platform`: the Stellar Anchor Platform from infra/anchor-platform with Docker
//    Compose (not yet run on this project; see infra/anchor-platform/README.md). Point the server
//    at it with OFFRAMP_HOME_URL in .env.testnet: switching receivers is that one setting.
// `npm run demo:testnet` starts the Node receiver by itself when nothing answers on 8788, so this
// script is for running the counterparty on its own (logs in a separate terminal, the month
// simulation, the SEP-31 check script).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const useAp = process.argv.includes('--anchor-platform');

const [cmd, args] = useAp
  ? ['docker', ['compose', '-f', 'infra/anchor-platform/docker-compose.yml', '--env-file', 'infra/anchor-platform/dev.env', 'up']]
  : ['npx', ['tsx', 'infra/receiver/src/index.ts']];

console.log(useAp ? 'starting the Anchor Platform (Docker Compose)…' : 'starting the simulated receiving anchor on http://localhost:8788 …');
const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin });
child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
