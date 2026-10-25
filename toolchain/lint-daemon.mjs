#!/usr/bin/env node
import { existsSync, watch } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const state = path.join(root, '.studio', 'state');
const request = path.join(state, 'lint-request.json');
const { ESLint } = await import('eslint');
let eslint = new ESLint({ cwd: root });
let busy = false;

async function handle() {
  if (busy || !existsSync(request)) return;
  busy = true;
  try {
    const taken = `${request}.${process.pid}`;
    await rename(request, taken).catch(() => null);
    if (!existsSync(taken)) return;
    const { id, files } = JSON.parse(await readFile(taken, 'utf8'));
    await rm(taken, { force: true });
    if (files.some(file => /eslint\.config\./.test(file))) eslint = new ESLint({ cwd: root });
    const present = files.filter(file => existsSync(path.join(root, file)));
    const results = present.length ? await eslint.lintFiles(present) : [];
    const out = results.map(result => ({ filePath: result.filePath, messages: result.messages.map(({ ruleId, severity, message, line, column }) => ({ ruleId, severity, message, line, column })) }));
    await writeFile(path.join(state, `lint-${id}.json`), JSON.stringify(out));
  } catch (error) {
    await writeFile(path.join(state, 'lint-daemon-error.txt'), String(error?.stack ?? error));
  } finally {
    busy = false;
    if (existsSync(request)) setTimeout(handle, 0);
  }
}

watch(state, () => void handle());
setInterval(() => void handle(), 250).unref();
await writeFile(path.join(state, 'lint-daemon.pid'), String(process.pid));
await new Promise(() => {});
