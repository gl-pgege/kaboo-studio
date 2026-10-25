import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missedUpdate, parsePreviewPath, resolveSpecifier, routeFiles, routeHelpers } from '../src/resolve.ts';

const modules = { 'app/root.tsx': {}, 'app/blocks/Hero.tsx': {}, 'app/components/ui/index.ts': {}, 'app/lib/format.ts': {} };
const files = { 'app/images/logo.svg': 'h1' };

test('relative, alias and absolute imports find the design’s files with or without extensions', () => {
  assert.deepEqual(resolveSpecifier('app/routes/home.tsx', '../blocks/Hero', modules, files), { kind: 'app', path: 'app/blocks/Hero.tsx' });
  assert.deepEqual(resolveSpecifier('app/root.tsx', '~/lib/format', modules, files), { kind: 'app', path: 'app/lib/format.ts' });
  assert.deepEqual(resolveSpecifier('app/root.tsx', './components/ui', modules, files), { kind: 'app', path: 'app/components/ui/index.ts' });
  assert.deepEqual(resolveSpecifier('app/root.tsx', '/app/blocks/Hero.tsx', modules, files), { kind: 'app', path: 'app/blocks/Hero.tsx' });
  assert.deepEqual(resolveSpecifier('app/root.tsx', './images/logo.svg', modules, files), { kind: 'file', path: 'app/images/logo.svg' });
});

test('packages come from the vendor bundle, styles are stubs and the route helpers are built in', () => {
  assert.deepEqual(resolveSpecifier('app/root.tsx', 'react-router', modules, files), { kind: 'vendor', specifier: 'react-router' });
  assert.deepEqual(resolveSpecifier('app/root.tsx', '@radix-ui/react-dialog', modules, files), { kind: 'vendor', specifier: '@radix-ui/react-dialog' });
  assert.deepEqual(resolveSpecifier('app/root.tsx', './styles/app.css', modules, files), { kind: 'stub' });
  assert.deepEqual(resolveSpecifier('app/root.tsx', './styles/app.css?url', modules, files), { kind: 'stub' });
  assert.deepEqual(resolveSpecifier('app/routes.ts', '@react-router/dev/routes', modules, files), { kind: 'builtin', name: '@react-router/dev/routes' });
  assert.throws(() => resolveSpecifier('app/root.tsx', './missing', modules, files), /Cannot find "\.\/missing" imported by app\/root\.tsx/);
});

test('the route helpers build the same config React Router does', () => {
  const { index, route, layout, prefix } = routeHelpers;
  const config = [index('routes/home.tsx'), route('products/:slug', 'routes/product.tsx'), layout('routes/shell.tsx', [route('about', 'routes/about.tsx')]), ...prefix('help', [index('routes/help.tsx')])];
  assert.deepEqual(config[0], { index: true, file: 'routes/home.tsx' });
  assert.equal(config[1].path, 'products/:slug');
  assert.equal(config[2].children[0].file, 'routes/about.tsx');
  assert.equal(config[3].path, 'help');
  assert.deepEqual(routeFiles(config), ['routes/home.tsx', 'routes/product.tsx', 'routes/shell.tsx', 'routes/about.tsx', 'routes/help.tsx']);
});

test('a preview address names the design and its token, and gaps in the sequence are spotted', () => {
  const place = parsePreviewPath('/d/3f2a-11/eyJkIjoiMSJ9.c2ln/products/tee');
  assert.deepEqual(place, { design: '3f2a-11', token: 'eyJkIjoiMSJ9.c2ln', basename: '/d/3f2a-11/eyJkIjoiMSJ9.c2ln', rest: '/products/tee' });
  assert.equal(parsePreviewPath('/studio/sample.svg'), null);
  assert.equal(missedUpdate(null, 7), false);
  assert.equal(missedUpdate(6, 7), false);
  assert.equal(missedUpdate(6, 8), true);
});
