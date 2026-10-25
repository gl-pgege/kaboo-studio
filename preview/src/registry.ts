import { resolveSpecifier, type Resolved } from './resolve.ts';

export interface ManifestModule {
  hash: string;
  deps: string[];
  dynamicDeps: string[];
}

export interface Manifest {
  tree: string;
  design: string;
  store: string;
  vendor: string;
  css: string | null;
  cssAssets: string[];
  modules: Record<string, ManifestModule>;
  files: Record<string, string>;
}

export type Exports = Record<string, unknown>;

interface ModuleRecord {
  path: string;
  hash: string;
  exports: Exports;
  ready: Promise<void>;
  imports: Set<string>;
}

type External = (resolved: Exclude<Resolved, { kind: 'app' }>, importer: string) => Promise<Exports>;

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
const PARAMS = ['__vite_ssr_exports__', '__vite_ssr_import_meta__', '__vite_ssr_import__', '__vite_ssr_dynamic_import__', '__vite_ssr_exportAll__', '__vite_ssr_exportName__'];

export class ModuleError extends Error {
  constructor(
    readonly file: string,
    cause: unknown,
  ) {
    super(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export class Registry {
  private readonly records = new Map<string, ModuleRecord>();

  constructor(
    readonly manifest: Manifest,
    private readonly code: (hash: string) => Promise<string>,
    private readonly external: External,
    inherited?: Registry,
    affected?: Set<string>,
  ) {
    if (inherited) {
      for (const [path, record] of inherited.records) {
        if (!affected?.has(path) && manifest.modules[path]?.hash === record.hash) this.records.set(path, record);
      }
    }
  }

  has(path: string): boolean {
    return path in this.manifest.modules;
  }

  exportsOf(path: string): Exports {
    return this.records.get(path)?.exports ?? {};
  }

  async prefetch(): Promise<void> {
    await Promise.all(Object.values(this.manifest.modules).map(module => this.code(module.hash)));
  }

  affectedBy(changed: Iterable<string>): Set<string> {
    const importers = new Map<string, Set<string>>();
    for (const record of this.records.values()) {
      for (const dep of record.imports) {
        if (!importers.has(dep)) importers.set(dep, new Set());
        importers.get(dep)!.add(record.path);
      }
    }
    const affected = new Set<string>();
    const queue = [...changed];
    while (queue.length) {
      const path = queue.pop()!;
      if (affected.has(path)) continue;
      affected.add(path);
      for (const importer of importers.get(path) ?? []) queue.push(importer);
    }
    return affected;
  }

  load(path: string, chain: string[] = []): Promise<Exports> {
    const existing = this.records.get(path);
    if (existing) return chain.includes(path) ? Promise.resolve(existing.exports) : existing.ready.then(() => existing.exports);
    const entry = this.manifest.modules[path];
    if (!entry) return Promise.reject(new Error(`No module ${path} in this preview`));
    const exports: Exports = Object.create(null);
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const record: ModuleRecord = { path, hash: entry.hash, exports, imports: new Set(), ready: Promise.resolve() };
    this.records.set(path, record);
    record.ready = this.evaluate(record, [...chain, path]).catch(error => {
      this.records.delete(path);
      throw error instanceof ModuleError ? error : new ModuleError(path, error);
    });
    return record.ready.then(() => exports);
  }

  private async evaluate(record: ModuleRecord, chain: string[]): Promise<void> {
    const source = await this.code(record.hash);
    const importModule = async (specifier: string) => {
      const resolved = resolveSpecifier(record.path, specifier, this.manifest.modules, this.manifest.files);
      if (resolved.kind === 'app') {
        record.imports.add(resolved.path);
        if (chain.includes(resolved.path)) return this.records.get(resolved.path)!.exports;
        return this.load(resolved.path, chain);
      }
      return this.external(resolved, record.path);
    };
    const exportAll = (module: Exports) => {
      for (const key of Object.keys(module)) {
        if (key !== 'default' && !(key in record.exports)) Object.defineProperty(record.exports, key, { enumerable: true, configurable: true, get: () => module[key] });
      }
    };
    const exportName = (name: string, getter: () => unknown) => Object.defineProperty(record.exports, name, { enumerable: true, configurable: true, get: getter });
    const meta = {
      url: `${location.origin}/${record.path}`,
      env: { MODE: 'production', DEV: false, PROD: true, SSR: false, BASE_URL: '/' },
      hot: undefined,
    };
    const run = new AsyncFunction(...PARAMS, `"use strict";${source}\n//# sourceURL=studio:///${record.path}`);
    await run(record.exports, meta, importModule, importModule, exportAll, exportName);
  }
}
