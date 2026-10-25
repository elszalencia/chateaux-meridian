// Criterion 13: every UI string comes from es.json / en.json, Spanish is the default, the two
// dictionaries have identical key sets, and every `t('...')` key used in the views resolves.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import es from '../i18n/es.json';
import en from '../i18n/en.json';
import { interpolate, lookup } from '../app/i18n';

type Dict = Record<string, unknown>;

function flatten(obj: Dict, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === 'object' && !Array.isArray(v) ? flatten(v as Dict, key) : [key];
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx?|json)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

function lookupAny(dict: Dict, key: string): unknown {
  let cur: unknown = dict;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Dict)[part];
  }
  return cur;
}

const SRC = path.resolve(__dirname, '..');

describe('i18n dictionaries', () => {
  it('es.json and en.json have identical key sets', () => {
    const a = flatten(es as Dict).sort();
    const b = flatten(en as Dict).sort();
    expect(a).toEqual(b);
  });

  it('Spanish is the default locale', () => {
    expect(lookup(es as Dict, '_meta.locale')).toBe('es-CO');
  });

  it('no partial dictionaries are left outside es.json / en.json', () => {
    const parts = path.join(SRC, 'i18n', 'parts');
    const leftovers = fs.existsSync(parts) ? fs.readdirSync(parts).filter((f) => f.endsWith('.json')) : [];
    expect(leftovers).toEqual([]);
  });

  it('every t("key") used in the app resolves in es.json; dynamic prefixes must name a namespace', () => {
    const files = walk(SRC).filter((f) => !f.includes(`${path.sep}i18n${path.sep}`) && !f.includes(`${path.sep}tests${path.sep}`));
    const missing: string[] = [];
    // Literal keys: t('a.b.c'). Dynamic keys: t(`a.b.${x}`) – the captured prefix ends with a dot.
    const re = /\bt\(\s*['"`]([\w.-]+)(?:['"`]|\$\{)/g;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(re)) {
        const key = m[1]!;
        const dynamic = key.endsWith('.');
        const target = lookupAny(es as Dict, dynamic ? key.slice(0, -1) : key);
        const ok = dynamic ? typeof target === 'object' && target !== null : typeof target === 'string';
        if (!ok) missing.push(`${path.relative(SRC, f)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('interpolation fills placeholders and leaves unknown ones visible', () => {
    expect(interpolate('Reiniciado en {seconds} s', { seconds: '0.30' })).toBe('Reiniciado en 0.30 s');
    expect(interpolate('{a} {b}', { a: 1 })).toBe('1 {b}');
  });
});
