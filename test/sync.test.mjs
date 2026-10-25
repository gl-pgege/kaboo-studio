import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { treeId as sandboxTreeId } from '../toolchain/sync.mjs';
import { parseSyncOutput } from '../dist/engine/drafts/sync-result.js';
import { treeId } from '../dist/engine/versions/tree.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sync = path.resolve(here, '../toolchain/sync.mjs');
const sha = text => createHash('sha256').update(text).digest('hex');
let dir;

async function put(file, contents) {
  await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
  await writeFile(path.join(dir, file), contents);
}

async function step(payload) {
  await writeFile(path.join(dir, '.studio/state/step.json'), JSON.stringify({ noCompile: true, ...payload }));
  return parseSyncOutput(execFileSync('node', [sync, '--step', '.studio/state/step.json'], { cwd: dir, encoding: 'utf8' }), '');
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'studio-sync-'));
  await put('.studio/manifest.json', JSON.stringify({ protected: ['app/root.tsx'] }));
  await put('app/root.tsx', 'root');
  await put('app/blocks/Hero.tsx', 'hero');
  await mkdir(path.join(dir, '.studio/state'), { recursive: true });
  const files = { '.studio/manifest.json': sha(JSON.stringify({ protected: ['app/root.tsx'] })), 'app/root.tsx': sha('root'), 'app/blocks/Hero.tsx': sha('hero') };
  await writeFile(path.join(dir, '.studio/state/known.json'), JSON.stringify({ tree: treeId(files), files }));
});

after(() => rm(dir, { recursive: true, force: true }));

test('the studio and the sandbox name trees the same way', () => {
  const files = { 'b.ts': sha('b'), 'a.ts': sha('a') };
  assert.equal(treeId(files), sandboxTreeId(files));
});

test('a command runs, its output comes back and only changed files are sent', async () => {
  const result = await step({ run: "printf 'hero 2' > app/blocks/Hero.tsx && echo done" });
  assert.equal(result.command.exitCode, 0);
  assert.match(result.command.output, /done/);
  assert.deepEqual(result.changed.map(entry => entry.path), ['app/blocks/Hero.tsx']);
  assert.equal(result.changed[0].text, 'hero 2');
});

test('nothing is promoted until the studio confirms the saved tree', async () => {
  const again = await step({});
  assert.deepEqual(again.changed.map(entry => entry.path), ['app/blocks/Hero.tsx']);
  const promoted = await step({ promote: again.tree });
  assert.deepEqual(promoted.changed, []);
  assert.equal(promoted.previousTree, again.tree);
});

test('protected files are refused and kept in the tree as they were', async () => {
  const known = JSON.parse(await readFile(path.join(dir, '.studio/state/known.json'), 'utf8'));
  const result = await step({ run: 'echo hacked > app/root.tsx' });
  assert.deepEqual(result.changed, []);
  assert.deepEqual(result.refused.map(entry => entry.path), ['app/root.tsx']);
  assert.equal(result.tree, known.tree);
  await put('app/root.tsx', 'root');
});

test('large photos are refused and new ones are left out of the tree', async () => {
  const result = await step({ run: 'head -c 300000 /dev/zero > big.png' });
  assert.deepEqual(result.refused.map(entry => entry.path), ['big.png']);
  assert.deepEqual(result.changed, []);
  await rm(path.join(dir, 'big.png'));
});

test('writes and deletes apply before the scan, and a failing command still reports its exit code', async () => {
  const result = await step({ write: { 'app/new.ts': { text: 'export {}' } }, delete: ['app/blocks/Hero.tsx'], run: 'exit 3' });
  assert.equal(result.command.exitCode, 3);
  assert.deepEqual(result.changed.map(entry => entry.path), ['app/new.ts']);
  assert.deepEqual(result.deleted, ['app/blocks/Hero.tsx']);
});

test('writes cannot leave the design folder', async () => {
  assert.throws(() => parseSyncOutput('\n@@STUDIO_RESULT@@{"error":"Path outside the design: ../x"}', ''), /outside/);
  await writeFile(path.join(dir, '.studio/state/step.json'), JSON.stringify({ noCompile: true, write: { '../escape.txt': { text: 'x' } } }));
  const run = spawnSync('node', [sync, '--step', '.studio/state/step.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Path outside the design/);
});
