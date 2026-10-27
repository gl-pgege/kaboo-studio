import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { instrument, reasonOf } from '../src/instrument.ts';

const saved = { window: globalThis.window, location: globalThis.location, error: console.error };

afterEach(() => {
  globalThis.window = saved.window;
  globalThis.location = saved.location;
  console.error = saved.error;
});

function page(answer) {
  const window = { fetch: async () => answer(), addEventListener() {} };
  globalThis.window = window;
  globalThis.location = new URL('http://preview.test/d/design/token/');
  return window;
}

const api = { path: '/_studio/kaboo/data', refused: 'refused: {message}', status: 'Data for {url} failed ({status}): {message}', unreachable: 'Data for {url} unreachable: {reason}' };

test('a failed request reads as its reason', () => {
  assert.equal(reasonOf('{"statusCode":502,"message":"Script failed: KeyError: region"}'), 'Script failed: KeyError: region');
  assert.equal(reasonOf('{"message":["a","b"]}'), 'a; b');
  assert.equal(reasonOf('  plain text  '), 'plain text');
});

test("a failed request to the host's API is reported with its reason, even under /_studio/", async () => {
  const window = page(() => new Response('{"statusCode":502,"message":"Script failed: KeyError: region"}', { status: 502 }));
  const log = instrument('/d/design/token', [], { api });
  const response = await window.fetch('/_studio/kaboo/data/abc/q-5?params=%7B%7D');
  assert.equal(response.status, 502);
  assert.deepEqual(log.failed, ['Data for /_studio/kaboo/data/abc/q-5?params=%7B%7D failed (502): Script failed: KeyError: region']);
  assert.equal(log.pending, 0);
});

test("an unreachable host API is reported, and the studio's own requests still are not", async () => {
  const window = page(() => {
    throw new TypeError('fetch failed');
  });
  const log = instrument('/d/design/token', [], { api });
  await assert.rejects(window.fetch('/_studio/kaboo/data/abc/q-5'));
  await assert.rejects(window.fetch('/_studio/preview/abc/manifest.json'));
  assert.deepEqual(log.failed, ['Data for /_studio/kaboo/data/abc/q-5 unreachable: fetch failed']);
});
