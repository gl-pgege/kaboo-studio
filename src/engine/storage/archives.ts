import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Storage } from './storage';

const run = promisify(execFile);

const TYPES: Record<string, string> = { js: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json', woff2: 'font/woff2', svg: 'image/svg+xml', data: 'text/x-script' };

export async function readArchive(archive: Buffer): Promise<Map<string, Buffer>> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-read-'));
  try {
    await writeFile(path.join(dir, 'archive.tgz'), archive);
    await run('tar', ['-xzf', 'archive.tgz', '--no-same-owner'], { cwd: dir });
    await rm(path.join(dir, 'archive.tgz'));
    const files = new Map<string, Buffer>();
    const walk = async (relative: string) => {
      for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
        const child = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) files.set(child, await readFile(path.join(dir, child)));
      }
    };
    await walk('');
    return files;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function unpackToStorage(storage: Storage, archive: Buffer, prefix: string, last?: string): Promise<string[]> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-unpack-'));
  try {
    await writeFile(path.join(dir, 'archive.tgz'), archive);
    await run('tar', ['-xzf', 'archive.tgz', '--no-same-owner'], { cwd: dir });
    await rm(path.join(dir, 'archive.tgz'));
    const files: string[] = [];
    const walk = async (relative: string) => {
      for (const entry of await readdir(path.join(dir, relative), { withFileTypes: true })) {
        const child = path.posix.join(relative, entry.name);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) files.push(child);
      }
    };
    await walk('');
    const ordered = last ? [...files.filter(file => file !== last), ...(files.includes(last) ? [last] : [])] : files;
    for (let index = 0; index < ordered.length; index += 16) {
      await Promise.all(
        ordered.slice(index, index + 16).map(async file => storage.put(`${prefix}/${file}`, await readFile(path.join(dir, file)), TYPES[file.split('.').pop() ?? ''])),
      );
    }
    return ordered;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
