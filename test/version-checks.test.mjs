import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VersionChecks } from '../dist/engine/checks/version-checks.service.js';

function checks(perform, status = 'active') {
  const rows = new Map();
  const key = where => `${where.store_tree.store}/${where.store_tree.tree}`;
  const prisma = {
    treeCheck: {
      findUnique: async ({ where }) => rows.get(key(where)) ?? null,
      upsert: async ({ where, create, update }) => rows.set(key(where), { ...(rows.get(key(where)) ?? create), ...update }),
      update: async ({ where, data }) => rows.set(key(where), { ...rows.get(key(where)), ...data }),
      delete: async ({ where }) => rows.delete(key(where)),
    },
  };
  const design = { id: 'design-1', store: 'northside', status };
  const designs = { get: async () => ({ design, draft: { id: 'draft-1', tree: 'tree-1' } }) };
  const handlers = {};
  const queue = { register: (name, handler) => (handlers[name] = handler) };
  const writers = { lock: (_name, work) => work() };
  const service = new VersionChecks(prisma, designs, {}, {}, {}, {}, {}, queue, writers, {});
  service.perform = perform;
  service.onModuleInit();
  return { service, rows, design, handlers };
}

const passed = { tree: 'tree-1', status: 'passed', summary: 'Built 4 pages', build: { ok: true, ms: 1, pages: 4, output: null }, routes: [], accessibility: [], contract: [], flows: [], ranAt: '' };

test('a check that could not run is answered but not kept against the tree', async () => {
  const { service, rows, design } = checks(async () => {
    throw new Error('Target page, context or browser has been closed');
  });
  const result = await service.check(design, { id: 'draft-1', tree: 'tree-1' }, 'tree-1');
  assert.equal(result.status, 'failed');
  assert.equal(result.summary, "The check couldn't run: Target page, context or browser has been closed");
  assert.equal(rows.size, 0);
  assert.equal(await service.result('northside', 'tree-1'), null);
});

test('a queued check that could not run fails its job so the queue tries again', async () => {
  const { handlers } = checks(async () => {
    throw new Error('the browser went away');
  });
  await assert.rejects(handlers.checks.process({ data: { designId: 'design-1', store: 'northside', tree: 'tree-1' } }), /The check couldn't run: the browser went away/);
});

test('a queued check of an archived design is skipped without starting anything', async () => {
  let runs = 0;
  const { handlers, rows } = checks(async () => {
    runs += 1;
    return passed;
  }, 'archived');
  assert.deepEqual(await handlers.checks.process({ data: { designId: 'design-1', store: 'northside', tree: 'tree-1' } }), { status: 'skipped' });
  assert.equal(runs, 0);
  assert.equal(rows.size, 0);
});

test('a check that ran is kept and reused for the same tree', async () => {
  let runs = 0;
  const { service, handlers, design } = checks(async () => {
    runs += 1;
    return passed;
  });
  assert.deepEqual(await handlers.checks.process({ data: { designId: 'design-1', store: 'northside', tree: 'tree-1' } }), { status: 'passed' });
  assert.equal((await service.result('northside', 'tree-1')).summary, 'Built 4 pages');
  await service.check(design, { id: 'draft-1', tree: 'tree-1' }, 'tree-1');
  assert.equal(runs, 1);
});
