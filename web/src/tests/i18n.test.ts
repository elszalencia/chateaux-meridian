// Criterion 13: every UI string comes from the dictionaries, Spanish is the default, and ES and EN
// have identical key sets. Keys are checked against the merged dictionaries the app uses (es.json /
// en.json plus every namespace file in i18n/{es,en}/), so a portal can keep its strings in its own
// namespace file and still be covered here. The scoped translators resolve through their prefix:
// `tp('x')` reads `comprador.portal.x`, `ot('x')` reads `oficina.x`.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import es from '../i18n/es.json';
import en from '../i18n/en.json';
import { DICTS, interpolate, lookup, mergeDict } from '../app/i18n';
import { PORTAL_PREFIX } from '../portals/comprador/copy';
import { OFICINA_NS } from '../portals/oficina/shared/i18n';

type Dict = Record<string, unknown>;
const SRC = path.resolve(__dirname, '..');
const I18N = path.join(SRC, 'i18n');
const LANGS = ['es', 'en'] as const;

// Translator name → the key prefix it adds.
const TRANSLATORS: Record<string, string> = { t: '', tp: PORTAL_PREFIX, ot: `${OFICINA_NS}.` };

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
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
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

function namespaceFiles(lang: string): string[] {
  const dir = path.join(I18N, lang);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
}

function readJson(file: string): Dict {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Dict;
}

// The first argument of a call starting at `from` (just after the opening parenthesis): stops at
// the first top-level comma or closing parenthesis, skipping over strings and nested brackets.
function firstArg(src: string, from: number): string {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < src.length && src[i] !== ch; i += 1) if (src[i] === '\\') i += 1;
    } else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return src.slice(from, i);
      depth -= 1;
    } else if (ch === ',' && depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

interface KeyUse {
  file: string;
  key: string;
  dynamic: boolean;
}

// Every key literal passed to a translator: a plain literal, either branch of a ternary, or the
// static head of a template / concatenation (`a.b.${x}`, 'a.b.' + x, `a.legend${x}`), which must
// name a group, or a group plus the start of one of its keys.
function keyUses(): KeyUse[] {
  const files = walk(SRC).filter((f) => !f.includes(`${path.sep}tests${path.sep}`));
  const uses: KeyUse[] = [];
  const call = new RegExp(`\\b(${Object.keys(TRANSLATORS).join('|')})\\(`, 'g');
  const literal = /(?:^|[?:])\s*(['"`])([\w.-]+?)(\$\{|\1)/g;
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
    for (const m of src.matchAll(call)) {
      const prefix = TRANSLATORS[m[1]!]!;
      // What sits inside `${...}` is a runtime segment (fallbacks included), not a key.
      const arg = firstArg(src, m.index! + m[0].length).replace(/\$\{[^}]*\}/g, '${}');
      for (const lit of arg.matchAll(literal)) {
        const key = lit[2]!;
        const dynamic = lit[3] === '${' || key.endsWith('.') || /^\s*\+/.test(arg.slice(lit.index! + lit[0].length));
        uses.push({ file: path.relative(SRC, file), key: prefix + key, dynamic });
      }
    }
  }
  return uses;
}

describe('i18n dictionaries', () => {
  it('es.json and en.json have identical key sets', () => {
    expect(flatten(es as Dict).sort()).toEqual(flatten(en as Dict).sort());
  });

  it('every namespace file exists in both languages with identical key sets', () => {
    expect(namespaceFiles('es')).toEqual(namespaceFiles('en'));
    for (const f of namespaceFiles('es')) {
      const a = flatten(readJson(path.join(I18N, 'es', f))).sort();
      const b = flatten(readJson(path.join(I18N, 'en', f))).sort();
      expect({ file: f, keys: a }).toEqual({ file: f, keys: b });
    }
  });

  it('the merged dictionaries have identical key sets', () => {
    expect(flatten(DICTS.es).sort()).toEqual(flatten(DICTS.en).sort());
  });

  it('no namespace file redefines a key from the base file or another namespace file', () => {
    // A clash is the same leaf key twice, or a leaf in one file where another file has a group.
    const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
    for (const lang of LANGS) {
      const owners: [string, string[]][] = [
        [`${lang}.json`, flatten(lang === 'es' ? (es as Dict) : (en as Dict))],
        ...namespaceFiles(lang).map((f): [string, string[]] => [`${lang}/${f}`, flatten(readJson(path.join(I18N, lang, f)))]),
      ];
      const clashes: string[] = [];
      owners.forEach(([file, keys], i) => {
        for (const [other, otherKeys] of owners.slice(0, i)) {
          for (const k of keys) if (otherKeys.some((o) => overlaps(k, o))) clashes.push(`${file}: ${k} (also in ${other})`);
        }
      });
      expect(clashes).toEqual([]);
    }
  });

  it('Spanish is the default locale', () => {
    expect(lookup(es as Dict, '_meta.locale')).toBe('es-CO');
  });

  it('no partial dictionaries are left outside the base and namespace files', () => {
    const parts = path.join(I18N, 'parts');
    const leftovers = fs.existsSync(parts) ? fs.readdirSync(parts).filter((f) => f.endsWith('.json')) : [];
    expect(leftovers).toEqual([]);
  });

  it('every t / tp / ot key used in the app resolves in ES and EN; dynamic prefixes must name a group', () => {
    const uses = keyUses();
    const missing: string[] = [];
    for (const { file, key, dynamic } of uses) {
      for (const lang of LANGS) {
        let ok: boolean;
        if (dynamic) {
          const cut = key.lastIndexOf('.');
          const group = lookupAny(DICTS[lang], key.slice(0, cut));
          const start = key.slice(cut + 1);
          ok = !!group && typeof group === 'object' && Object.keys(group).some((k) => k.startsWith(start));
        } else ok = typeof lookupAny(DICTS[lang], key) === 'string';
        if (!ok) missing.push(`${lang} ${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
    // Guards the scanner itself: the portals alone use several hundred keys.
    expect(uses.filter((u) => u.key.startsWith(PORTAL_PREFIX)).length).toBeGreaterThan(100);
    expect(uses.filter((u) => u.key.startsWith(`${OFICINA_NS}.`)).length).toBeGreaterThan(100);
  });

  it('merging keeps the base value on a clash at any depth', () => {
    const merged = mergeDict({ a: { b: { c: 'base' } }, x: 'base' }, { a: { b: { c: 'ns', d: 'ns' } }, x: 'ns', y: 'ns' });
    expect(merged).toEqual({ a: { b: { c: 'base', d: 'ns' } }, x: 'base', y: 'ns' });
  });

  it('interpolation fills placeholders and leaves unknown ones visible', () => {
    expect(interpolate('Reiniciado en {seconds} s', { seconds: '0.30' })).toBe('Reiniciado en 0.30 s');
    expect(interpolate('{a} {b}', { a: 1 })).toBe('1 {b}');
  });
});
