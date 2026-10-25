import assert from 'node:assert/strict';
import test from 'node:test';

const { RunService } = await import('../dist/engine/drafts/run.service.js');

function fakes() {
  const calls = { commit: [], release: [], drop: [] };
  const actor = { kind: 'assistant', name: 'Builder', runId: 'r1', actingFor: 'Olive' };
  const changes = [
    { runId: 'r1', designId: 'd1', store: 'north', actor },
    { runId: 'r1', designId: 'd2', store: 'north', actor },
  ];
  const drafts = {
    commit: async (design, _store, author, message) => {
      calls.commit.push({ design, author, message });
      return { number: 7, message };
    },
    release: async (_design, _store, owner) => void calls.release.push(owner),
  };
  const versions = {
    runChanges: async () => changes,
    idleRunChanges: async () => changes.slice(0, 1),
    dropRunChange: async (_run, design) => void calls.drop.push(design),
  };
  const designs = { get: async id => ({ design: { id, name: `Design ${id}` } }) };
  return { calls, service: new RunService(drafts, versions, designs) };
}

test('a run ends with one version per design it changed, and lets others write again', async () => {
  const { calls, service } = fakes();
  const ended = await service.end('r1', { kind: 'assistant', name: 'Builder', runId: 'r1', recipe: 'storefront-edit' }, null, 'finished', 'north');
  assert.deepEqual(ended.map(entry => entry.designName), ['Design d1', 'Design d2']);
  assert.ok(calls.commit.every(call => call.message === 'Changes by Builder' && call.author.recipe === 'storefront-edit' && call.author.actingFor === 'Olive'));
  assert.deepEqual(calls.release, ['run:r1', 'run:r1']);
  assert.deepEqual(calls.drop, ['d1', 'd2']);
});

test('a run nobody reports is versioned once it goes quiet', async () => {
  const { calls, service } = fakes();
  await service.sweep();
  assert.deepEqual(calls.commit.map(call => call.design), ['d1']);
  assert.deepEqual(calls.release, ['run:r1']);
  assert.deepEqual(calls.drop, ['d1']);
});
