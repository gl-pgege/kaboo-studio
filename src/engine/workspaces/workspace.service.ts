import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Design, Draft, Session } from '../../generated/prisma/client';
import { SiteDirectory } from '../ports';
import { config } from '../config';
import { WritersService } from '../drafts/writers.service';
import { PreviewChannel } from '../preview/preview-channel.service';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAdmission } from '../scaling/admission';
import { metrics } from '../scaling/metrics';
import { sha256 } from '../versions/tree';
import { VersionStore } from '../versions/version-store.service';
import { ToolchainService } from './toolchain.service';
import { type Workspace, WorkspaceProvider, envFile } from './workspace';

export interface OpenSession {
  id: string;
  draftId: string | null;
  store: string;
  workspace: Workspace;
}

const TOUCH_EVERY_MS = 30_000;

@Injectable()
export class WorkspaceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly open = new Map<string, Promise<OpenSession>>();
  private readonly touched = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: WorkspaceProvider,
    private readonly versions: VersionStore,
    private readonly toolchain: ToolchainService,
    private readonly sites: SiteDirectory,
    private readonly admission: SessionAdmission,
    private readonly writers: WritersService,
    private readonly channel: PreviewChannel,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.stopIdle().catch(error => this.logger.warn(`Stopping idle sessions failed: ${String(error)}`)), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  forDraft(design: Design, draft: Draft): Promise<OpenSession> {
    let pending = this.open.get(draft.id);
    if (!pending) {
      pending = this.resolve(design, draft).catch(error => {
        this.open.delete(draft.id);
        throw error;
      });
      this.open.set(draft.id, pending);
    }
    return pending;
  }

  async touch(session: OpenSession): Promise<void> {
    const now = Date.now();
    if (now - (this.touched.get(session.id) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(session.id, now);
    await this.prisma.session.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
  }

  async discard(draftId: string): Promise<void> {
    this.open.delete(draftId);
    const sessions = await this.prisma.session.findMany({ where: { draftId, status: { in: ['starting', 'ready'] } } });
    await Promise.all(sessions.map(session => this.stopSession(session)));
  }

  async active(store: string): Promise<number> {
    return this.prisma.session.count({ where: { store, status: { in: ['starting', 'ready'] } } });
  }

  async stopIdle(): Promise<void> {
    const idle = await this.prisma.session.findMany({ where: { status: { in: ['starting', 'ready'] }, lastUsedAt: { lt: new Date(Date.now() - config.sessionIdleMs) } } });
    await Promise.all(idle.map(session => this.stopSession(session)));
  }

  renderSession(store: string): Promise<OpenSession> {
    const key = `render:${store}`;
    let pending = this.open.get(key);
    if (!pending) {
      pending = this.writers
        .lock(
          `studio:session:${key}`,
          async () => {
            const existing = await this.prisma.session.findFirst({ where: { store, purpose: 'render', status: 'ready', provider: this.provider.name }, orderBy: { startedAt: 'desc' } });
            if (existing) {
              const workspace = this.provider.attach(existing.externalId);
              if (await workspace.alive()) return { id: existing.id, draftId: null, store, workspace };
              await this.markStopped(existing.id);
            }
            return this.startBuild(store, 'render');
          },
          config.sessionWaitMs + 5 * 60_000,
        )
        .catch(error => {
          this.open.delete(key);
          throw error;
        });
      this.open.set(key, pending);
    }
    return pending;
  }

  freshSession(store: string, purpose: 'deploy'): Promise<OpenSession> {
    return this.startBuild(store, purpose);
  }

  async prepare(session: OpenSession, store: string, tree: string, env: string): Promise<void> {
    const files = await this.versions.files(store, tree);
    const lockfile = files.get('package-lock.json') ?? null;
    const marker = lockfile ? sha256(lockfile) : 'none';
    await session.workspace.exec('find . -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .studio -exec rm -rf {} + && mkdir -p .studio/state');
    await session.workspace.write([
      ...[...files].map(([file, bytes]) => ({ path: file, bytes })),
      ...(await this.toolchain.files()),
      { path: '.studio/state/env.sh', bytes: Buffer.from(`${env}\nNODE_OPTIONS="--max-old-space-size=${config.buildMemoryMb}"\n`) },
    ]);
    const installed = (await session.workspace.exec('cat .studio/state/lockfile.sha 2>/dev/null; true')).stdout.trim();
    if (installed !== marker) {
      await session.workspace.exec('rm -rf node_modules .studio/state/lockfile.sha', 120_000);
      await this.toolchain.install(session.workspace, lockfile);
      await session.workspace.exec(`echo ${marker} > .studio/state/lockfile.sha`);
    }
    await this.touch(session);
  }

  async stopFresh(session: OpenSession): Promise<void> {
    await session.workspace.stop().catch(() => undefined);
    await this.markStopped(session.id);
  }

  async has(draftId: string): Promise<boolean> {
    return (await this.prisma.session.count({ where: { draftId, status: 'ready', provider: this.provider.name } })) > 0;
  }

  private resolve(design: Design, draft: Draft): Promise<OpenSession> {
    return this.writers.lock(
      `studio:session:${draft.id}`,
      async () => {
        const existing = await this.prisma.session.findFirst({ where: { draftId: draft.id, status: 'ready', provider: this.provider.name }, orderBy: { startedAt: 'desc' } });
        if (existing) {
          const workspace = this.provider.attach(existing.externalId);
          if (await workspace.alive()) return { id: existing.id, draftId: draft.id, store: design.store, workspace };
          await this.markStopped(existing.id);
        }
        return this.start(design, draft);
      },
      config.sessionWaitMs + 5 * 60_000,
    );
  }

  private async start(design: Design, draft: Draft): Promise<OpenSession> {
    if (design.status === 'archived') throw new BadRequestException('This design is archived. Unarchive it to work on it.');
    await this.makeRoom(design.store);
    await this.admission.admit('sandbox', design.id);
    const record = await this.prisma.session.create({ data: { draftId: draft.id, store: design.store, provider: this.provider.name, externalId: '' } });
    let workspace: Workspace | undefined;
    try {
      const started = Date.now();
      workspace = await this.provider.start(`studio-${design.store}`);
      await this.prisma.session.update({ where: { id: record.id }, data: { externalId: workspace.id } });
      const [files, tree, env] = await Promise.all([
        this.versions.files(design.store, draft.tree),
        this.versions.tree(design.store, draft.tree),
        this.sites.buildEnv(design.store, design.id).then(envFile, error => {
          this.logger.warn(`No store settings for the session: ${String(error)}`);
          return '';
        }),
      ]);
      await workspace.write([
        ...[...files].map(([file, bytes]) => ({ path: file, bytes })),
        ...(await this.toolchain.files()),
        { path: '.studio/state/known.json', bytes: Buffer.from(JSON.stringify({ tree: draft.tree, files: tree })) },
        { path: '.studio/state/env.sh', bytes: Buffer.from(`${env}\nNODE_OPTIONS="--max-old-space-size=${config.buildMemoryMb}"\n`) },
      ]);
      const source = await this.toolchain.install(workspace, files.get('package-lock.json') ?? null);
      await this.toolchain.startDaemons(workspace);
      const readied = await this.prisma.session.updateMany({ where: { id: record.id, status: 'starting' }, data: { status: 'ready', lastUsedAt: new Date() } });
      if (!readied.count) throw new Error('The session was stopped while it started, because the design was archived or another design needed the room.');
      metrics.stage('session-start', Date.now() - started);
      await this.channel.publishSession(design.id, 'ready').catch(() => undefined);
      this.logger.log(`Started a ${this.provider.name} session for design ${design.id} in ${Date.now() - started} ms (packages from ${source})`);
      return { id: record.id, draftId: draft.id, store: design.store, workspace };
    } catch (error) {
      await workspace?.stop();
      await this.markStopped(record.id);
      throw error;
    }
  }

  private async startBuild(store: string, purpose: 'deploy' | 'render'): Promise<OpenSession> {
    await this.admission.admit('sandbox', null);
    const record = await this.prisma.session.create({ data: { store, purpose, provider: this.provider.name, externalId: '' } });
    let workspace: Workspace | undefined;
    try {
      const started = Date.now();
      workspace = await this.provider.start(`studio-${store}-${purpose}`);
      await this.prisma.session.update({ where: { id: record.id }, data: { externalId: workspace.id, status: 'ready', lastUsedAt: new Date() } });
      metrics.stage(`${purpose}-session-start`, Date.now() - started);
      return { id: record.id, draftId: null, store, workspace };
    } catch (error) {
      await workspace?.stop();
      await this.markStopped(record.id);
      throw error;
    }
  }

  private async makeRoom(store: string): Promise<void> {
    const active = await this.prisma.session.findMany({ where: { store, purpose: 'edit', status: { in: ['starting', 'ready'] } }, orderBy: { lastUsedAt: 'asc' } });
    for (const session of active.slice(0, Math.max(0, active.length - config.sessionsPerStore + 1))) await this.stopSession(session);
  }

  private async stopSession(session: Session): Promise<void> {
    this.open.delete(session.draftId ?? `render:${session.store}`);
    this.touched.delete(session.id);
    if (session.externalId && session.provider === this.provider.name) await this.provider.attach(session.externalId).stop();
    await this.markStopped(session.id);
  }

  private async markStopped(id: string): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { status: 'stopped', stoppedAt: new Date() } });
  }
}
