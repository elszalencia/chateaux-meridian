// Name check: the product is Chateaux. Fails when the previous product name appears anywhere in the
// repository's files (tracked, or new and not ignored) outside the allowlist below, or when the old
// logo initials come back in web/. Git history is not scanned.
//
//   npm run check:names
//
// Exit code 0 when every hit is allowlisted; 1 otherwise. Allowlisted hits are listed, and the
// contract's are called out: they change with the next contract upload, not before (a change to
// contracts/payment_plan/src or its Cargo.toml changes the Wasm).

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The old name in any spelling: words, kebab, snake, camel, or split by punctuation. Built from its
// two words so this file never spells it.
const W1 = 'casa';
const W2 = 'puente';
const cap = (w: string): string => w[0]!.toUpperCase() + w.slice(1);
const OLD_NAME = new RegExp(`${W1}[\\s_.'"\`,:-]{0,3}${W2}|['"\`]${W1}['"\`].{0,40}['"\`]${W2}['"\`]`, 'i');
const OLD_TITLE = `${cap(W1)} ${cap(W2)}`;
const OLD_TAG = `${W1}-${W2}-final`;
// The old logo initials, as a word, in the web app.
const OLD_INITIALS = /\bCP\b/;

interface Allow {
  /** Path prefix (a directory ends with '/'). */
  path: string;
  /** When set, only lines matching it are allowed in that file. */
  line?: RegExp;
  why: string;
  /** Changes with the next contract upload. */
  contract?: boolean;
}

const ALLOW: Allow[] = [
  { path: 'README.md', line: new RegExp(`derived from ${OLD_TITLE} \\(tag ${OLD_TAG}\\)`), why: 'provenance' },
  { path: 'docs/STELLAR_NORMS.md', line: new RegExp(`carried over from ${OLD_TITLE} \\(tag ${OLD_TAG}\\)`), why: 'provenance' },
  { path: 'docs/chateaux-build-scope-v2.1.md', line: /^- .*\((?:[A-Z][a-z]{2} \d{1,2}, )?\d{4}\)/, why: 'dated source title' },
  { path: 'research/', why: 'research (dated, read only)' },
  { path: '_reference/', why: 'reference material (read only)' },
  { path: 'contracts/payment_plan/src/', why: 'contract source (Wasm)', contract: true },
  { path: 'contracts/payment_plan/Cargo.toml', why: 'contract manifest (Wasm)', contract: true },
];

function files(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return [...new Set(out.split('\0').filter(Boolean))].sort();
}

function allowFor(file: string, text: string): Allow | undefined {
  return ALLOW.find((a) => (a.path.endsWith('/') ? file.startsWith(a.path) : file === a.path) && (!a.line || a.line.test(text)));
}

const t0 = Date.now();
const violations: string[] = [];
const allowed: { hit: string; allow: Allow }[] = [];
let scanned = 0;
for (const file of files()) {
  let buf: Buffer;
  try {
    buf = readFileSync(path.join(ROOT, file));
  } catch {
    continue; // listed by git but deleted in the working tree
  }
  if (buf.includes(0)) continue; // binary
  scanned += 1;
  // The file name counts too (for example a migration named after the product).
  if (OLD_NAME.test(file)) {
    const allow = allowFor(file, '');
    if (allow && !allow.line) allowed.push({ hit: `${file} (file name)`, allow });
    else violations.push(`${file}: file name`);
  }
  const lines = buf.toString('utf8').split(/\r?\n/);
  lines.forEach((text, i) => {
    const initials = file.startsWith('web/') && OLD_INITIALS.test(text);
    if (!OLD_NAME.test(text) && !initials) return;
    const hit = `${file}:${i + 1}: ${text.trim().slice(0, 140)}`;
    const allow = initials ? undefined : allowFor(file, text);
    if (allow) allowed.push({ hit, allow });
    else violations.push(hit);
  });
}

for (const { hit, allow } of allowed.filter((a) => !a.allow.contract)) console.log(`allowed (${allow.why})  ${hit}`);
const contract = allowed.filter((a) => a.allow.contract);
if (contract.length > 0) {
  console.log('allowed until the next contract upload (rename these in the same change):');
  for (const { hit } of contract) console.log(`  ${hit}`);
}
const summary = `${scanned} files scanned, ${allowed.length} allowlisted hits, ${violations.length} outside the allowlist (${((Date.now() - t0) / 1000).toFixed(1)} s)`;
if (violations.length > 0) {
  for (const v of violations) console.error(`FAIL ${v}`);
  console.error(`check:names FAILED · ${summary}`);
  process.exit(1);
}
console.log(`check:names passed · ${summary}`);
