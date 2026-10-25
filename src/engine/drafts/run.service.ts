import type { Actor, Version } from '../../contract';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { RunChange } from '../../generated/prisma/client';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { VersionStore } from '../versions/version-store.service';
import { DraftService } from './draft.service';
import { runWriter } from './writers.service';

export type RunOutcome = 'finished' | 'stopped' | 'failed';

export interface RunVersion {
  run: string;
  design: string;
  designName: string;
  version: Version;
}

@Injectable()
export class RunService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RunService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly drafts: DraftService,
    private readonly versions: VersionStore,
    private readonly designs: DesignService,
  ) {}

  onModuleInit() {
    if (!config.runIdleMs) return;
    this.timer = setInterval(() => void this.sweep().catch(error => this.logger.warn(`Versioning quiet runs failed: ${String(error)}`)), Math.min(60_000, config.runIdleMs));
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async end(runId: string, actor: Actor, summary: string | null, outcome: RunOutcome, store?: string | null): Promise<RunVersion[]> {
    const ended: RunVersion[] = [];
    for (const change of await this.versions.runChanges(runId, store)) {
      const author = actor.runId === runId ? { ...(change.actor as Actor), ...actor } : (change.actor as Actor);
      const version = await this.cut(change, author, summary?.trim().slice(0, 300) || this.message(author, outcome));
      if (version) ended.push(version);
    }
    return ended;
  }

  private async sweep(): Promise<void> {
    for (const change of await this.versions.idleRunChanges(new Date(Date.now() - config.runIdleMs))) {
      await this.cut(change, change.actor as Actor, this.message(change.actor as Actor, 'finished')).catch(error => this.logger.warn(`Versioning run ${change.runId} failed: ${String(error)}`));
    }
  }

  private async cut(change: RunChange, author: Actor, message: string): Promise<RunVersion | null> {
    try {
      const version = await this.drafts.commit(change.designId, change.store, author, message);
      const { design } = await this.designs.get(change.designId, change.store);
      return version ? { run: change.runId, design: design.id, designName: design.name, version } : null;
    } finally {
      const writer = runWriter(change.actor as Actor) ?? `run:${change.runId}`;
      await this.drafts.release(change.designId, change.store, writer).catch(() => undefined);
      await this.versions.dropRunChange(change.runId, change.designId);
    }
  }

  private message(author: Actor, outcome: RunOutcome): string {
    return outcome === 'finished' ? `Changes by ${author.name}` : `Changes by ${author.name} (run ${outcome})`;
  }
}
