import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const edit = path.resolve(here, '../toolchain/edit.mjs');
const cases = JSON.parse(readFileSync(path.resolve(here, '../toolchain/edit-cases.json'), 'utf8'));

for (const item of cases) {
  test(`edit ${item.name}`, () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'studio-edit-'));
    try {
      const file = path.join(dir, 'page.tsx');
      if (item.file !== null) writeFileSync(file, item.file);
      const run = spawnSync('node', [edit, 'page.tsx'], { cwd: dir, input: item.input, encoding: 'utf8' });
      assert.equal(run.status, item.exit);
      assert.equal(run.stdout.trimEnd(), item.stdout);
      assert.equal(run.stderr.trimEnd(), item.stderr);
      assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, item.result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
