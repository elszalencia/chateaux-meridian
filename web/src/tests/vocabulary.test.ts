// Criterion 12: buyer screens contain none of: wallet, USDC, token, blockchain, hash, Stellar.
// Scans the buyer view components, the shared shell and primitives rendered on buyer screens, and
// the dictionary namespaces those screens use (comprador, app, common, states, errors, demo,
// reasons, which the buyer's adverse-event notices quote, and whatsapp, the buyer's messages), in
// the merged dictionaries, so the namespace files in i18n/{es,en}/ are covered too.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DICTS } from '../app/i18n';

const FORBIDDEN = /\b(wallet|billetera|usdc|token|blockchain|hash|stellar|cripto|crypto)\b/i;
const SRC = path.resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

describe('no crypto vocabulary on buyer screens', () => {
  it('buyer components, shell and primitives', () => {
    const files = [
      ...walk(path.join(SRC, 'views', 'comprador')),
      ...walk(path.join(SRC, 'components')),
      path.join(SRC, 'App.tsx'),
    ];
    const hits: string[] = [];
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (FORBIDDEN.test(line)) hits.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('dictionary namespaces used by buyer screens (ES and EN)', () => {
    const namespaces = ['comprador', 'app', 'common', 'states', 'errors', 'demo', 'reasons', 'whatsapp'];
    const hits: string[] = [];
    for (const [lang, dict] of Object.entries(DICTS)) {
      for (const ns of namespaces) {
        const text = JSON.stringify((dict as Record<string, unknown>)[ns] ?? {});
        const m = FORBIDDEN.exec(text);
        if (m) hits.push(`${lang}.${ns}: "${m[0]}"`);
      }
    }
    expect(hits).toEqual([]);
  });
});
