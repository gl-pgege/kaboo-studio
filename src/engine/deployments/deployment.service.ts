import type { Actor, Deployment as DeploymentView } from '../../contract';
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma, type Deployment } from '../../generated/prisma/client';
import { EventSink, SiteDirectory } from '../ports';
import { securityScan, type ScanFinding } from '../checks/security-scan';
import { VersionChecks } from '../checks/version-checks.service';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudioQueue } from '../queue/studio-queue';
import { metrics } from '../scaling/metrics';
import { DeployStorage, Storage } from '../storage/storage';
import { compareVersions } from '../templates/template.service';
import { VersionStore } from '../versions/version-store.service';
import { envFile } from '../workspaces/workspace';
import { WorkspaceService } from '../workspaces/workspace.service';
import { buildClient, uploadFiles, withConfigInShell } from './build';
import { PAGE_CACHE } from './edge';
import { robotsTxt, seoReview, sitemapXml, type Finding } from './seo';

export type DeploymentRow = Deployment & { design: { name: string } };

interface Results {
  checks?: { status: string; summary: string | null };
  problems?: Finding[];
  warnings?: Finding[];
  scan?: ScanFinding[];
  output?: string;
}

const WITH_DESIGN = { design: { select: { name: true } } } as const;
const KEEP_DEPLOYMENTS = 10;

export function addressOf(siteUrl: string): string {
  return new URL(siteUrl).hostname.split('.')[0];
}

@Injectable()
export class DeploymentService implements OnModuleInit {
  private readonly logger = new Logger(DeploymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly designs: DesignService,
    private readonly versions: VersionStore,
    private readonly workspaces: WorkspaceService,
    private readonly checks: VersionChecks,
    private readonly storage: Storage,
    private readonly files: DeployStorage,
    private readonly sites: SiteDirectory,
    private readonly queue: StudioQueue,
    private readonly events: EventSink,
  ) {}

  onModuleInit() {
    this.queue.register('deployments', {
      concurrency: config.deployConcurrency,
      oneAtATime: data => String(data.store),
      process: job => this.build(String((job.data as { deployment: string }).deployment)),
    });
  }

  async deploy(designId: string, store: string, version: number | null | undefined, actor: Actor): Promise<DeploymentRow> {
    const { design, draft } = await this.designs.get(designId, store);
    const number = version ?? draft.headVersion;
    if (!number) throw new BadRequestException('Save a version before deploying: this design has none yet.');
    const saved = await this.versions.version(design.id, number);
    if (!saved) throw new NotFoundException(`Version ${number} of this design doesn't exist.`);
    const row = await this.prisma.deployment.create({ data: { store, designId: design.id, version: number, tree: saved.tree, actor: actor as Prisma.InputJsonValue }, include: WITH_DESIGN });
    await this.queue.add('deployments', 'deploy', { deployment: row.id, store }, { jobId: `deploy-${row.id}`, attempts: 1 });
    await this.announce(row);
    return row;
  }

  row(store: string, id: string): Promise<DeploymentRow | null> {
    return this.prisma.deployment.findFirst({ where: { id, store }, include: WITH_DESIGN });
  }

  list(store: string, designId?: string, take = 20): Promise<DeploymentRow[]> {
    return this.prisma.deployment.findMany({ where: { store, ...(designId ? { designId } : {}) }, orderBy: { createdAt: 'desc' }, take: Math.min(Math.max(take, 1), 100), include: WITH_DESIGN });
  }

  view(row: DeploymentRow, liveId: string | null): DeploymentView {
    const results = row.results as Results;
    return {
      id: row.id,
      store: row.store,
      designId: row.designId,
      designName: row.design.name,
      version: row.version,
      tree: row.tree,
      status: row.status as DeploymentView['status'],
      summary: row.summary,
      pages: row.pages.length,
      checks: results.checks ?? null,
      problems: [...(results.problems ?? []), ...(results.scan ?? []).map(finding => ({ path: `${finding.file}:${finding.line}`, problem: finding.problem }))],
      warnings: results.warnings ?? [],
      live: row.id === liveId,
      actor: row.actor as Actor,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      renderedAt: row.renderedAt?.toISOString() ?? null,
    };
  }

  async siteUrl(store: string): Promise<string> {
    return config.liveUrlTemplate.replace('{address}', addressOf((await this.sites.site(store)).url)).replace(/\/+$/, '');
  }

  async buildEnv(row: Deployment, paths: string[] | null): Promise<string> {
    return envFile(await this.sites.buildEnv(row.store, row.designId, { id: row.id, siteUrl: await this.siteUrl(row.store), paths }));
  }


