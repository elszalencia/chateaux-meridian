// Strings and vocabulary for the buyer portal (criteria 4, 5 and 13): every key the portal asks for
// resolves in Spanish and English through the merged dictionaries, the two comprador namespace
// files have the same keys, and neither the portal's files nor its strings contain the words buyer
// screens never show, or a country literal used for branching.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DICTS, lookup } from '../../app/i18n';
import es from '../../i18n/es/comprador.json';
import en from '../../i18n/en/comprador.json';
import { PORTAL_PREFIX } from './copy';

type Dict = Record<string, unknown>;
const HERE = __dirname;
const FORBIDDEN = /\b(wallet|billetera|usdc|token|blockchain|hash|stellar|cripto|crypto)\b/i;
const COUNTRY = /['"`](SV|CO|El Salvador|Colombia)['"`]/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

function flatten(obj: Dict, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v as Dict, prefix ? `${prefix}.${k}` : k) : [prefix ? `${prefix}.${k}` : k]));
}

function node(dict: Dict, key: string): unknown {
  return key.split('.').reduce<unknown>((cur, p) => (cur && typeof cur === 'object' ? (cur as Dict)[p] : undefined), dict);
}

const files = walk(HERE);

describe('buyer portal strings', () => {
  it('every tp() key resolves in ES and EN (dynamic keys name an existing group)', () => {
    const missing: string[] = [];
    let checked = 0;
    const call =/\btp\(([^;]*?)\)/g;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      for (const m of src.matchAll(call)) {
        // The key is the first argument (a literal, a template, or a ternary of literals); what is
        // inside `${...}` is a runtime segment, not a key.
        const args = m[1]!.split(/,\s*\{/)[0]!.replace(/\$\{[^}]*\}/g, '${}');
        for (const lit of args.matchAll(/(['"`])([a-zA-Z][\w]*(?:\.[\w]+)*\.?)(\$\{|\1)/g)) {
          const key = lit[2]!;
          const dynamic = lit[3] === '${';
          if (!dynamic && !key.includes('.') && !/^[a-z]\w*$/i.test(key)) continue;
          for (const lang of ['es', 'en'] as const) {
            const full = PORTAL_PREFIX + (dynamic ? key.replace(/\.$/, '') : key);
            const ok = dynamic ? typeof node(DICTS[lang], full) === 'object' : lookup(DICTS[lang], full) !== undefined;
            if (!ok) missing.push(`${lang} ${path.relative(HERE, f)}: ${full}`);
            checked += 1;
          }
        }
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(200);
  });

  it('every t() key the portal uses resolves in ES and EN', () => {
    const missing: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bt\(\s*['"`]([\w.]+)['"`]\s*(\+)?/g)) {
        const key = m[1]!;
        const dynamic = m[2] === '+' || key.endsWith('.');
        for (const lang of ['es', 'en'] as const) {
          const ok = dynamic ? typeof node(DICTS[lang], key.replace(/\.$/, '')) === 'object' : lookup(DICTS[lang], key) !== undefined;
          if (!ok) missing.push(`${lang}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('es/comprador.json and en/comprador.json have identical key sets', () => {
    expect(flatten(es as Dict).sort()).toEqual(flatten(en as Dict).sort());
  });

  it('no crypto vocabulary in the portal files or its strings', () => {
    const hits: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN.test(line)) hits.push(`${path.relative(HERE, f)}:${i + 1}`);
        });
    }
    for (const [lang, dict] of Object.entries({ es, en })) {
      const m = FORBIDDEN.exec(JSON.stringify(dict));
      if (m) hits.push(`${lang}/comprador.json: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });

  it('no country literal in the portal components', () => {
    const hits = files.filter((f) => COUNTRY.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(HERE, f));
    expect(hits).toEqual([]);
  });
});
