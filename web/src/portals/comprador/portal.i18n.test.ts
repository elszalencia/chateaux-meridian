// Vocabulary for the buyer portal (criteria 4 and 5): neither the portal's files nor its strings
// contain the words buyer screens never show, or a country literal used for branching. Key
// resolution and ES/EN parity for every namespace are checked in tests/i18n.test.ts.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import es from '../../i18n/es/comprador.json';
import en from '../../i18n/en/comprador.json';

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

const files = walk(HERE);

describe('buyer portal strings', () => {
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
