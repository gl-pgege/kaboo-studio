import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { contrast, hexToOklch, seedBrand } from '../dist/engine/templates/brand.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const template = path.resolve(here, 'fixtures/template');
const css = 'app/styles/app.css';

async function files() {
  return new Map([
    [css, await readFile(path.join(template, css))],
    ['DESIGN.md', await readFile(path.join(template, 'DESIGN.md'))],
  ]);
}

test('hex colours convert to OKLCH', () => {
  const white = hexToOklch('#FFFFFF');
  assert.ok(Math.abs(white.l - 1) < 0.001 && white.c < 0.001);
  const black = hexToOklch('#000000');
  assert.ok(black.l < 0.001);
  assert.ok(contrast(white, black) > 20.9);
});

test('the brand rewrites only the tokens it names, and records itself in DESIGN.md', async () => {
  const original = await files();
  const seeded = seedBrand(original, { primary: '#EA580C', headingFont: 'Georgia', radius: '12px' }, css);
  const out = seeded.get(css).toString('utf8');
  assert.match(out, /--primary: oklch\(0\.6\d\d 0\.1\d\d 4\d\.\d\);/);
  assert.match(out, /--font-display: Georgia, 'Times New Roman', serif;/);
  assert.match(out, /--radius: 0\.75rem;/);
  assert.match(out, /--font-sans: 'Inter Variable'/);
  assert.equal(out.match(/--background: [^;]+;/)[0], original.get(css).toString('utf8').match(/--background: [^;]+;/)[0]);
  assert.match(seeded.get('DESIGN.md').toString('utf8'), /primary #EA580C, Georgia for headings, 12px corners/);
});

test('a pale accent is darkened until it reads on the page', async () => {
  const seeded = seedBrand(await files(), { accent: '#FFE08A' }, css).get(css).toString('utf8');
  const [, l, c, h] = seeded.match(/--highlight: oklch\(([\d.]+) ([\d.]+) ([\d.]+)\);/).map(Number);
  assert.ok(contrast({ l, c, h }, { l: 0.99, c: 0.004, h: 85 }) >= 4.5);
});

test('no brand leaves the template as it is', async () => {
  const original = await files();
  assert.equal(seedBrand(original, {}, css).get(css).toString('utf8'), original.get(css).toString('utf8'));
});
