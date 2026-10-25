import { config } from '../config';
import { readArchive } from '../storage/archives';
import type { Storage } from '../storage/storage';
import type { Workspace } from '../workspaces/workspace';
import { cacheControlOf, contentType } from './edge';

const BUILD = [
  'set -a; [ -f .studio/state/env.sh ] && . .studio/state/env.sh; set +a',
  'rm -rf build .studio/state/client.tgz',
  'NODE_ENV=production npx --no-install react-router build > .studio/state/build.log 2>&1; code=$?',
  'tail -c 4000 .studio/state/build.log',
  'echo "@@EXIT@@$code"',
  '[ "$code" = 0 ] && tar -czf .studio/state/client.tgz -C build/client . && echo "@@PACKED@@"',
].join('\n');

export interface BuildOutput {
  ok: boolean;
  output: string;
  files: Map<string, Buffer>;
}

export async function buildClient(workspace: Workspace, storage: Storage, archiveKey: string): Promise<BuildOutput> {
  const built = await workspace.exec(BUILD, 14 * 60_000);
  const exit = built.stdout.match(/@@EXIT@@(\d+)/)?.[1];
  const output = built.stdout.split('@@EXIT@@')[0].trim();
  if (exit !== '0' || !built.stdout.includes('@@PACKED@@')) return { ok: false, output: (output || built.stderr).slice(-4000), files: new Map() };
  await workspace.upload('.studio/state/client.tgz', { url: await storage.signedPutUrl(archiveKey, 900), localPath: storage.localPath(archiveKey) });
  const archive = await storage.get(archiveKey);
  if (!archive) return { ok: false, output: "The build output couldn't be collected from the workspace", files: new Map() };
  const files = await readArchive(archive);
  await storage.delete([archiveKey]);
  return { ok: true, output, files };
}

const configMeta = () => new RegExp(`<meta name="${config.brandId}-config" content="[^"]*"\\/?>`);

export function withConfigInShell(files: Map<string, Buffer>): void {
  const shell = files.get('__spa-fallback.html')?.toString('utf8');
  if (!shell || configMeta().test(shell)) return;
  const page = [...files].find(([name]) => name === 'index.html' || name.endsWith('/index.html'))?.[1].toString('utf8');
  const meta = page?.match(configMeta())?.[0];
  if (meta) files.set('__spa-fallback.html', Buffer.from(shell.replace('<head>', `<head>${meta}`)));
}

export async function uploadFiles(target: Storage, prefix: string, files: Map<string, Buffer>, names: string[] = [...files.keys()]): Promise<void> {
  const ordered = [...names.filter(name => name.startsWith('assets/')), ...names.filter(name => !name.startsWith('assets/'))];
  for (let index = 0; index < ordered.length; index += 16) {
    await Promise.all(ordered.slice(index, index + 16).map(name => target.put(`${prefix}/${name}`, files.get(name)!, contentType(name), cacheControlOf(name))));
  }
}
