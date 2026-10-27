#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', '.react-router', 'coverage']);
const SKIP_PATHS = new Set(['.studio/toolchain', '.studio/state', '.studio/cache']);
const SKIP_FILES = new Set(['.DS_Store', '.npmrc']);
const MODULE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs']);
const STYLE_SOURCES = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html', '.md', '.mdx', '.json']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tif', '.tiff', '.heic']);
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 200 * 1024;
const MAX_OUTPUT = 512 * 1024;

const root = process.cwd();
const stateDir = path.join(root, '.studio', 'state');
const SINCE = path.join(stateDir, 'types-since.json');
const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const option = name => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const timings = {};

function hash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function treeId(files) {
  const lines = Object.keys(files)
    .sort()
    .map(file => `${file}\0${files[file]}\n`)
    .join('');
  return hash(lines);
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

function safePath(file) {
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Path outside the design: ${file}`);
  return resolved;
}

async function walk(dir, prefix, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const relative = `${prefix}${entry.name}`;
      if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(relative)) await walk(path.join(dir, entry.name), `${relative}/`, out);
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

const TAGGED_COMPONENTS = new Set(['Picture', 'Image']);

export async function tagSources(file, source) {
  if (!/\.[jt]sx$/.test(file)) return source;
  const { parseAst } = await import('rolldown/parseAst');
  const inserts = [];
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const opening = node.type === 'JSXElement' ? node.openingElement : null;
    if (opening && opening.name.type === 'JSXIdentifier' && (/^[a-z]/.test(opening.name.name) || TAGGED_COMPONENTS.has(opening.name.name))) {
      if (!opening.attributes.some(attribute => attribute.name?.name === 'data-studio-source')) {
        const children = node.children ?? [];
        const text = children.length > 0 && children.every(child => child.type === 'JSXText') && children.some(child => child.value.trim());
        const src = opening.attributes.find(attribute => attribute.type === 'JSXAttribute' && attribute.name?.name === 'src' && attribute.value?.type === 'Literal' && typeof attribute.value.value === 'string');
        inserts.push({ node: opening, text, src: src ? src.value.value : null });
      }
    }
    for (const key in node) if (key !== 'parent') visit(node[key]);
  };
  visit(parseAst(source, { lang: file.endsWith('.tsx') ? 'tsx' : 'jsx' }));
  const lineStarts = [0];
  for (let index = 0; index < source.length; index++) if (source[index] === '\n') lineStarts.push(index + 1);
  const position = offset => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return `${low + 1}:${offset - lineStarts[low] + 1}`;
  };
  let out = source;
  for (const { node, text, src } of inserts.sort((a, b) => b.node.name.end - a.node.name.end)) {
    const marks = `${text ? ' data-studio-text' : ''}${src !== null ? ` data-studio-src="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"` : ''}`;
    out = `${out.slice(0, node.name.end)} data-studio-source="${file}:${position(node.start)}"${marks}${out.slice(node.name.end)}`;
  }
  return out;
}

export async function compileModules(paths, sources, { tag = true } = {}) {
  if (!paths.length) return { modules: {}, errors: [] };
  const vite = await import('vite');
  const modules = {};
  const errors = [];
  for (const file of paths) {
    const source = sources.get(file);
    try {
      const lang = path.extname(file).slice(1).replace('mjs', 'js');
      const tagged = tag ? await tagSources(file, source) : source;
      const oxc = await vite.transformWithOxc(tagged, file, { lang, jsx: { runtime: 'automatic', importSource: 'react' }, sourcemap: false });
      const runner = await vite.moduleRunnerTransform(oxc.code, null, `/${file}`, source);
      modules[file] = { code: runner.code, deps: runner.deps ?? [], dynamicDeps: runner.dynamicDeps ?? [], source: hash(source) };
    } catch (error) {
      const loc = error.loc ?? error.errors?.[0]?.labels?.[0] ?? {};
      errors.push({ file, line: loc.line ?? null, column: loc.column ?? null, message: String(error.message ?? error).split('\n')[0] });
    }
  }
  return { modules, errors };
}

export async function buildCss(entry) {
  const entryPath = path.join(root, entry);
  if (!existsSync(entryPath)) return null;
  const [{ compile }, { Scanner }] = await Promise.all([import('@tailwindcss/node'), import('@tailwindcss/oxide')]);
  const css = await readFile(entryPath, 'utf8');
  const compiler = await compile(css, { base: path.dirname(entryPath), onDependency: () => {}, shouldRewriteUrls: true });
  const rootSource = compiler.root === 'none' ? [] : compiler.root === null ? [{ base: root, pattern: '**/*', negated: false }] : [{ ...compiler.root, negated: false }];
  const scanner = new Scanner({ sources: [...rootSource, ...compiler.sources] });
  const assets = new Set();
  const out = compiler.build(scanner.scan()).replace(/url\((['"]?)([^'")]+)\1\)/g, (match, quote, url) => {
    if (/^(data:|https?:|\/\/|#)/.test(url)) return match;
    const resolved = path.relative(root, path.resolve(path.dirname(entryPath), url.split(/[?#]/)[0]));
    if (resolved.startsWith('..')) return match;
    if (resolved.startsWith('node_modules/')) {
      const asset = resolved.slice('node_modules/'.length);
      assets.add(asset);
      return `url(${quote}__VENDOR__/assets/${asset}${quote})`;
    }
    return `url(${quote}__FILES__/${resolved}${quote})`;
  });
  return { css: out, assets: [...assets].sort() };
}

async function moduleSources(files) {
  const sources = new Map();
  for (const file of files) {
    if (file.startsWith('app/') && MODULE_EXT.has(path.extname(file))) sources.set(file, await readFile(path.join(root, file), 'utf8'));
  }
  return sources;
}

const TS_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const LINTABLE = /^app\/.*\.(tsx?|jsx?|mjs)$/;
const TYPED = /^(app\/.*\.(tsx?|jsx?|mjs)|tsconfig\.json)$/;
const ROUTE_SHAPE = /^app\/(routes\.ts|root\.tsx|routes\/)/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function typeErrors(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const match = line.trim().match(TS_LINE);
    if (match) out.push({ file: match[1], line: Number(match[2]), column: Number(match[3]), rule: match[4], message: match[5] });
  }
  return out;
}

export function lintErrors(reports) {
  const out = [];
  for (const report of reports) {
    const file = report.filePath.startsWith(`${root}/`) ? report.filePath.slice(root.length + 1) : report.filePath;
    for (const message of report.messages) if (message.severity === 2) out.push({ file, line: message.line ?? null, column: message.column ?? null, rule: message.ruleId, message: message.message });
  }
  return out;
}

function why(result) {
  if (result.error?.code === 'ETIMEDOUT' || result.signal) return 'it ran out of time';
  const said = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.split('\n').map(line => line.trim()).filter(Boolean).slice(-2).join(' ');
  return said || `it exited with ${result.status}`;
}

const unchecked = (file, message) => [{ file, line: null, column: null, rule: null, message }];

export function typeResult(result) {
  const types = typeErrors(result.stdout ?? '');
  if (types.length || (result.status === 0 && !result.error)) return types;
  return unchecked('tsconfig.json', `The type check did not finish (${why(result)}), so types were not checked.`);
}

export function lintResult(result, files) {
  if (!result.error && (result.status === 0 || result.status === 1)) {
    try {
      return lintErrors(JSON.parse(result.stdout || '[]'));
    } catch {}
  }
  return unchecked('eslint.config.js', `Lint did not run (${why(result)}), so ${files.length} file(s) were not linted.`);
}

function alive(pidFile) {
  const pid = Number(readFileSyncSafe(pidFile));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readFileSyncSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function tscLogSize() {
  return readFileSyncSafe(path.join(stateDir, 'tsc.log')).length;
}

async function waitForTypes(offset, timeoutMs) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const log = readFileSyncSafe(path.join(stateDir, 'tsc.log'));
    const fresh = log.slice(offset);
    const found = fresh.lastIndexOf('Found ');
    if (found >= 0 && /Found \d+ errors?\. Watching for file changes/.test(fresh.slice(found))) {
      const cycle = fresh.slice(0, found);
      const start = Math.max(cycle.lastIndexOf('Starting incremental compilation'), cycle.lastIndexOf('Starting compilation in watch mode'));
      return typeErrors(start >= 0 ? cycle.slice(start) : cycle);
    }
    await sleep(40);
  }
  return null;
}

function coldTypes() {
  return typeResult(spawnSync('npx', ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8', timeout: 300_000 }));
}

function typegen() {
  const result = spawnSync('npx', ['--no-install', 'react-router', 'typegen'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  return result.status === 0 && !result.error ? [] : unchecked('app/routes.ts', `Route types could not be generated (${why(result)}).`);
}

function watching() {
  return existsSync(path.join(stateDir, 'tsc.log')) && alive(path.join(stateDir, 'tsc.pid'));
}

async function diagnose(touched, offset) {
  const started = performance.now();
  const packagesChanged = touched.includes('package-lock.json');
  const typedChange = packagesChanged || touched.some(file => TYPED.test(file));
  const generated = touched.some(file => ROUTE_SHAPE.test(file)) ? typegen() : [];
  let types = [];
  if (typedChange) types = (!packagesChanged && watching() ? await waitForTypes(offset, 8000) : null) ?? coldTypes();
  timings.typesMs = Math.round(performance.now() - started);
  return { types: [...generated, ...types], lint: await lintFiles(touched) };
}

export function latestTypes(log, offset) {
  const fresh = log.slice(offset);
  const end = fresh.lastIndexOf('Found ');
  const begin = Math.max(fresh.lastIndexOf('Starting incremental compilation'), fresh.lastIndexOf('Starting compilation in watch mode'));
  if (end < 0 || begin < 0 || begin > end || !/Found \d+ errors?\. Watching for file changes/.test(fresh.slice(end))) return null;
  return typeErrors(fresh.slice(begin, end));
}

async function typesNow(since) {
  const started = performance.now();
  const generated = since?.typegen ? typegen() : [];
  let types = null;
  if (!since?.typegen && !since?.packages && watching()) {
    for (let waited = 0; waited < 8000 && types === null; waited += 40) {
      types = latestTypes(readFileSyncSafe(path.join(stateDir, 'tsc.log')), since?.offset ?? 0);
      if (types === null) await sleep(40);
    }
  }
  timings.typesMs = Math.round(performance.now() - started);
  return [...generated, ...(types ?? coldTypes())];
}

async function noteUnchecked(changed, deleted, known, offset) {
  const touched = [...changed.map(entry => entry.path), ...deleted];
  const packages = touched.includes('package-lock.json');
  const reshaped = touched.some(file => file === 'app/routes.ts' || file === 'app/root.tsx') || [...changed.filter(entry => !known.files[entry.path]).map(entry => entry.path), ...deleted].some(file => file.startsWith('app/routes/'));
  if (!packages && !reshaped && !touched.some(file => TYPED.test(file))) return;
  const before = await readJson(SINCE, null);
  await writeFile(SINCE, JSON.stringify({ offset, packages: Boolean(before?.packages || packages), typegen: Boolean(before?.typegen || reshaped) }));
}

async function check(known, { noCompile = false } = {}) {
  const files = Object.keys(known.files);
  const result = { tree: known.tree, previousTree: known.tree, changed: [], deleted: [], refused: [], modules: {}, compileErrors: [], css: null, cssAssets: [], command: null };
  if (!noCompile) {
    const compileStarted = performance.now();
    const sources = await moduleSources(files);
    result.compileErrors = (await compileModules([...sources.keys()], sources, { tag: false })).errors;
    timings.compileMs = Math.round(performance.now() - compileStarted);
  }
  const since = await readJson(SINCE, null);
  result.types = await typesNow(since);
  result.lint = await lintFiles(files);
  await rm(SINCE, { force: true });
  return result;
}

async function lintFiles(files) {
  const lintStarted = performance.now();
  const lintable = files.filter(file => LINTABLE.test(file) && existsSync(path.join(root, file)));
  let lint = [];
  if (lintable.length) {
    let reports = null;
    if (alive(path.join(stateDir, 'lint-daemon.pid'))) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await writeFile(path.join(stateDir, 'lint-request.json'), JSON.stringify({ id, files: lintable }));
      const answer = path.join(stateDir, `lint-${id}.json`);
      for (let waited = 0; waited < 8000 && !existsSync(answer); waited += 40) await sleep(40);
      if (existsSync(answer)) {
        reports = JSON.parse(await readFile(answer, 'utf8'));
        await rm(answer, { force: true });
      }
    }
    lint = reports
      ? lintErrors(reports)
      : lintResult(spawnSync('npx', ['--no-install', 'eslint', '--format', 'json', ...lintable], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }), lintable);
  }
  timings.lintMs = Math.round(performance.now() - lintStarted);
  return lint;
}

async function promote(expected) {
  const pending = await readJson(path.join(stateDir, 'pending.json'), null);
  if (pending && pending.tree === expected) await rename(path.join(stateDir, 'pending.json'), path.join(stateDir, 'known.json'));
}

function runCommand(command, timeoutMs) {
  const started = performance.now();
  const script = path.join(stateDir, 'command.sh');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(script, `{\n${command}\n} 2>&1\n`);
  const result = spawnSync('bash', ['-l', script], { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.error ? `\n${result.error.message}` : ''}`;
  const exitCode = result.status ?? (result.signal ? 124 : 1);
  return {
    output: output.length > MAX_OUTPUT ? `${output.slice(0, MAX_OUTPUT / 2)}\n…\n${output.slice(-MAX_OUTPUT / 2)}` : output,
    exitCode,
    durationMs: Math.round(performance.now() - started),
  };
}

async function applyWrites(step) {
  for (const [file, entry] of Object.entries(step.write ?? {})) {
    const target = safePath(file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.base64 !== undefined ? Buffer.from(entry.base64, 'base64') : entry.text);
  }
  for (const file of step.delete ?? []) await rm(safePath(file), { force: true });
}

async function main() {
  const started = performance.now();
  const step = option('--step') ? await readJson(path.resolve(root, option('--step')), {}) : {};
  await mkdir(stateDir, { recursive: true });
  const tscOffset = tscLogSize();
  if (step.promote) await promote(step.promote);
  if (step.check) {
    const known = await readJson(path.join(stateDir, 'known.json'), { tree: null, files: {} });
    return answer(await check(known, { noCompile: Boolean(step.noCompile) || flag('--no-compile') }), started);
  }
  if (step.replaceAll) {
    const existing = await walk(root, '', []);
    const keep = new Set(Object.keys(step.write ?? {}));
    step.delete = [...(step.delete ?? []), ...existing.filter(file => !keep.has(file) && !file.startsWith('.studio/'))];
  }
  await applyWrites(step);
  const command = step.run ? runCommand(step.run, step.timeoutMs ?? 14 * 60 * 1000) : null;
  timings.stepMs = Math.round(performance.now() - started);
  const manifest = await readJson(path.join(root, '.studio', 'manifest.json'), {});
  const protectedPaths = new Set(manifest.protected ?? []);
  const known = await readJson(path.join(stateDir, 'known.json'), { tree: null, files: {} });
  const files = await walk(root, '', []);
  const current = {};
  const contents = new Map();
  const changed = [];
  const refused = [];
  for (const file of files) {
    const buffer = await readFile(path.join(root, file));
    const digest = hash(buffer);
    if (known.files[file] === digest) {
      current[file] = digest;
      continue;
    }
    const tooLarge = IMAGE_EXT.has(path.extname(file).toLowerCase())
      ? buffer.length > MAX_IMAGE_BYTES && 'Photos go in the store’s media library, not the code. Import it with the image tools and use a content field.'
      : buffer.length > MAX_TEXT_BYTES && 'Files over 1 MB can’t be saved in a design.';
    if (tooLarge) {
      refused.push({ path: file, reason: tooLarge });
      if (known.files[file]) current[file] = known.files[file];
      continue;
    }
    if (protectedPaths.has(file) && known.tree && !step.allowProtected) {
      refused.push({ path: file, reason: 'This file is protected and was put back.' });
      if (known.files[file]) current[file] = known.files[file];
      continue;
    }
    current[file] = digest;
    const entry = { path: file, hash: digest, size: buffer.length };
    if (isBinary(buffer)) entry.base64 = buffer.toString('base64');
    else {
      entry.text = buffer.toString('utf8');
      contents.set(file, entry.text);
    }
    changed.push(entry);
  }
  const guarded = file => protectedPaths.has(file) && !step.allowProtected;
  const deleted = Object.keys(known.files).filter(file => !(file in current) && !guarded(file));
  for (const file of Object.keys(known.files)) {
    if (file in current || !guarded(file)) continue;
    current[file] = known.files[file];
    refused.push({ path: file, reason: 'This file is protected and was put back.' });
  }
  timings.scanMs = Math.round(performance.now() - started) - timings.stepMs;
  const tree = treeId(current);
  const result = { tree, previousTree: known.tree, changed, deleted, refused, modules: {}, compileErrors: [], css: null, cssAssets: [], command };
  const anyChange = changed.length || deleted.length || !known.tree;
  if (anyChange) await writeFile(path.join(stateDir, 'pending.json'), JSON.stringify({ tree, files: current }));
  if ((anyChange || step.compileAll) && !step.noCompile && !flag('--no-compile')) {
    const compileStarted = performance.now();
    const sources = step.compileAll ? await moduleSources(Object.keys(current)) : contents;
    const moduleFiles = step.compileAll
      ? [...sources.keys()]
      : changed.filter(entry => entry.text !== undefined && MODULE_EXT.has(path.extname(entry.path)) && entry.path.startsWith('app/')).map(entry => entry.path);
    const compiled = await compileModules(moduleFiles, sources);
    result.modules = compiled.modules;
    result.compileErrors = compiled.errors;
    timings.compileMs = Math.round(performance.now() - compileStarted);
    if (step.compileAll || [...changed.map(entry => entry.path), ...deleted].some(file => STYLE_SOURCES.has(path.extname(file)))) {
      const cssStarted = performance.now();
      try {
        const built = await buildCss(manifest.cssEntry ?? 'app/styles/app.css');
        result.css = built?.css ?? null;
        result.cssAssets = built?.assets ?? [];
      } catch (error) {
        result.compileErrors.push({ file: manifest.cssEntry ?? 'app/styles/app.css', line: null, column: null, message: String(error.message ?? error).split('\n')[0] });
      }
      timings.cssMs = Math.round(performance.now() - cssStarted);
    }
  }
  result.types = [];
  result.lint = [];
  const touched = [...changed.map(entry => entry.path), ...deleted];
  if (step.diagnose && touched.length) Object.assign(result, await diagnose(touched, tscOffset));
  else if (touched.length) await noteUnchecked(changed, deleted, known, tscOffset);
  if (flag('--promote') || step.promoteNow) await writeFile(path.join(stateDir, 'known.json'), JSON.stringify({ tree, files: current }));
  await answer(result, started);
}

async function answer(result, started) {
  timings.totalMs = Math.round(performance.now() - started);
  result.timings = timings;
  const text = JSON.stringify(result);
  await writeFile(path.join(stateDir, 'result.json'), text);
  process.stdout.write(`\n@@STUDIO_RESULT@@${text}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stdout.write(`\n@@STUDIO_RESULT@@${JSON.stringify({ error: String(error.message ?? error) })}`);
    process.exitCode = 1;
  });
}
