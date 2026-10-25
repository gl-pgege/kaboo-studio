import assert from 'node:assert/strict';
import test from 'node:test';

process.env.STUDIO_MAX_SESSIONS = '2';
process.env.STUDIO_SESSION_POLL_MS = '20';
process.env.STUDIO_SESSION_WAIT_MS = '2000';

const { GCRA } = await import('../dist/engine/scaling/rate-limiter.js');
const { SessionAdmission, CapacityError, callWait } = await import('../dist/engine/scaling/admission.js');
const { compareVersions } = await import('../dist/engine/templates/template.service.js');
const { default: Redis } = await import('ioredis');

test('sandbox calls past the burst wait their turn instead of failing', async t => {
  const redis = new Redis({ host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379), lazyConnect: true, maxRetriesPerRequest: 0 });
  try {
    await redis.connect();
  } catch {
    t.skip('Redis is not running');
    return;
  }
  const key = `studio:test:rate:${Date.now()}`;
  const waits = [];
  for (let call = 0; call < 30; call++) waits.push(Number(await redis.eval(GCRA, 1, key, '100', '10')));
  await redis.del(key);
  await redis.quit();
  assert.deepEqual(waits.slice(0, 10), Array(10).fill(0));
  assert.ok(waits[10] > 0 && waits[10] <= 110, `the 11th call waits about one interval, not ${waits[10]} ms`);
  assert.ok(waits[29] >= 1900 && waits[29] <= 2010, `the 30th call waits about two seconds, not ${waits[29]} ms`);
  assert.ok(waits.every((wait, index) => index === 0 || wait >= waits[index - 1]));
});

test('at the account limit a new session waits in line, says so, then starts', async () => {
  const counts = [2, 2, 2, 1];
  const events = [];
  const admission = new SessionAdmission({ session: { count: async () => counts.shift() ?? 0 } }, { publishSession: async (_design, state) => void events.push(state) });
  await admission.admit('sandbox', 'design-1');
  assert.deepEqual(events, ['waiting', 'starting']);
  assert.equal(counts.length, 0);
});

test('a session that never gets a place gives up with a clear message', async () => {
  const admission = new SessionAdmission({ session: { count: async () => 5 } }, { publishSession: async () => undefined });
  await assert.rejects(admission.admit('sandbox', null), error => error instanceof CapacityError && /busy/.test(error.message));
});

test('a call waits only as long as its own limit, then says every workspace is busy', async () => {
  const admission = new SessionAdmission({ session: { count: async () => 5 } }, { publishSession: async () => undefined });
  const started = Date.now();
  await assert.rejects(
    callWait.run(150, () => admission.admit('sandbox', 'design-1')),
    error => error instanceof CapacityError && error.message === 'Every workspace is busy, try again in a minute.',
  );
  assert.ok(Date.now() - started < 1000);
});

test('kit upgrades only move designs forward', () => {
  assert.ok(compareVersions('1.0.1', '1.0.0') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.10') < 0);
  assert.equal(compareVersions('^1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
});
