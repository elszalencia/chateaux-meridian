// Office namespace guards: ES and EN have the same keys; every `ot('…')` key used by the office
// components resolves in both; USDC appears only in Vendedores and Pagos al vendedor; no component
// branches on a country literal (criterion 5); no hard-coded country names in the office code.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import es from '../../i18n/es/oficina.json';
import en from '../../i18n/en/oficina.json';
import { DICTS, lookup } from '../../app/i18n';

type Dict = Record<string, unknown>;
const DIR = __dirname;

function flatten(obj: Dict, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' ? flatten(v as Dict, key) : [key];
  });
}

function sources(dir = DIR, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && e.name !== 'testing.tsx') out.push(p);
  }
  return out;
}

describe('oficina dictionaries', () => {
  it('ES and EN have identical key sets', () => {
    expect(flatten(es as Dict).sort()).toEqual(flatten(en as Dict).sort());
  });

  it('every ot() key used in the office components resolves in ES and EN', () => {
    const missing: string[] = [];
    const re = /\bot\(\s*['"`]([\w.-]+)(?:['"`]|\$\{)/g;
    for (const f of sources()) {
      for (const m of fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '').matchAll(re)) {
        const key = `oficina.${m[1]!}`;
        for (const lang of ['es', 'en'] as const) {
          const ok = key.endsWith('.') ? flatten(DICTS[lang] as Dict).some((k) => k.startsWith(key)) : lookup(DICTS[lang] as Dict, key) !== undefined;
          if (!ok) missing.push(`${lang}: ${path.relative(DIR, f)}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('USDC appears only under Vendedores and Pagos al vendedor', () => {
    for (const dict of [es, en]) {
      const hits = flatten(dict as Dict).filter((k) => /usdc/i.test(String(lookup(dict as Dict, k))));
      expect(hits.every((k) => k.startsWith('oficina.vendedores.') || k.startsWith('oficina.pagos.'))).toBe(true);
    }
    const files = sources().filter((f) => /usdc/i.test(fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, '')));
    expect(files.map((f) => path.relative(DIR, f))).toEqual([]);
  });

  it('no office component names a country (no branching on SV/CO literals)', () => {
    const hits: string[] = [];
    for (const f of sources()) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
          if (/['"`](SV|CO|sv|co)['"`]|El Salvador|Colombia/.test(line)) hits.push(`${path.relative(DIR, f)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('every simulated partner label in the office dictionary says so', () => {
    for (const [dict, word] of [[es, 'simulado'], [en, 'simulated']] as const) {
      const d = dict as Dict;
      expect(lookup(d, 'oficina.simulado')).toBe(word);
      expect(lookup(d, 'oficina.mostrador.receipt.simulatedTicket')).toContain(word);
      expect(lookup(d, 'oficina.pagos.partner')).toContain(word);
    }
  });
});