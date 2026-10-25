import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';
import { config } from '../../dist/engine/config.js';
import { S3Storage } from '../../dist/engine/storage/storage.js';
import { CodeInterpreterProvider } from '../../dist/engine/workspaces/code-interpreter.provider.js';
import { DockerProvider } from '../../dist/engine/workspaces/docker.provider.js';

const run = promisify(execFile);
const provider = config.workspaces === 'agentcore' ? new CodeInterpreterProvider() : new DockerProvider();
const until = async (probe, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await probe()) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
};

async function archiveOf(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-contract-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, 'tree', file)), { recursive: true });
      await writeFile(path.join(dir, 'tree', file), text);
    }
    await run('tar', ['-czf', path.join(dir, 'archive.tgz'), '-C', path.join(dir, 'tree'), '.']);
    return await readFile(path.join(dir, 'archive.tgz'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transfers() {
  if (config.storage === 's3') {
    const storage = new S3Storage(config.bucket, config.region);
    const prefix = `contract/${randomUUID()}`;
    return {
      offer: async (name, bytes) => {
        await storage.put(`${prefix}/${name}`, bytes);
        return storage.signedUrl(`${prefix}/${name}`, 600);
      },
      receiver: name => storage.signedPutUrl(`${prefix}/${name}`, 600),
      received: name => storage.get(`${prefix}/${name}`),
      close: () => storage.deletePrefix(`${prefix}/`),
    };
  }
  const offered = new Map();
  const uploaded = new Map();
  const server = createServer((request, response) => {
    const name = request.url.slice(1);
    if (request.method === 'GET' && offered.has(name)) return response.end(offered.get(name));
    if (request.method !== 'PUT') return response.writeHead(404).end();
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk)).on('end', () => {
      uploaded.set(name, Buffer.concat(chunks));
      response.end();
    });
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  const base = `http://host.docker.internal:${server.address().port}`;
  return {
    offer: async (name, bytes) => {
      offered.set(name, bytes);
      return `${base}/${name}`;
    },
    receiver: async name => `${base}/${name}`,
    received: async name => uploaded.get(name) ?? null,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

let workspace;
let transfer;

before(async () => {
  transfer = await transfers();
  workspace = await provider.start('studio-contract');
});

after(async () => {
  await workspace?.stop();
  await transfer?.close();
});

test('a new workspace is alive and runs commands in the design folder', async () => {
  assert.equal(await workspace.alive(), true);
  const pwd = await workspace.exec('pwd');
  assert.equal(pwd.exitCode, 0, pwd.stderr);
  assert.match(pwd.stdout.trim(), /\/design$/);
});

test('commands report their output, errors and exit code', async () => {
  const result = await workspace.exec('echo out; echo err >&2; exit 3');
  assert.equal(result.stdout.trim(), 'out');
  assert.equal(result.stderr.trim(), 'err');
  assert.equal(result.exitCode, 3);
});

test('files are written and read back byte for byte, in nested folders, skipping missing ones', async () => {
  const pixel = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
  await workspace.write([
    { path: 'app/routes/home.tsx', bytes: Buffer.from('export default function Home() {\n  return <h1>Made in small runs</h1>;\n}\n') },
    { path: 'public/pixel.bin', bytes: pixel },
  ]);
  const files = await workspace.read(['app/routes/home.tsx', 'public/pixel.bin', 'missing.txt']);
  assert.deepEqual([...files.keys()].sort(), ['app/routes/home.tsx', 'public/pixel.bin']);
  assert.match(files.get('app/routes/home.tsx').toString(), /Made in small runs/);
  assert.deepEqual(files.get('public/pixel.bin'), pixel);
  assert.equal((await workspace.exec('wc -c < public/pixel.bin')).stdout.trim(), String(pixel.length));
});

test('commands longer than an inline call still run', async () => {
  const result = await workspace.exec(`printf '%s' '${'x'.repeat(120_000)}' | wc -c`);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), '120000');
});

test('background commands return at once and keep running', async () => {
  await workspace.background('sleep 2 && echo done > background.txt');
  assert.equal((await workspace.exec('test -f background.txt; echo $?')).stdout.trim(), '1');
  assert.ok(await until(async () => (await workspace.exec('cat background.txt 2>/dev/null')).stdout.trim() === 'done'));
});

test('an archive extracts into the design folder from its bytes', async () => {
  const bytes = await archiveOf({ 'node_modules/kit/index.js': 'module.exports = 1;\n' });
  await workspace.extract({ url: null, localPath: null, bytes: async () => bytes });
  assert.equal((await workspace.exec('cat node_modules/kit/index.js')).stdout.trim(), 'module.exports = 1;');
});

test('an archive extracts from a URL and a file uploads to one', async () => {
  const bytes = await archiveOf({ 'build/client/index.html': '<h1>Rendered</h1>\n' });
  const url = await transfer.offer('toolchain.tgz', bytes);
  await workspace.extract({ url, localPath: null, bytes: async () => assert.fail('the URL should be used') });
  assert.equal((await workspace.exec('cat build/client/index.html')).stdout.trim(), '<h1>Rendered</h1>');

  await workspace.exec('printf built > render.txt');
  await workspace.upload('render.txt', { url: await transfer.receiver('render.txt'), localPath: null });
  assert.equal((await transfer.received('render.txt'))?.toString(), 'built');
});

test('attaching by id reaches the same workspace', async () => {
  const attached = provider.attach(workspace.id);
  assert.equal(attached.id, workspace.id);
  assert.match((await attached.exec('cat app/routes/home.tsx')).stdout, /Made in small runs/);
});

test('a stopped workspace is no longer alive', async () => {
  await workspace.stop();
  assert.ok(await until(async () => !(await workspace.alive())));
  workspace = null;
});
