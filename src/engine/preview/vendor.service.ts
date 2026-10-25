import { Injectable, Logger } from '@nestjs/common';
import { unpackToStorage } from '../storage/archives';
import { Storage } from '../storage/storage';
import { shellQuote } from '../workspaces/workspace';
import type { OpenSession } from '../workspaces/workspace.service';
import { vendorKey } from './vendor';

const CACHE_LIMIT = 400;

export class VendorBuildError extends Error {}

@Injectable()
export class VendorService {
  private readonly logger = new Logger(VendorService.name);
  private readonly files = new Map<string, Buffer>();
  private readonly building = new Map<string, Promise<string>>();

  constructor(private readonly storage: Storage) {}

  async ensure(session: OpenSession, lockfileHash: string, entries: string[], assets: string[]): Promise<string> {
    const key = vendorKey(lockfileHash, entries, assets);
    if (await this.storage.has(`vendor/${key}/vendor.json`)) return key;
    let pending = this.building.get(key);
    if (!pending) {
      pending = this.build(session, key, entries, assets).finally(() => this.building.delete(key));
      this.building.set(key, pending);
    }
    return pending;
  }

  async file(key: string, file: string): Promise<Buffer | null> {
    const cacheKey = `${key}/${file}`;
    const cached = this.files.get(cacheKey);
    if (cached) return cached;
    const bytes = await this.storage.get(`vendor/${cacheKey}`);
    if (bytes) {
      this.files.set(cacheKey, bytes);
      if (this.files.size > CACHE_LIMIT) this.files.delete(this.files.keys().next().value!);
    }
    return bytes;
  }

  private async build(session: OpenSession, key: string, entries: string[], assets: string[]): Promise<string> {
    const started = Date.now();
    const out = `.studio/cache/vendor-${key.slice(0, 16)}`;
    const built = await session.workspace.exec(
      `node .studio/toolchain/vendor.mjs --entries=${shellQuote(JSON.stringify(entries))} --assets=${shellQuote(JSON.stringify(assets))} --out=${out} > .studio/state/vendor.json && tar -czf .studio/state/vendor.tgz -C ${out} . && rm -rf ${out} && cat .studio/state/vendor.json`,
      600_000,
    );
    if (built.exitCode !== 0) throw new VendorBuildError(`Bundling packages for the preview failed: ${(built.stderr || built.stdout).slice(-1500)}`);
    const reported = JSON.parse(built.stdout.slice(built.stdout.indexOf('{'))) as { key: string };
    if (reported.key !== key) throw new VendorBuildError(`The package bundle key ${reported.key} does not match ${key}`);
    const archiveKey = `vendor/${key}.tar.gz`;
    await session.workspace.upload('.studio/state/vendor.tgz', { url: await this.storage.signedPutUrl(archiveKey, 900), localPath: this.storage.localPath(archiveKey) });
    await this.unpack(key, archiveKey);
    this.logger.log(`Bundled ${entries.length} packages for previews in ${Date.now() - started} ms (${key.slice(0, 12)})`);
    return key;
  }

  async unpack(key: string, archiveKey: string): Promise<void> {
    const archive = await this.storage.get(archiveKey);
    if (!archive) throw new VendorBuildError('The package bundle did not reach storage');
    await unpackToStorage(this.storage, archive, `vendor/${key}`, 'vendor.json');
  }
}
