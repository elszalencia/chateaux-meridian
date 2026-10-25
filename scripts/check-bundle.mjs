// `npm run check:bundle`: builds the web app in testnet mode (the mode that loads `.env.testnet`) and
// fails when the bundle could leak a key:
//  - any Stellar secret seed pattern (S + 55 base32 characters) in any emitted file;
//  - any secret value present in `.env.testnet`, matched literally (when the file exists);
//  - any variable name of a server-side secret (OPERATOR_SECRET, ...), which would mean the code
//    reads one in the browser.
// The scanner proves itself on a planted seed first, so a broken regex cannot pass silently.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'web', 'dist', 'bundle-check');
const SEED = /S[A-Z2-7]{55}/g;
const SECRET_NAMES = /\b(?:VITE_)?(?:OPERATOR_SECRET|PAYEE_BACKEND_SECRET|USDC_ISSUER_SECRET|RECEIVER_SECRET|BUYER_SECRET_[A-Z]+|CHANNEL_SECRET_\d+)\b/g;

// Self-test on a seed-shaped string built at runtime (never a real key).
const planted = `x${'S'}${'A'.repeat(55)}y`;
if (!planted.match(new RegExp(SEED.source))) {
  console.error('check:bundle self-test failed: the seed pattern does not match a planted seed');
  process.exit(2);
}

const envFile = path.join(root, '.env.testnet');
const secretValues = [];
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
    if (m && /SECRET/.test(m[1]) && m[2].length >= 20) secretValues.push([m[1], m[2]]);
  }
}

console.log(`building web (mode testnet) into ${path.relative(root, outDir)} …`);
rmSync(outDir, { recursive: true, force: true });
execSync(`npx vite build --mode testnet --outDir "${outDir}" --emptyOutDir`, { cwd: path.join(root, 'web'), stdio: ['ignore', 'ignore', 'inherit'] });

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

const problems = [];
let scanned = 0;
let bytes = 0;
for (const file of files(outDir)) {
  const text = readFileSync(file, 'latin1');
  scanned += 1;
  bytes += text.length;
  const rel = path.relative(root, file);
  for (const m of text.matchAll(SEED)) problems.push(`${rel}: secret-seed pattern at offset ${m.index}`);
  for (const [name, value] of secretValues) if (text.includes(value)) problems.push(`${rel}: contains the value of ${name}`);
  for (const m of text.matchAll(SECRET_NAMES)) problems.push(`${rel}: references ${m[0]}`);
}
rmSync(outDir, { recursive: true, force: true });

console.log(`scanned ${scanned} files (${(bytes / 1024).toFixed(0)} KiB); checked the seed pattern, ${secretValues.length} secret values from .env.testnet and the secret variable names`);
if (problems.length) {
  console.error(`check:bundle FAILED (${problems.length}):\n  ${problems.slice(0, 20).join('\n  ')}`);
  process.exit(1);
}
console.log('check:bundle passed: no key material in the web bundle');
