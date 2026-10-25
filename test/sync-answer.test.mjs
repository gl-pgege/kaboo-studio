import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Logger } from '@nestjs/common';
import { DraftService } from '../dist/engine/drafts/draft.service.js';

Logger.overrideLogger(false);

const RESULT = { tree: 'tree-2', previousTree: 'tree-1', changed: [], deleted: [], refused: [], modules: {}, compileErrors: [], css: null, cssAssets: [], command: { output: 'done', exitCode: 0, durationMs: 4 }, timings: {} };

function sessionAnswering(stdout, saved) {
  const scripts = [];
  return {
    scripts,
    session: {
      draftId: 'draft-1',
      workspace: {
        exec: async script => {
          scripts.push(script);
          return { stdout, stderr: '', exitCode: 0 };
        },
        read: async paths => new Map(saved === undefined ? [] : [[paths[0], Buffer.from(saved)]]),
        alive: async () => true,
      },
    },
  };
}

const drafts = () => new DraftService({}, {}, {}, {}, {}, {}, {});

test('the answer is read from the workspace output', async () => {
  const { session, scripts } = sessionAnswering(`output\n@@STUDIO_RESULT@@${JSON.stringify(RESULT)}`);
  assert.deepEqual(await drafts().run(session, { promote: 'tree-1' }), RESULT);
  assert.match(scripts[0], /rm -f \.studio\/state\/result\.json\nnode \.studio\/toolchain\/sync\.mjs/);
});

test('an answer cut short is read from the result the workspace saved', async () => {
  const full = JSON.stringify(RESULT);
  const { session } = sessionAnswering(`\n@@STUDIO_RESULT@@${full.slice(0, 40)}`, full);
  assert.deepEqual(await drafts().run(session, { promote: 'tree-1' }), RESULT);
});

test('an answer cut short with nothing saved is still an error', async () => {
  const { session } = sessionAnswering(`\n@@STUDIO_RESULT@@${JSON.stringify(RESULT).slice(0, 40)}`);
  await assert.rejects(drafts().run(session, { promote: 'tree-1' }), SyntaxError);
});
