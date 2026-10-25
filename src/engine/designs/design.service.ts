import type { Actor, DesignFlag, Design as DesignView } from '../../contract';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Design, Draft } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VersionStore } from '../versions/version-store.service';

export interface DesignWithDraft {
  design: Design;
  draft: Draft;
}

const VARIATION_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

@Injectable()
export class DesignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: VersionStore,
  ) {}

  async create(input: {
    store: string;
    name: string;
    actor: Actor;
    files: Map<string, Buffer>;
    templateVersion: string;
    kitVersion: string;
    message: string;
    parentId?: string;
  }): Promise<DesignView> {
    const tree = await this.versions.storeFiles(input.store, input.files);
    const design = await this.prisma.$transaction(async tx => {
      const created = await tx.design.create({
        data: { store: input.store, name: input.name, templateVersion: input.templateVersion, kitVersion: input.kitVersion, ...(input.parentId ? { parentId: input.parentId, status: 'scratch' } : {}) },
      });
      await tx.draft.create({ data: { designId: created.id, tree, headVersion: 1 } });
      await tx.version.create({ data: { designId: created.id, number: 1, tree, message: input.message, author: input.actor } });
      return created;
    });
    return this.view(design.id, input.store);
  }

  async get(id: string, store: string): Promise<DesignWithDraft> {
    const design = await this.prisma.design.findFirst({ where: { id, store } });
    if (!design) throw new NotFoundException('There is no such design in this store.');
    const draft = await this.prisma.draft.findUniqueOrThrow({ where: { designId_ref: { designId: id, ref: 'main' } } });
    return { design, draft };
  }

  async list(store: string, includeArchived = false): Promise<DesignView[]> {
    const designs = await this.prisma.design.findMany({
      where: { store, status: includeArchived ? { in: ['active', 'archived'] } : 'active' },
      orderBy: { updatedAt: 'desc' },
      include: { drafts: { where: { ref: 'main' } } },
    });
    return designs.map(design => this.toView(design, design.drafts[0]));
  }

  async view(id: string, store: string): Promise<DesignView> {
    const { design, draft } = await this.get(id, store);
    return this.toView(design, draft);
  }

  async update(id: string, store: string, changes: { name?: string; status?: 'active' | 'archived'; templateVersion?: string; kitVersion?: string }): Promise<DesignView> {
    await this.get(id, store);
    await this.prisma.design.update({ where: { id }, data: changes });
    return this.view(id, store);
  }

  async touch(designId: string): Promise<void> {
    await this.prisma.design.update({ where: { id: designId }, data: { updatedAt: new Date() } });
  }

  async variations(store: string, parentId: string): Promise<Array<{ name: string; design: Design; draft: Draft }>> {
    const designs = await this.prisma.design.findMany({ where: { store, parentId, status: 'scratch' }, include: { drafts: { where: { ref: 'main' } } }, orderBy: { createdAt: 'asc' } });
    return designs.map(design => ({ name: design.name.split(' · ').pop() ?? design.name, design, draft: design.drafts[0] }));
  }

  async variation(store: string, parentId: string, name: string): Promise<Design> {
    const found = (await this.variations(store, parentId)).find(entry => entry.name === name);
    if (!found) throw new NotFoundException(`There is no variation called ${name}. Make it first with studio variation new ${name}.`);
    return found.design;
  }

  async createVariation(store: string, parentId: string, name: string, actor: Actor): Promise<DesignView> {
    if (!VARIATION_NAME.test(name)) throw new BadRequestException('Name variations in lowercase with dashes, such as bold-editorial');
    const { design, draft } = await this.get(parentId, store);
    if (design.parentId) throw new BadRequestException('A variation cannot have variations of its own');
    const existing = (await this.variations(store, parentId)).find(entry => entry.name === name);
    if (existing) return this.toView(existing.design, existing.draft);
    if ((await this.variations(store, parentId)).length >= 3) throw new BadRequestException('A design can have three variations at a time. Use or drop one first.');
    const files = await this.versions.files(store, draft.tree);
    return this.create({ store, name: `${design.name} · ${name}`, actor, files, templateVersion: design.templateVersion, kitVersion: design.kitVersion, message: `Started from ${design.name}`, parentId });
  }

  async dropVariation(store: string, parentId: string, name: string): Promise<string> {
    const variation = await this.variation(store, parentId, name);
    await this.prisma.design.update({ where: { id: variation.id }, data: { status: 'archived' } });
    return variation.id;
  }

  toView(design: Design, draft: Draft | undefined): DesignView {
    return {
      id: design.id,
      store: design.store,
      name: design.name,
      status: design.status as 'active' | 'archived' | 'scratch',
      parentId: design.parentId ?? null,
      draftTree: draft?.tree ?? '',
      headVersion: draft?.headVersion ?? null,
      templateVersion: design.templateVersion,
      kitVersion: design.kitVersion,
      flags: (design.flags as DesignFlag[] | null) ?? [],
      createdAt: design.createdAt.toISOString(),
      updatedAt: design.updatedAt.toISOString(),
    };
  }
}
