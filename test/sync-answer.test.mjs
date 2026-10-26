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

function checking(session, draft, { recorded = [], discarded = [] } = {}) {
  return new DraftService(
    { get: async () => ({ design: { id: 'd1' }, draft }) },
    { recordProblems: async (id, problems) => recorded.push({ id, problems }) },
    { forDraft: async () => session, touch: async () => undefined, discard: async id => discarded.push(id) },
    { exclusive: async (_id, work) => work() },
    {},
    {},
    {},
  );
}

test('a draft nobody checked is checked once in its workspace and the problems are kept for its tree', async () => {
  const types = [{ file: 'app/routes/home.tsx', line: 4, column: 2, rule: 'TS2322', message: 'nope' }];
  const { session, scripts } = sessionAnswering(`\n@@STUDIO_RESULT@@${JSON.stringify({ ...RESULT, tree: 'tree-2', previousTree: 'tree-2', command: null, types, lint: [] })}`);
  const draft = { id: 'draft-1', tree: 'tree-2', problems: null };
  const recorded = [];
  const service = checking(session, draft, { recorded });
  const problems = await service.diagnose('d1', 'north');
  assert.deepEqual(problems, { tree: 'tree-2', compile: [], types, lint: [] });
  assert.deepEqual(recorded, [{ id: 'draft-1', problems }]);
  assert.match(scripts[0], /"check":true/);
  draft.problems = problems;
  assert.equal(await service.diagnose('d1', 'north'), problems);
  assert.equal(scripts.length, 1);
});

test('a check that finds the workspace out of step with the draft restarts it and records nothing', async () => {
  const { session } = sessionAnswering(`\n@@STUDIO_RESULT@@${JSON.stringify({ ...RESULT, previousTree: 'tree-0' })}`);
  const recorded = [];
  const discarded = [];
  const service = checking(session, { id: 'draft-1', tree: 'tree-2', problems: null }, { recorded, discarded });
  await assert.rejects(service.diagnose('d1', 'north'), /out of step/);
  assert.deepEqual(discarded, ['draft-1']);
  assert.deepEqual(recorded, []);
});
