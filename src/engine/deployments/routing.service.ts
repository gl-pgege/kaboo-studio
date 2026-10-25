import type { Actor, Routing } from '../../contract';
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, type StoreRouting } from '../../generated/prisma/client';
import { EventSink, SiteDirectory } from '../ports';
import { WritersService } from '../drafts/writers.service';
import { PrismaService } from '../prisma/prisma.service';
import { addressOf, DeploymentService } from './deployment.service';
import { RoutingStore } from './routing-store';

const liveOf = (row: StoreRouting | undefined): string | null => (row?.config as { default?: string | null } | undefined)?.default ?? null;

export function rollBackTarget(revisions: Array<string | null>): string | null | undefined {
  if (!revisions.length) return undefined;
  const earlier = revisions.slice(1).find(live => live !== revisions[0]);
  if (earlier !== undefined) return earlier;
  return revisions[0] === null ? undefined : null;
}

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentService,
    private readonly store: RoutingStore,
    private readonly sites: SiteDirectory,
    private readonly writers: WritersService,
    private readonly events: EventSink,
  ) {}

  async liveId(store: string): Promise<string | null> {
    return liveOf((await this.prisma.storeRouting.findFirst({ where: { store }, orderBy: { revision: 'desc' } })) ?? undefined);
  }

  async view(store: string): Promise<Routing> {
    const rows = await this.prisma.storeRouting.findMany({ where: { store }, orderBy: { revision: 'desc' }, take: 50 });
    const liveId = liveOf(rows[0]);
    const previous = this.previousOf(rows);
    const [live, before] = await Promise.all([liveId ? this.deployments.row(store, liveId) : null, previous ? this.deployments.row(store, previous) : null]);
    return {
      revision: rows[0]?.revision ?? 0,
      live: live ? this.deployments.view(live, liveId) : null,
      canRollBack: previous !== undefined,
      previous: before ? this.deployments.view(before, liveId) : null,
      url: await this.deployments.siteUrl(store).catch(() => null),
      updatedAt: rows[0]?.createdAt.toISOString() ?? null,
    };
  }

  setLive(store: string, deploymentId: string, actor: Actor): Promise<Routing> {
    return this.writers.lock(
      `studio:routing:${store}`,
      async () => {
        const deployment = await this.deployments.row(store, deploymentId);
        if (!deployment) throw new NotFoundException("This store has no such deployment.");
        if (deployment.status !== 'ready') throw new BadRequestException('Only a deployment that finished building can go live.');
        if ((await this.liveId(store)) !== deploymentId) await this.write(store, deploymentId, actor);
        return this.view(store);
      },
      60_000,
    );
  }

  rollBack(store: string, actor: Actor): Promise<Routing> {
    return this.writers.lock(
      `studio:routing:${store}`,
      async () => {
        const previous = this.previousOf(await this.prisma.storeRouting.findMany({ where: { store }, orderBy: { revision: 'desc' }, take: 50 }));
        if (previous === undefined) throw new BadRequestException('There is nothing to roll back to: no other deployment has been live.');
        await this.write(store, previous, actor);
        return this.view(store);
      },
      60_000,
    );
  }

  async sync(store: string): Promise<void> {
    await this.compile(store, await this.liveId(store), true);
  }

  private previousOf(rows: StoreRouting[]): string | null | undefined {
    return rollBackTarget(rows.map(row => liveOf(row)));
  }

  private async write(store: string, deploymentId: string | null, actor: Actor): Promise<void> {
    const latest = await this.prisma.storeRouting.findFirst({ where: { store }, orderBy: { revision: 'desc' } });
    const revision = (latest?.revision ?? 0) + 1;
    await this.prisma.storeRouting.create({ data: { store, revision, config: { default: deploymentId }, actor: actor as Prisma.InputJsonValue } });
    await this.compile(store, deploymentId, false);
    await this.events
      .live(store, 'studio.routing', { revision, deployment: deploymentId })
      .catch(error => this.logger.warn(`Announcing the routing of ${store} failed: ${String(error)}`));
  }

  private async compile(store: string, deploymentId: string | null, fresh: boolean): Promise<void> {
    const key = `live:${addressOf((await this.sites.site(store, { fresh })).url)}`;
    const value = deploymentId ? `${store}/${deploymentId}` : null;
    const previous = await this.prisma.storeRoute.findUnique({ where: { store } });
    if (previous && previous.key !== key) await this.store.delete(previous.key);
    if (value) await this.store.put(key, value);
    else await this.store.delete(key);
    await this.prisma.storeRoute.upsert({ where: { store }, create: { store, key, value }, update: { key, value } });
  }
}
