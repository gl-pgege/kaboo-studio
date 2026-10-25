import { type Actor, type Brand, type Design, type DesignFlag, type KitUpgradeResult, type TemplateRelease, templateReleaseSchema } from '../../contract';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { DraftService } from '../drafts/draft.service';
import { BusyError } from '../drafts/writers.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudioQueue } from '../queue/studio-queue';
import { Storage } from '../storage/storage';
import { VersionStore } from '../versions/version-store.service';
import { WorkspaceService } from '../workspaces/workspace.service';
import { seedBrand } from './brand';

const run = promisify(execFile);
export const PLATFORM: Actor = { kind: 'platform', name: config.brandName };
const MERGE_DIR = '.studio/cache/template';
const kitLabel = () => config.kitLabel || config.kitPackage;

export class TemplateMissingError extends Error {
  constructor(version: string) {
    super(`The ${config.templateName} template ${version} has not been released to storage.`);
  }
}

const major = (version: string) => Number(version.replace(/^[^\d]*/, '').split('.')[0]);

export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.replace(/^[^\d]*/, '').split(/[.-]/).slice(0, 3).map(Number);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  return 0;
}

async function mergeFile(ours: Buffer, base: Buffer, theirs: Buffer, from: string, to: string): Promise<{ text: Buffer; conflicted: boolean }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-merge-'));
  try {
    await Promise.all([writeFile(path.join(dir, 'ours'), ours), writeFile(path.join(dir, 'base'), base), writeFile(path.join(dir, 'theirs'), theirs)]);
    const args = ['merge-file', '-p', '-L', 'design', '-L', `template ${from}`, '-L', `template ${to}`, 'ours', 'base', 'theirs'];
    try {
      const { stdout } = await run('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
      return { text: Buffer.from(stdout), conflicted: false };
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (typeof failure.code === 'number' && failure.code > 0 && failure.stdout !== undefined) return { text: Buffer.from(failure.stdout), conflicted: true };
      throw error;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function walk(dir: string, prefix = '', out = new Map<string, Buffer>()): Promise<Map<string, Buffer>> {
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await walk(dir, `${relative}/`, out);
    else if (entry.isFile()) out.set(relative, await readFile(path.join(dir, relative)));
  }
  return out;
}

@Injectable()
export class TemplateService implements OnModuleInit {
  private readonly logger = new Logger(TemplateService.name);
  private readonly releases = new Map<string, Map<string, Buffer>>();

  constructor(
    private readonly storage: Storage,
    private readonly prisma: PrismaService,
    private readonly designs: DesignService,
    private readonly drafts: DraftService,
    private readonly versions: VersionStore,
    private readonly workspaces: WorkspaceService,
    private readonly queue: StudioQueue,
  ) {}

  async onModuleInit() {
    this.queue.register('kit-upgrades', {
      concurrency: config.kitUpgradeConcurrency,
      oneAtATime: data => String(data.store ?? 'sweep'),
      process: async job => {
        if (job.name === 'sweep') return { queued: await this.queueNightlyUpgrades() };
        const { store, version } = job.data as { store: string; version: string };
        const results = await this.upgradeStores(version, [store]);
        return { upgraded: results.filter(result => result.outcome === 'upgraded').length, failed: results.filter(result => result.outcome === 'failed').length };
      },
    });
    if (config.role !== 'api')
      await this.queue
        .queue('kit-upgrades')
        .upsertJobScheduler('nightly-kit-upgrades', { pattern: config.kitUpgradeSchedule, tz: 'UTC' }, { name: 'sweep', data: {} })
        .catch(error => this.logger.warn(`Scheduling nightly kit upgrades failed: ${String(error)}`));
  }

  async queueNightlyUpgrades(): Promise<number> {
    const release = await this.latest();
    const behind = await this.prisma.design.findMany({ where: { status: 'active', kitVersion: { not: release.kitVersion } }, select: { store: true, kitVersion: true } });
    const stores = [...new Set(behind.filter(design => compareVersions(design.kitVersion, release.kitVersion) < 0).map(design => design.store))].map(store => ({ store }));
    for (const { store } of stores) {
      const delay = parseInt(createHash('sha256').update(store).digest('hex').slice(0, 8), 16) % Math.max(1, config.kitUpgradeSpreadMs);
      await this.queue.add('kit-upgrades', 'store', { store, version: release.kitVersion }, { jobId: `kit-${store}-${release.kitVersion}`, delay });
    }
    return stores.length;
  }

  async latest(): Promise<TemplateRelease> {
    const pointer = await this.storage.get(`templates/${config.templateName}-latest.json`);
    if (!pointer) throw new TemplateMissingError('latest');
    return templateReleaseSchema.parse(JSON.parse(pointer.toString('utf8')));
  }

  async files(version: string): Promise<Map<string, Buffer>> {
    const cached = this.releases.get(version);
    if (cached) return new Map(cached);
    const archive = await this.storage.get(`templates/${config.templateName}-${version}.tar.gz`);
    if (!archive) throw new TemplateMissingError(version);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-template-'));
    try {
      await writeFile(path.join(dir, 'template.tar.gz'), archive);
      await run('tar', ['-xzf', 'template.tar.gz', '-C', dir, '--no-same-owner'], { cwd: dir });
      await rm(path.join(dir, 'template.tar.gz'));
      const files = await walk(dir);
      this.releases.set(version, files);
      return new Map(files);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async create(input: { store: string; name: string; actor: Actor; brand?: Brand | null }): Promise<Design> {
    const release = await this.latest();
    let files = await this.files(release.version);
    if (input.brand) {
      const manifest = JSON.parse(files.get('.studio/manifest.json')?.toString('utf8') ?? '{}') as { cssEntry?: string };
      files = seedBrand(files, input.brand, manifest.cssEntry ?? 'app/styles/app.css');
    }
    return this.designs.create({
      store: input.store,
      name: input.name,
      actor: input.actor,
      files,
      templateVersion: release.version,
      kitVersion: release.kitVersion,
      message: `Created from the ${config.templateName} template ${release.version}`,
    });
  }

  async upgradeKit(designId: string, store: string, version: string): Promise<KitUpgradeResult> {
    const { design, draft } = await this.designs.get(designId, store);
    const result = (outcome: KitUpgradeResult['outcome'], message: string, number: number | null = null): KitUpgradeResult => ({ designId, store, outcome, message, version: number });
    if (!config.kitPackage) return result('current', 'This studio has no kit package to update');
    if (compareVersions(design.kitVersion, version) >= 0) return result('current', `Already on ${config.kitPackage} ${design.kitVersion}`);
    if (major(version) !== major(design.kitVersion)) return result('skipped', `${version} is a major release: an assistant moves designs to it with a migration recipe`);
    const head = draft.headVersion ? await this.versions.version(designId, draft.headVersion) : null;
    if (!head || head.tree !== draft.tree) return result('skipped', 'The design has changes that are not in a version yet');
    const owner = `platform:kit-upgrade:${version}`;
    try {
      const install = await this.drafts.change(designId, store, PLATFORM, { kind: 'command', command: `npm install ${config.kitPackage}@${version} --save-exact --loglevel=error` }, { owner, ownerTtlMs: 20 * 60_000 });
      const checks = install.result.command?.exitCode === 0 ? await this.drafts.change(designId, store, PLATFORM, { kind: 'command', command: config.templateChecks }, { owner, ownerTtlMs: 20 * 60_000 }) : install;
      if (checks.result.command?.exitCode !== 0) {
        await this.drafts.change(designId, store, PLATFORM, { kind: 'tree', tree: head.tree }, { owner, ownerTtlMs: 20 * 60_000 });
        const output = (checks.result.command?.output ?? '').split('\n').filter(line => /error|Error|failed|✘/.test(line)).slice(0, 20);
        await this.flag(designId, { kind: 'kit-upgrade-failed', message: `Updating ${kitLabel()} to ${version} failed its checks, so the design was left on ${design.kitVersion}.`, details: output, at: new Date().toISOString() });
        return result('failed', `Checks failed; left on ${design.kitVersion}`);
      }
      const saved = await this.drafts.commit(designId, store, PLATFORM, `Updated ${kitLabel()} to ${version}`);
      await this.prisma.design.update({ where: { id: designId }, data: { kitVersion: version, flags: (design.flags as DesignFlag[]).filter(flag => flag.kind !== 'kit-upgrade-failed') as Prisma.InputJsonValue } });
      return result('upgraded', `Updated ${kitLabel()} to ${version}`, saved?.number ?? null);
    } catch (error) {
      if (error instanceof BusyError) return result('skipped', 'The design is being edited');
      throw error;
    } finally {
      await this.drafts.release(designId, store, owner);
    }
  }

  async upgradeStores(version: string, stores?: string[], designIds?: string[]): Promise<KitUpgradeResult[]> {
    const designs = await this.prisma.design.findMany({
      where: { status: 'active', ...(stores?.length ? { store: { in: stores } } : {}), ...(designIds?.length ? { id: { in: designIds } } : {}) },
      orderBy: [{ store: 'asc' }, { updatedAt: 'desc' }],
    });
    const results: KitUpgradeResult[] = [];
    for (const design of designs) {
      const draft = await this.prisma.draft.findUnique({ where: { designId_ref: { designId: design.id, ref: 'main' } } });
      const hadSession = draft ? await this.workspaces.has(draft.id) : true;
      try {
        results.push(await this.upgradeKit(design.id, design.store, version));
      } catch (error) {
        this.logger.warn(`Kit upgrade of ${design.id} failed: ${String(error)}`);
        results.push({ designId: design.id, store: design.store, outcome: 'failed', message: String((error as Error).message ?? error), version: null });
      } finally {
        if (draft && !hadSession) await this.workspaces.discard(draft.id).catch(() => undefined);
      }
    }
    return results;
  }

  async stageMerge(designId: string, store: string): Promise<{ from: string; to: string; changed: string[]; added: string[]; removed: string[]; conflicts: string[]; folder: string }> {
    const { design, draft } = await this.designs.get(designId, store);
    const release = await this.latest();
    const [base, next, current] = await Promise.all([this.files(design.templateVersion), this.files(release.version), this.versions.files(store, draft.tree)]);
    const changed = [...next.keys()].filter(file => base.has(file) && !base.get(file)!.equals(next.get(file)!));
    const added = [...next.keys()].filter(file => !base.has(file));
    const removed = [...base.keys()].filter(file => !next.has(file));
    const merged = new Map<string, Buffer>();
    const conflicts: string[] = [];
    for (const file of changed) {
      const ours = current.get(file);
      if (!ours) continue;
      if (ours.equals(base.get(file)!)) {
        merged.set(file, next.get(file)!);
        continue;
      }
      const result = await mergeFile(ours, base.get(file)!, next.get(file)!, design.templateVersion, release.version);
      merged.set(file, result.text);
      if (result.conflicted) conflicts.push(file);
    }
    const session = await this.workspaces.forDraft(design, draft);
    await session.workspace.exec(`rm -rf ${MERGE_DIR} && mkdir -p ${MERGE_DIR}`);
    await session.workspace.write([
      ...[...changed, ...removed].map(file => ({ path: `${MERGE_DIR}/base/${file}`, bytes: base.get(file)! })),
      ...[...changed, ...added].map(file => ({ path: `${MERGE_DIR}/latest/${file}`, bytes: next.get(file)! })),
      ...[...merged].map(([file, bytes]) => ({ path: `${MERGE_DIR}/merged/${file}`, bytes })),
    ]);
    return { from: design.templateVersion, to: release.version, changed, added, removed, conflicts, folder: MERGE_DIR };
  }

  async finishMerge(designId: string, store: string): Promise<Design> {
    const release = await this.latest();
    return this.designs.update(designId, store, { templateVersion: release.version });
  }

  private async flag(designId: string, flag: DesignFlag): Promise<void> {
    const design = await this.prisma.design.findUniqueOrThrow({ where: { id: designId } });
    const flags = [...(design.flags as DesignFlag[]).filter(existing => existing.kind !== flag.kind), flag];
    await this.prisma.design.update({ where: { id: designId }, data: { flags: flags as Prisma.InputJsonValue } });
  }
}
