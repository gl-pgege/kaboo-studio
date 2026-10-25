import type { PreviewResult } from '../../contract';
import { Injectable } from '@nestjs/common';
import type { Design } from '../../generated/prisma/client';
import type { SyncResult } from '../drafts/sync-result';
import { metrics } from '../scaling/metrics';
import { Storage } from '../storage/storage';
import { sha256 } from '../versions/tree';
import { VersionStore } from '../versions/version-store.service';
import type { OpenSession } from '../workspaces/workspace.service';
import { PreviewChannel } from './preview-channel.service';
import { vendorEntries } from './vendor';
import { VendorService } from './vendor.service';

export interface PreviewModule {
  hash: string;
  deps: string[];
  dynamicDeps: string[];
}

export interface PreviewManifest {
  tree: string;
  design: string;
  store: string;
  vendor: string;
  css: string | null;
  cssAssets: string[];
  modules: Record<string, PreviewModule>;
  files: Record<string, string>;
  createdAt: string;
}

const MODULE_FILE = /^app\/.*\.(tsx?|jsx?|mjs)$/;
const RELOADS = new Set(['app/root.tsx', 'app/routes.ts', 'package.json', 'package-lock.json']);
const MANIFEST_CACHE = 100;

@Injectable()
export class PreviewService {
  private readonly manifests = new Map<string, PreviewManifest>();

  constructor(
    private readonly storage: Storage,
    private readonly versions: VersionStore,
    private readonly channel: PreviewChannel,
    private readonly vendor: VendorService,
  ) {}

  async manifest(store: string, tree: string): Promise<PreviewManifest | null> {
    const cached = this.manifests.get(`${store}/${tree}`);
    if (cached) return cached;
    const bytes = await this.storage.get(this.manifestKey(store, tree));
    if (!bytes) return null;
    return this.remember(JSON.parse(bytes.toString('utf8')) as PreviewManifest);
  }

  async module(store: string, hash: string): Promise<Buffer | null> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    return this.storage.get(`stores/${store}/modules/${hash}`);
  }

  async publish(design: Design, tree: string, sync: SyncResult, session: OpenSession, compileAll: () => Promise<SyncResult>): Promise<PreviewResult> {
    const compileErrors: PreviewResult = { status: 'compile-errors', tree: null, route: null, ms: null, errors: [], faults: [] };
    if (sync.compileErrors.length) {
      await this.channel.publishError(design.id, tree, sync.compileErrors);
      return compileErrors;
    }
    const started = performance.now();
    const previous = sync.previousTree ? await this.manifest(design.store, sync.previousTree) : null;
    const update = previous ? await this.next(design, previous, tree, sync, session) : await this.full(design, tree, await compileAll(), session);
    if (!update) return compileErrors;
    const seq = await this.channel.nextSeq(design.id);
    await this.channel.publishUpdate(design.id, { tree, seq, manifest: tree, modules: update.changed, deleted: update.deleted, css: update.manifest.css, reload: update.reload });
    metrics.stage('publish', performance.now() - started);
    const result = await metrics.time('ack', () => this.channel.result(design.id, tree));
    if (result.status === 'timeout') metrics.count('PreviewAckTimeouts');
    return result;
  }

  async rebuild(design: Design, tree: string, sync: SyncResult, session: OpenSession): Promise<PreviewManifest | null> {
    const update = await this.full(design, tree, sync, session);
    return update?.manifest ?? null;
  }

  private async next(design: Design, previous: PreviewManifest, tree: string, sync: SyncResult, session: OpenSession) {
    const modules = { ...previous.modules };
    const changed: Record<string, string> = {};
    const deleted = sync.deleted.filter(file => MODULE_FILE.test(file));
    for (const file of deleted) delete modules[file];
    for (const [file, compiled] of Object.entries(sync.modules)) {
      const hash = await this.putModule(design.store, compiled.code);
      modules[file] = { hash, deps: compiled.deps, dynamicDeps: compiled.dynamicDeps };
      changed[file] = hash;
    }
    const css = sync.css !== null ? await this.putModule(design.store, sync.css) : previous.css;
    const cssAssets = sync.css !== null ? sync.cssAssets : previous.cssAssets;
    const manifest = await this.write(design, tree, modules, css, cssAssets, session);
    const touched = [...sync.changed.map(entry => entry.path), ...sync.deleted];
    const reload = manifest.vendor !== previous.vendor || deleted.length > 0 || touched.some(file => RELOADS.has(file));
    return { manifest, changed, deleted, reload };
  }

  private async full(design: Design, tree: string, sync: SyncResult, session: OpenSession) {
    if (sync.compileErrors.length) {
      await this.channel.publishError(design.id, tree, sync.compileErrors);
      return null;
    }
    const modules: Record<string, PreviewModule> = {};
    for (const [file, compiled] of Object.entries(sync.modules)) modules[file] = { hash: await this.putModule(design.store, compiled.code), deps: compiled.deps, dynamicDeps: compiled.dynamicDeps };
    const css = sync.css !== null ? await this.putModule(design.store, sync.css) : null;
    const manifest = await this.write(design, tree, modules, css, sync.cssAssets ?? [], session);
    return { manifest, changed: Object.fromEntries(Object.entries(modules).map(([file, entry]) => [file, entry.hash])), deleted: [] as string[], reload: true };
  }

  private async write(design: Design, tree: string, modules: Record<string, PreviewModule>, css: string | null, cssAssets: string[], session: OpenSession): Promise<PreviewManifest> {
    const files = await this.versions.tree(design.store, tree);
    const lockfile = files['package-lock.json'] ?? '';
    const vendor = await this.vendor.ensure(session, lockfile, vendorEntries(modules), cssAssets);
    const manifest: PreviewManifest = {
      tree,
      design: design.id,
      store: design.store,
      vendor,
      css,
      cssAssets,
      modules,
      files: Object.fromEntries(Object.entries(files).filter(([file]) => (file.startsWith('public/') || file.startsWith('app/')) && !MODULE_FILE.test(file))),
      createdAt: new Date().toISOString(),
    };
    await this.storage.put(this.manifestKey(design.store, tree), JSON.stringify(manifest), 'application/json');
    return this.remember(manifest);
  }

  private async putModule(store: string, code: string): Promise<string> {
    const hash = sha256(code);
    const key = `stores/${store}/modules/${hash}`;
    if (!(await this.storage.has(key))) await this.storage.put(key, code);
    return hash;
  }

  private remember(manifest: PreviewManifest): PreviewManifest {
    this.manifests.set(`${manifest.store}/${manifest.tree}`, manifest);
    if (this.manifests.size > MANIFEST_CACHE) this.manifests.delete(this.manifests.keys().next().value!);
    return manifest;
  }

  private manifestKey(store: string, tree: string) {
    return `stores/${store}/previews/${tree}.json`;
  }
}
