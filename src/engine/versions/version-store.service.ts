import type { Actor, Version as VersionView } from '../../contract';
import { Injectable } from '@nestjs/common';
import { Prisma, type Version } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Storage } from '../storage/storage';
import { sha256, treeId, type TreeFiles } from './tree';

const TREE_CACHE = 200;

export class StaleDraftError extends Error {
  constructor() {
    super('The draft moved on while this change was being saved.');
  }
}

@Injectable()
export class VersionStore {
  private readonly trees = new Map<string, TreeFiles>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: Storage,
  ) {}

  async putBlobs(store: string, blobs: Array<{ hash: string; bytes: Buffer }>): Promise<void> {
    await Promise.all(
      blobs.map(async ({ hash, bytes }) => {
        if (sha256(bytes) !== hash) throw new Error(`Blob content does not match ${hash}`);
        const key = this.blobKey(store, hash);
        if (!(await this.storage.has(key))) await this.storage.put(key, bytes);
      }),
    );
  }

  async blob(store: string, hash: string): Promise<Buffer> {
    const bytes = await this.storage.get(this.blobKey(store, hash));
    if (!bytes) throw new Error(`Missing blob ${hash}`);
    return bytes;
  }

  async putTree(store: string, files: TreeFiles): Promise<string> {
    const id = treeId(files);
    const key = this.treeKey(store, id);
    if (!(await this.storage.has(key))) await this.storage.put(key, JSON.stringify(files), 'application/json');
    this.remember(store, id, files);
    return id;
  }

  async tree(store: string, tree: string): Promise<TreeFiles> {
    const cached = this.trees.get(`${store}/${tree}`);
    if (cached) return cached;
    const bytes = await this.storage.get(this.treeKey(store, tree));
    if (!bytes) throw new Error(`Missing tree ${tree}`);
    const files = JSON.parse(bytes.toString('utf8')) as TreeFiles;
    this.remember(store, tree, files);
    return files;
  }

  async files(store: string, tree: string): Promise<Map<string, Buffer>> {
    const files = await this.tree(store, tree);
    const entries = await Promise.all(Object.entries(files).map(async ([file, hash]) => [file, await this.blob(store, hash)] as const));
    return new Map(entries);
  }

  async storeFiles(store: string, files: Map<string, Buffer>): Promise<string> {
    const tree: TreeFiles = {};
    const blobs = [...files].map(([file, bytes]) => {
      const hash = sha256(bytes);
      tree[file] = hash;
      return { hash, bytes };
    });
    await this.putBlobs(store, blobs);
    return this.putTree(store, tree);
  }

  async recordProblems(draftId: string, problems: Prisma.InputJsonValue): Promise<void> {
    await this.prisma.draft.update({ where: { id: draftId }, data: { problems } });
  }

  async advance(draftId: string, expected: string, next: string): Promise<void> {
    if (expected === next) return;
    const moved = await this.prisma.draft.updateMany({ where: { id: draftId, tree: expected }, data: { tree: next } });
    if (moved.count !== 1) throw new StaleDraftError();
  }

  async commit(draftId: string, actor: Actor, message: string): Promise<Version | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async tx => {
          const draft = await tx.draft.findUniqueOrThrow({ where: { id: draftId } });
          const head = draft.headVersion === null ? null : await tx.version.findUnique({ where: { designId_number: { designId: draft.designId, number: draft.headVersion } } });
          if (head?.tree === draft.tree) return null;
          const last = await tx.version.aggregate({ where: { designId: draft.designId }, _max: { number: true } });
          const number = (last._max.number ?? 0) + 1;
          const version = await tx.version.create({
            data: { designId: draft.designId, ref: draft.ref, number, parent: draft.headVersion, tree: draft.tree, message: message.slice(0, 300), author: actor as Prisma.InputJsonValue, runId: actor.runId ?? null },
          });
          await tx.draft.update({ where: { id: draftId }, data: { headVersion: number } });
          return version;
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }
    throw new Error('Could not number the new version');
  }

  async versions(designId: string, options: { before?: number; take?: number } = {}): Promise<VersionView[]> {
    const rows = await this.prisma.version.findMany({
      where: { designId, ...(options.before ? { number: { lt: options.before } } : {}) },
      orderBy: { number: 'desc' },
      take: Math.min(options.take ?? 30, 100),
    });
    return this.views(rows);
  }

  async touchRun(runId: string, designId: string, store: string, actor: Actor): Promise<void> {
    await this.prisma.runChange.upsert({
      where: { runId_designId: { runId, designId } },
      create: { runId, designId, store, actor: actor as Prisma.InputJsonValue },
      update: { lastAt: new Date(), actor: actor as Prisma.InputJsonValue },
    });
  }

  runChanges(runId: string, store?: string | null) {
    return this.prisma.runChange.findMany({ where: { runId, ...(store ? { store } : {}) } });
  }

  idleRunChanges(before: Date) {
    return this.prisma.runChange.findMany({ where: { lastAt: { lt: before } }, orderBy: { lastAt: 'asc' }, take: 50 });
  }

  async dropRunChange(runId: string, designId: string): Promise<void> {
    await this.prisma.runChange.deleteMany({ where: { runId, designId } });
  }

  async runVersions(store: string, runs: string[]): Promise<Array<{ run: string; design: string; designName: string; version: VersionView }>> {
    if (!runs.length) return [];
    const rows = await this.prisma.version.findMany({ where: { runId: { in: runs }, design: { store } }, include: { design: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 100 });
    const views = await this.views(rows);
    return rows.map((row, index) => ({ run: row.runId ?? '', design: row.designId, designName: row.design.name, version: views[index] }));
  }

  async version(designId: string, number: number): Promise<Version | null> {
    return this.prisma.version.findUnique({ where: { designId_number: { designId, number } } });
  }

  async views(rows: Version[]): Promise<VersionView[]> {
    if (!rows.length) return [];
    const design = await this.prisma.design.findUnique({ where: { id: rows[0].designId }, select: { store: true } });
    const checks = design ? await this.prisma.treeCheck.findMany({ where: { store: design.store, tree: { in: rows.map(row => row.tree) } } }) : [];
    const byTree = new Map(checks.map(check => [check.tree, check]));
    return rows.map(row => {
      const check = byTree.get(row.tree);
      return {
        id: row.id,
        designId: row.designId,
        number: row.number,
        parent: row.parent,
        tree: row.tree,
        message: row.message,
        author: row.author as Actor,
        checks: check ? { status: check.status as 'pending' | 'passed' | 'failed', summary: check.summary } : null,
        createdAt: row.createdAt.toISOString(),
      };
    });
  }

  private remember(store: string, tree: string, files: TreeFiles) {
    this.trees.set(`${store}/${tree}`, files);
    if (this.trees.size > TREE_CACHE) this.trees.delete(this.trees.keys().next().value!);
  }

  private blobKey(store: string, hash: string) {
    return `stores/${store}/blobs/${hash.slice(0, 2)}/${hash}`;
  }

  private treeKey(store: string, tree: string) {
    return `stores/${store}/trees/${tree}.json`;
  }
}
