// The product is Chateaux everywhere the user sees its name: the page title, the header in both
// languages and the logo initial.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DICTS, lookup } from '../app/i18n';

const WEB = path.resolve(__dirname, '..', '..');

describe('brand', () => {
  it('page title, header and logo say Chateaux', () => {
    expect(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')).toContain('<title>Chateaux</title>');
    expect(lookup(DICTS.es, 'app.title')).toBe('Chateaux');
    expect(lookup(DICTS.en, 'app.title')).toBe('Chateaux');
    const app = fs.readFileSync(path.join(WEB, 'src', 'App.tsx'), 'utf8');
    expect(app).toMatch(/text-white">\s*C\s*<\/span>/);
  });
});
