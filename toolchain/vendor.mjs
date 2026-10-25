#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASE_ENTRIES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'react-router'];
const PREVIEW_ONLY = new Set(['@react-router/dev/routes']);

export function isBare(specifier) {
  return !/^(\.|\/|~\/|[a-z]+:)/.test(specifier) && !PREVIEW_ONLY.has(specifier) && !/\.css(\?|$)/.test(specifier);
}

export function vendorEntries(modules) {
  const entries = new Set(BASE_ENTRIES);
  for (const module of Object.values(modules)) for (const dep of [...(module.deps ?? []), ...(module.dynamicDeps ?? [])]) if (isBare(dep)) entries.add(dep.split('?')[0]);
  return [...entries].sort();
}

export function vendorKey(lockfileHash, entries, assets) {
  return createHash('sha256').update(`${lockfileHash}\n${entries.join(',')}\n${assets.join(',')}`).digest('hex');
}

export const entryFile = specifier => `${specifier.replace(/^@/, '').replace(/[^a-zA-Z0-9._-]/g, '__')}.js`;

export async function buildVendor({ root, entries, assets, out }) {
  const { rolldown } = await import(pathToFileURL(path.join(root, 'node_modules/rolldown/dist/index.mjs')).href);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const input = Object.fromEntries(entries.map(specifier => [entryFile(specifier).replace(/\.js$/, ''), specifier]));
  const bundle = await rolldown({
    input,
    cwd: root,
    platform: 'browser',
    external: [/^node:/],
    transform: { define: { 'process.env.NODE_ENV': '"production"' } },
    resolve: { conditionNames: ['production', 'browser', 'import', 'module', 'default'] },
    logLevel: 'silent',
  });
  await bundle.write({ dir: out, format: 'es', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js', minify: true });
  await bundle.close();
  for (const asset of assets) {
    const from = path.join(root, 'node_modules', asset);
    if (!existsSync(from)) continue;
    await mkdir(path.dirname(path.join(out, 'assets', asset)), { recursive: true });
    await cp(from, path.join(out, 'assets', asset));
  }
  const lockfileHash = createHash('sha256').update(await readFile(path.join(root, 'package-lock.json'))).digest('hex');
  const key = vendorKey(lockfileHash, entries, assets);
  const manifest = { key, lockfileHash, entries: Object.fromEntries(entries.map(specifier => [specifier, entryFile(specifier)])), assets };
  await writeFile(path.join(out, 'vendor.json'), JSON.stringify(manifest));
  return manifest;
}

async function main() {
  const options = Object.fromEntries(
    process.argv.slice(2).map(arg => {
      const [key, ...value] = arg.replace(/^--/, '').split('=');
      return [key, value.length ? value.join('=') : 'true'];
    }),
  );
  const root = path.resolve(options.design ?? process.cwd());
  let entries = options.entries ? JSON.parse(options.entries) : null;
  let assets = options.assets ? JSON.parse(options.assets) : null;
  if (!entries || !assets) {
    const previous = process.cwd();
    process.chdir(root);
    const sync = await import(pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), 'sync.mjs')).href);
    const { readdir } = await import('node:fs/promises');
    const files = [];
    const walk = async prefix => {
      for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(`${prefix}${entry.name}/`);
        else if (/\.(tsx?|jsx?|mjs)$/.test(entry.name)) files.push(`${prefix}${entry.name}`);
      }
    };
    await walk('app/');
    const sources = new Map(await Promise.all(files.map(async file => [file, await readFile(path.join(root, file), 'utf8')])));
    const compiled = await sync.compileModules(files, sources, { tag: false });
    const manifestFile = JSON.parse(await readFile(path.join(root, '.studio/manifest.json'), 'utf8').catch(() => '{}'));
    entries ??= vendorEntries(compiled.modules);
    assets ??= (await sync.buildCss(manifestFile.cssEntry ?? 'app/styles/app.css'))?.assets ?? [];
    process.chdir(previous);
  }
  const out = path.resolve(options.out ?? path.join(root, '.studio/cache/vendor'));
  const manifest = await buildVendor({ root, entries, assets, out });
  process.stdout.write(`${JSON.stringify({ ...manifest, out })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
