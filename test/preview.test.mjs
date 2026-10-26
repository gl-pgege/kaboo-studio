import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as sandbox from '../toolchain/vendor.mjs';
import { PreviewTokens } from '../dist/engine/preview/preview-tokens.js';
import { PreviewService } from '../dist/engine/preview/preview.service.js';
import { vendorEntries, vendorKey } from '../dist/engine/preview/vendor.js';

const sha = text => createHash('sha256').update(text).digest('hex');

test('the studio and the sandbox agree on which packages a preview needs and on the bundle key', () => {
  const modules = {
    'app/root.tsx': { deps: ['react/jsx-runtime', '@endofszn/storefront-kit', './layout', './styles/app.css'], dynamicDeps: [] },
    'app/routes.ts': { deps: ['@react-router/dev/routes'], dynamicDeps: [] },
    'app/blocks/Hero.tsx': { deps: ['lucide-react', '~/lib/x', '@radix-ui/react-dialog?inline'], dynamicDeps: ['framer-motion'] },
  };
  assert.deepEqual(vendorEntries(modules), sandbox.vendorEntries(modules));
  assert.ok(!vendorEntries(modules).includes('@react-router/dev/routes'));
  assert.ok(vendorEntries(modules).includes('@radix-ui/react-dialog'));
  const entries = vendorEntries(modules);
  assert.equal(vendorKey('lock', entries, ['a.woff2']), sandbox.vendorKey('lock', entries, ['a.woff2']));
});

test('preview tokens name one design in one store, expire and refuse tampering', () => {
  const tokens = new PreviewTokens();
  const { token } = tokens.sign({ design: 'd1', store: 'northside', tree: null, agent: false }, 60);
  assert.deepEqual({ ...tokens.verify(token), exp: 0 }, { design: 'd1', store: 'northside', tree: null, agent: false, exp: 0 });
  const [payload, signature] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), s: 'southside' })).toString('base64url');
  assert.throws(() => tokens.verify(`${forged}.${signature}`), /not valid/);
  const { token: old } = tokens.sign({ design: 'd1', store: 'northside', tree: 't1', agent: true }, -5);
  assert.throws(() => tokens.verify(old), /expired/);
});

function fakes() {
  const stored = new Map();
  const storage = {
    get: async key => stored.get(key) ?? null,
    put: async (key, body) => void stored.set(key, Buffer.from(body)),
    has: async key => stored.has(key),
  };
  const published = [];
  const channel = {
    publishUpdate: async (_design, update) => published.push(update),
    publishError: async () => published.push('error'),
    nextSeq: async () => published.length + 1,
    result: async () => ({ status: 'no-preview', tree: null, route: null, ms: null, errors: [] }),
  };
  const vendorCalls = [];
  const vendor = { ensure: async (_session, lock, entries) => (vendorCalls.push(entries), `v-${lock}-${entries.length}`) };
  const trees = { t1: { 'app/root.tsx': 'r', 'app/blocks/Hero.tsx': 'h', 'package-lock.json': 'lock1' }, t2: { 'app/root.tsx': 'r', 'app/blocks/Hero.tsx': 'h2', 'package-lock.json': 'lock1' } };
  const versions = { tree: async (_store, tree) => trees[tree] };
  return { preview: new PreviewService(storage, versions, channel, vendor), published, vendorCalls, stored };
}

const design = { id: 'd1', store: 'northside' };
const module = (code, deps = ['react/jsx-runtime']) => ({ code, deps, dynamicDeps: [] });
const sync = (overrides = {}) => ({ tree: 't2', previousTree: 't1', changed: [], deleted: [], refused: [], modules: {}, compileErrors: [], css: null, cssAssets: [], command: null, timings: {}, ...overrides });

test('a first preview compiles the whole tree, then each change only sends what changed', async () => {
  const { preview, published, stored } = fakes();
  const full = sync({ tree: 't1', previousTree: 't1', modules: { 'app/root.tsx': module('root'), 'app/blocks/Hero.tsx': module('hero') }, css: '.a{}' });
  await preview.publish(design, 't1', sync({ previousTree: null }), {}, async () => full);
  assert.equal(published[0].reload, true);
  assert.ok(stored.has('stores/northside/previews/t1.json'));
  await preview.publish(design, 't2', sync({ changed: [{ path: 'app/blocks/Hero.tsx' }], modules: { 'app/blocks/Hero.tsx': module('hero 2') } }), {}, async () => assert.fail('no full compile'));
  assert.deepEqual(Object.keys(published[1].modules), ['app/blocks/Hero.tsx']);
  assert.equal(published[1].modules['app/blocks/Hero.tsx'], sha('hero 2'));
  assert.equal(published[1].reload, false);
  const manifest = await preview.manifest('northside', 't2');
  assert.equal(manifest.modules['app/root.tsx'].hash, sha('root'));
  assert.equal(manifest.css, sha('.a{}'));
});

test('a change nobody checks is published without waiting for the preview to answer', async () => {
  const { preview, published } = fakes();
  const full = sync({ tree: 't1', previousTree: 't1', modules: { 'app/root.tsx': module('root'), 'app/blocks/Hero.tsx': module('hero') } });
  await preview.publish(design, 't1', sync({ previousTree: null }), {}, async () => full);
  const result = await preview.publish(design, 't2', sync({ changed: [{ path: 'app/blocks/Hero.tsx' }], modules: { 'app/blocks/Hero.tsx': module('hero 2') } }), {}, async () => full, { wait: false });
  assert.deepEqual(result, { status: 'published', tree: 't2', route: null, ms: null, errors: [], faults: [] });
  assert.equal(published.length, 2);
});

test('root, routes, packages and deletions reload the preview; compile errors publish nothing new', async () => {
  const { preview, published } = fakes();
  const full = sync({ tree: 't1', previousTree: 't1', modules: { 'app/root.tsx': module('root'), 'app/blocks/Hero.tsx': module('hero') } });
  await preview.publish(design, 't1', sync({ previousTree: null }), {}, async () => full);
  await preview.publish(design, 't2', sync({ changed: [{ path: 'app/root.tsx' }], modules: { 'app/root.tsx': module('root 2') } }), {}, async () => full);
  assert.equal(published.at(-1).reload, true);
  await preview.publish(design, 't2', sync({ changed: [{ path: 'app/blocks/Hero.tsx' }], modules: { 'app/blocks/Hero.tsx': module('hero', ['react/jsx-runtime', 'framer-motion']) } }), {}, async () => full);
  assert.equal(published.at(-1).reload, true);
  await preview.publish(design, 't2', sync({ deleted: ['app/blocks/Hero.tsx'] }), {}, async () => full);
  assert.equal(published.at(-1).reload, true);
  const before = published.length;
  const result = await preview.publish(design, 't2', sync({ compileErrors: [{ file: 'app/x.tsx', line: 1, column: 1, message: 'Unexpected token' }] }), {}, async () => full);
  assert.equal(result.status, 'compile-errors');
  assert.equal(published[before], 'error');
});
