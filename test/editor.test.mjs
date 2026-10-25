import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { EditorService } from '../dist/engine/editor/editor.service.js';

const sha = text => createHash('sha256').update(text).digest('hex');

function fakes(tree) {
  const changes = [];
  const commits = [];
  const designs = { get: async () => ({ design: { id: 'd1', name: 'Spring' }, draft: { id: 'r1', tree: 't1' } }) };
  const versions = { tree: async () => tree };
  const drafts = {
    change: async (_id, _store, _actor, step, options) => {
      changes.push({ step, options });
      return { result: { changed: [...step.write.keys()], deleted: step.delete, draft: 't2', previousDraft: 't1', refused: [], compileErrors: [], types: [], lint: [], preview: null, command: null } };
    },
    commit: async (_id, _store, actor, message) => {
      commits.push({ actor, message });
      return { number: 2, message, author: actor };
    },
  };
  return { editor: new EditorService(designs, drafts, versions), changes, commits };
}

const person = { kind: 'person', name: 'Dana', personId: 'p1' };

test('a save writes the files whose base still matches and reports the rest as conflicts', async () => {
  const { editor, changes, commits } = fakes({ 'a.ts': sha('a'), 'b.ts': sha('b') });
  const saved = await editor.save('d1', 'north', person, [
    { path: 'a.ts', contents: 'a2', baseHash: sha('a') },
    { path: 'b.ts', contents: 'b2', baseHash: sha('old b') },
    { path: 'c.ts', contents: 'new', baseHash: null },
  ]);
  assert.deepEqual(saved.conflicts, ['b.ts']);
  assert.deepEqual([...changes[0].step.write.keys()], ['a.ts', 'c.ts']);
  assert.equal(changes[0].options.releaseAfter, true);
  assert.equal(commits[0].message, 'Edited a.ts, c.ts');
});

test('a deleted file is sent as a delete, and a save of only conflicts changes nothing', async () => {
  const { editor, changes } = fakes({ 'a.ts': sha('a') });
  await editor.save('d1', 'north', person, [{ path: 'a.ts', contents: null, baseHash: sha('a') }]);
  assert.deepEqual(changes[0].step.delete, ['a.ts']);
  const stale = await editor.save('d1', 'north', person, [{ path: 'a.ts', contents: 'x', baseHash: sha('zzz') }]);
  assert.equal(stale.version, null);
  assert.equal(changes.length, 1);
});

test("an assistant's save keeps the run's hold and leaves the version to the run's end", async () => {
  const { editor, changes, commits } = fakes({ 'a.ts': sha('a'), 'b.ts': sha('b') });
  const saved = await editor.save('d1', 'north', { kind: 'assistant', name: 'Builder', runId: 'run-7' }, [
    { path: 'a.ts', contents: 'a2', baseHash: sha('a') },
    { path: 'b.ts', contents: 'b2', baseHash: sha('stale b') },
  ]);
  assert.deepEqual(saved.conflicts, ['b.ts']);
  assert.equal(changes[0].options.releaseAfter, undefined);
  assert.equal(changes[0].options.ownerTtlMs, 20 * 60_000);
  assert.equal(saved.version, null);
  assert.equal(commits.length, 0);
});

test('an assistant run owns its writes for the whole run, a person only for the save', async () => {
  const { editor, changes } = fakes({ 'a.ts': sha('a') });
  await editor.save('d1', 'north', { kind: 'assistant', name: 'Builder', runId: 'run-7' }, [{ path: 'a.ts', contents: 'b', baseHash: sha('a') }]);
  await editor.save('d1', 'north', person, [{ path: 'a.ts', contents: 'c', baseHash: sha('a') }]);
  assert.equal(changes[0].options.owner, 'run:run-7');
  assert.match(changes[1].options.owner, /^person:p1:/);
});
