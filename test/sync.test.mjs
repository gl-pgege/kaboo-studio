import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { latestTypes, lintResult, treeId as sandboxTreeId, typeResult } from '../toolchain/sync.mjs';
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

test('a type pass still running is not read as the answer', () => {
  const log = 'Starting compilation in watch mode...\nFound 0 errors. Watching for file changes.\nFile change detected. Starting incremental compilation...\n';
  assert.equal(latestTypes(log, 0), null);
  assert.deepEqual(latestTypes(`${log}Found 0 errors. Watching for file changes.\n`, 0), []);
  assert.equal(latestTypes(`${log}Found 0 errors. Watching for file changes.\n`, log.length), null);
});

test('a change nobody checks notes where the type watcher had got to', async () => {
  await writeFile(path.join(dir, '.studio/state/tsc.log'), 'old output\n');
  const changed = await step({ run: "printf 'export const a = 1' > app/blocks/Kpi.tsx" });
  assert.deepEqual(changed.types, []);
  const since = JSON.parse(await readFile(path.join(dir, '.studio/state/types-since.json'), 'utf8'));
  assert.deepEqual(since, { offset: 'old output\n'.length, packages: false, typegen: false });
  await step({ promote: changed.tree });
});

test("a check reads the watcher's first full pass after the latest change, then forgets the change", async () => {
  const before = 'Starting compilation in watch mode...\nFound 0 errors. Watching for file changes.\n';
  await put('node_modules/.bin/eslint', "#!/bin/sh\necho '[]'\n");
  await chmod(path.join(dir, 'node_modules/.bin/eslint'), 0o755);
  await writeFile(path.join(dir, '.studio/state/tsc.pid'), String(process.pid));
  await writeFile(path.join(dir, '.studio/state/tsc.log'), before);
  const changed = await step({ run: 'printf \'export const a: number = "x"\' > app/blocks/Kpi.tsx' });
  await writeFile(
    path.join(dir, '.studio/state/tsc.log'),
    `${before}File change detected. Starting incremental compilation...\napp/blocks/Kpi.tsx(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error. Watching for file changes.\n`,
  );
  const checked = await step({ promote: changed.tree, check: true });
  assert.equal(checked.previousTree, changed.tree);
  assert.deepEqual(checked.changed, []);
  assert.deepEqual(checked.types, [{ file: 'app/blocks/Kpi.tsx', line: 1, column: 14, rule: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }]);
  assert.equal(existsSync(path.join(dir, '.studio/state/types-since.json')), false);
  await rm(path.join(dir, '.studio/state/tsc.pid'));
});

test('a type check that did not finish says so instead of reporting no errors', () => {
  assert.deepEqual(typeResult({ status: 0, stdout: '' }), []);
  assert.deepEqual(typeResult({ status: 2, stdout: "app/a.tsx(3,7): error TS7006: Parameter 'p' implicitly has an 'any' type.\n" }), [
    { file: 'app/a.tsx', line: 3, column: 7, rule: 'TS7006', message: "Parameter 'p' implicitly has an 'any' type." },
  ]);
  const killed = typeResult({ status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '' });
  assert.equal(killed.length, 1);
  assert.match(killed[0].message, /did not finish \(it ran out of time\), so types were not checked/);
  const crashed = typeResult({ status: 1, stdout: 'error TS5083: Cannot read file tsconfig.json.\n', stderr: '' });
  assert.match(crashed[0].message, /TS5083: Cannot read file tsconfig\.json/);
});

test('lint that did not run says so instead of reporting no errors', () => {
  const report = JSON.stringify([{ filePath: 'app/a.tsx', messages: [{ severity: 2, line: 1, column: 2, ruleId: 'no-explicit-any', message: 'Unexpected any.' }] }]);
  assert.deepEqual(lintResult({ status: 1, stdout: report }, ['app/a.tsx']), [
    { file: 'app/a.tsx', line: 1, column: 2, rule: 'no-explicit-any', message: 'Unexpected any.' },
  ]);
  assert.deepEqual(lintResult({ status: 0, stdout: '[]' }, ['app/a.tsx']), []);
  const fatal = lintResult({ status: 2, stdout: '', stderr: 'Oops! Something went wrong! ESLint could not find the config.' }, ['app/a.tsx', 'app/b.tsx']);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /Lint did not run \(Oops! Something went wrong! ESLint could not find the config\.\), so 2 file\(s\) were not linted/);
  assert.match(lintResult({ status: 1, stdout: 'not json' }, ['app/a.tsx'])[0].message, /Lint did not run/);
});

test('writes cannot leave the design folder', async () => {
  assert.throws(() => parseSyncOutput('\n@@STUDIO_RESULT@@{"error":"Path outside the design: ../x"}', ''), /outside/);
  await writeFile(path.join(dir, '.studio/state/step.json'), JSON.stringify({ noCompile: true, write: { '../escape.txt': { text: 'x' } } }));
  const run = spawnSync('node', [sync, '--step', '.studio/state/step.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Path outside the design/);
});
