import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StudioCommands } from '../dist/engine/terminal/studio-commands.js';

function commands() {
  const stopped = { workspaces: [], browsers: [] };
  const designs = {
    get: async id => ({ design: { id, parentId: id === 'main' ? null : 'main' }, draft: { id: `draft-of-${id}` } }),
    dropVariation: async () => 'variation-bold',
  };
  const workspaces = { discard: async draft => stopped.workspaces.push(draft) };
  const browsers = { discard: async draft => stopped.browsers.push(draft) };
  return { stopped, studio: new StudioCommands(designs, {}, {}, {}, {}, workspaces, {}, {}, browsers) };
}

test("dropping a variation stops its workspace and browser", async () => {
  const { studio, stopped } = commands();
  const answer = await studio.run({ designId: 'main', store: 'northside' }, ['variation', 'drop', 'bold']);
  assert.equal(answer.text, 'Dropped variation bold.');
  assert.deepEqual(stopped, { workspaces: ['draft-of-variation-bold'], browsers: ['draft-of-variation-bold'] });
});

test('a variation dropped from its own session keeps that session until it idles out', async () => {
  const { studio, stopped } = commands();
  await studio.run({ designId: 'variation-bold', store: 'northside' }, ['variation', 'drop', 'bold']);
  assert.deepEqual(stopped, { workspaces: [], browsers: [] });
});
