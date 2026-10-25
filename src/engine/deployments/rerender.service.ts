import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../config';
import { PrismaService } from '../prisma/prisma.service';
import { StudioQueue } from '../queue/studio-queue';
import { metrics } from '../scaling/metrics';
import { DeployStorage, Storage } from '../storage/storage';
import { WorkspaceService } from '../workspaces/workspace.service';
import { buildClient, uploadFiles, withConfigInShell } from './build';
import { DeploymentService } from './deployment.service';
import { PAGE_CACHE } from './edge';
import { RoutingService } from './routing.service';
import { EdgeCache } from './routing-store';
import { pageFilesOf, robotsTxt, seoReview, sitemapXml } from './seo';

export interface RerenderRequest {
  paths: string[];
  removed: string[];
  all: boolean;
  design?: string | null;
  urgency: 'soon' | 'hourly';
}

const keys = (store: string) => ({ paths: `studio:rerender:${store}:paths`, removed: `studio:rerender:${store}:removed`, all: `studio:rerender:${store}:all` });

@Injectable()
export class RerenderService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RerenderService.name);
  private readonly redis = new Redis({ ...config.redis, maxRetriesPerRequest: 2 });

  constructor(
    private readonly prisma: PrismaService,
    private readonly deployments: DeploymentService,
    private readonly routing: RoutingService,
    private readonly workspaces: WorkspaceService,
    private readonly storage: Storage,
    private readonly files: DeployStorage,
    private readonly cache: EdgeCache,
    private readonly queue: StudioQueue,
  ) {}

  onModuleInit() {
    this.queue.register('re-renders', {
      concurrency: config.rerenderConcurrency,
      oneAtATime: data => String(data.store),
      process: job => this.render(String((job.data as { store: string }).store)),
    });
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  async request(store: string, input: RerenderRequest): Promise<{ queued: boolean }> {
    const liveId = await this.routing.liveId(store);
    if (!liveId) return { queued: false };
    if (input.design && (await this.deployments.row(store, liveId))?.designId !== input.design) return { queued: false };
    if (!input.all && !input.paths.length && !input.removed.length) return { queued: false };
    const key = keys(store);
    const pipeline = this.redis.multi();
    if (input.paths.length) pipeline.sadd(key.paths, ...input.paths);
    if (input.removed.length) pipeline.sadd(key.removed, ...input.removed);
    if (input.all) pipeline.set(key.all, '1');
    for (const name of Object.values(key)) pipeline.expire(name, 2 * 24 * 3600);
    await pipeline.exec();
    await this.schedule(store, input.urgency);
    return { queued: true };
  }

  private schedule(store: string, urgency: 'soon' | 'hourly') {
    return this.queue.add('re-renders', 'render', { store }, { jobId: `render-${store}-${urgency}`, delay: urgency === 'soon' ? config.rerenderSoonMs : config.rerenderHourlyMs, removeOnComplete: true, removeOnFail: true });
  }

  private async take(store: string) {
    const key = keys(store);
    const [paths, removed, all] = ((await this.redis.multi().smembers(key.paths).smembers(key.removed).get(key.all).del(key.paths, key.removed, key.all).exec()) ?? []).map(entry => entry[1]) as [string[], string[], string | null];
    return { paths: paths ?? [], removed: removed ?? [], all: all === '1' };
  }

  private async render(store: string): Promise<{ pages: number }> {
    const work = await this.take(store);
    if (!work.all && !work.paths.length && !work.removed.length) return { pages: 0 };
    const liveId = await this.routing.liveId(store);
    const deployment = liveId ? await this.deployments.row(store, liveId) : null;
    if (!deployment || deployment.status !== 'ready') return { pages: 0 };
    const started = Date.now();
    const removed = new Set(work.removed);
    const paths = work.all ? null : [...new Set(work.paths)].filter(path => !removed.has(path));
    const prefix = `d/${store}/${deployment.id}`;
    const pages = new Set(deployment.pages);
    const invalidate: string[] = [];
    if (work.all || paths!.length) {
      const session = await this.workspaces.renderSession(store);
      await this.workspaces.prepare(session, store, deployment.tree, await this.deployments.buildEnv(deployment, paths));
      const built = await buildClient(session.workspace, this.storage, `stores/${store}/deployments/${deployment.id}/render.tgz`);
      if (!built.ok) throw new Error(`Re-rendering ${store} failed: ${built.output.slice(-500)}`);
      const review = seoReview(built.files, { canonical: false });
      if (work.all) {
        withConfigInShell(built.files);
        await uploadFiles(this.files, prefix, built.files);
        pages.clear();
        invalidate.push(`/${prefix}/*`);
      } else {
        const names = [...built.files.keys()].filter(name => name.startsWith('assets/') || paths!.some(path => pageFilesOf(path).includes(name)));
        await uploadFiles(this.files, prefix, built.files, names);
        for (const path of paths!) {
          pages.delete(path);
          invalidate.push(...pageFilesOf(path).map(name => `/${prefix}/${name}`));
        }
      }
      for (const path of review.indexable) pages.add(path);
    }
    for (const path of removed) {
      await this.files.delete(pageFilesOf(path).map(name => `${prefix}/${name}`));
      pages.delete(path);
      invalidate.push(...pageFilesOf(path).map(name => `/${prefix}/${name}`));
    }
    const siteUrl = await this.deployments.siteUrl(store);
    await this.files.put(`${prefix}/sitemap.xml`, sitemapXml(siteUrl, [...pages].sort()), 'application/xml', PAGE_CACHE);
    await this.files.put(`${prefix}/robots.txt`, robotsTxt(siteUrl), 'text/plain; charset=utf-8', PAGE_CACHE);
    invalidate.push(`/${prefix}/sitemap.xml`);
    await this.cache.invalidate(work.all ? [`/${prefix}/*`] : [...new Set(invalidate)]);
    const updated = await this.prisma.deployment.update({ where: { id: deployment.id }, data: { pages: [...pages].sort(), renderedAt: new Date() } });
    await this.deployments.announce(updated);
    metrics.stage('re-render', Date.now() - started);
    const left = await this.redis.exists(...Object.values(keys(store)));
    if (left) await this.schedule(store, 'soon').catch(error => this.logger.warn(`Queueing the next re-render of ${store} failed: ${String(error)}`));
    return { pages: work.all ? pages.size : paths!.length };
  }
}