  async announce(row: Deployment): Promise<void> {
    await this.events
      .live(row.store, 'studio.deployment', { deployment: row.id, design: row.designId, version: row.version, status: row.status })
      .catch(error => this.logger.warn(`Announcing deployment ${row.id} failed: ${String(error)}`));
  }

  private async build(id: string): Promise<{ status: string }> {
    const row = await this.prisma.deployment.findUnique({ where: { id } });
    if (!row || row.status !== 'queued') return { status: row?.status ?? 'missing' };
    await this.announce(await this.prisma.deployment.update({ where: { id }, data: { status: 'building' } }));
    let outcome: Prisma.DeploymentUpdateInput;
    try {
      outcome = await metrics.time('deploy', () => this.perform(row));
    } catch (error) {
      this.logger.warn(`Deployment ${id} couldn't run: ${String(error)}`);
      outcome = { status: 'failed', summary: `The deployment couldn't run: ${error instanceof Error ? error.message : String(error)}` };
    }
    const done = await this.prisma.deployment.update({ where: { id }, data: { ...outcome, finishedAt: new Date() } });
    await this.announce(done);
    if (done.status === 'ready') await this.prune(done.store).catch(error => this.logger.warn(`Removing old deployments of ${done.store} failed: ${String(error)}`));
    return { status: done.status };
  }

  private async prune(store: string): Promise<void> {
    const routed = await this.prisma.storeRouting.findMany({ where: { store }, orderBy: { revision: 'desc' }, take: 20 });
    const keep = new Set(routed.map(row => (row.config as { default?: string | null }).default).filter((id): id is string => !!id));
    const ready = await this.prisma.deployment.findMany({ where: { store, status: 'ready' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    for (const { id } of ready.slice(KEEP_DEPLOYMENTS).filter(row => !keep.has(row.id))) {
      await this.files.deletePrefix(`d/${store}/${id}/`);
      await this.prisma.deployment.update({ where: { id }, data: { status: 'removed', pages: [] } });
    }
  }

  private async perform(row: Deployment): Promise<Prisma.DeploymentUpdateInput> {
    const failed = (summary: string, results: Results) => ({ status: 'failed', summary, results: results as unknown as Prisma.InputJsonValue });
    const { design, draft } = await this.designs.get(row.designId, row.store);
    const checked = (await this.checks.result(row.store, row.tree)) ?? (await this.checks.check(design, draft, row.tree));
    const checks = { status: checked.status, summary: checked.summary };
    if (checked.status !== 'passed') return failed(`Version ${row.version}'s checks didn't pass: ${checked.summary}`, { checks });
    const sources = await this.versions.files(row.store, row.tree);
    const scan = securityScan(sources);
    if (scan.length) {
      return failed(`The security scan found ${scan.length} problem${scan.length === 1 ? '' : 's'}: ${scan.slice(0, 3).map(finding => `${finding.file}:${finding.line} ${finding.problem}`).join('; ')}`, { checks, scan });
    }
    const env = await this.buildEnv(row, null);
    const session = await this.workspaces.freshSession(row.store, 'deploy');
    let built;
    try {
      await this.workspaces.prepare(session, row.store, row.tree, env);
      built = await buildClient(session.workspace, this.storage, `stores/${row.store}/deployments/${row.id}/client.tgz`);
    } finally {
      await this.workspaces.stopFresh(session);
    }
    if (!built.ok) return failed('The production build failed', { checks, output: built.output });
    const kitVersion = (JSON.parse(sources.get('package.json')?.toString('utf8') ?? '{}') as { dependencies?: Record<string, string> }).dependencies?.[config.kitPackage] ?? '0.0.0';
    const seo = seoReview(built.files, { canonical: compareVersions(kitVersion.replace(/^[\^~]/, ''), '1.1.0') >= 0 });
    if (seo.problems.length) {
      return failed(`The SEO checks found ${seo.problems.length} problem${seo.problems.length === 1 ? '' : 's'}: ${seo.problems.slice(0, 3).map(finding => `${finding.path} ${finding.problem}`).join('; ')}`, { checks, problems: seo.problems, warnings: seo.warnings });
    }
    const prefix = `d/${row.store}/${row.id}`;
    const siteUrl = await this.siteUrl(row.store);
    withConfigInShell(built.files);
    await uploadFiles(this.files, prefix, built.files);
    await this.files.put(`${prefix}/sitemap.xml`, sitemapXml(siteUrl, seo.indexable), 'application/xml', PAGE_CACHE);
    await this.files.put(`${prefix}/robots.txt`, robotsTxt(siteUrl), 'text/plain; charset=utf-8', PAGE_CACHE);
    return { status: 'ready', summary: `Built ${seo.pages.length} pages`, pages: seo.indexable, results: { checks, warnings: seo.warnings } as unknown as Prisma.InputJsonValue };
  }
}
