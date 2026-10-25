import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';
import { PreviewChannel } from '../preview/preview-channel.service';
import { PrismaService } from '../prisma/prisma.service';
import { metrics } from './metrics';

export class CapacityError extends Error {}

export const callWait = new AsyncLocalStorage<number>();

const ACTIVE = { status: { in: ['starting', 'ready'] } };

@Injectable()
export class SessionAdmission implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly channel: PreviewChannel,
  ) {}

  onModuleInit() {
    if (config.metrics !== 'emf') return;
    this.timer = setInterval(async () => {
      for (const kind of ['sandbox', 'browser'] as const) metrics.count('SessionsInUse', await this.inUse(kind).catch(() => 0), { Kind: kind });
    }, 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  inUse(kind: 'sandbox' | 'browser'): Promise<number> {
    return kind === 'sandbox' ? this.prisma.session.count({ where: ACTIVE }) : this.prisma.browserSession.count({ where: ACTIVE });
  }

  async admit(kind: 'sandbox' | 'browser', designId: string | null): Promise<void> {
    const limit = kind === 'sandbox' ? config.maxSessions : config.maxBrowsers;
    const started = Date.now();
    const waitMs = callWait.getStore() ?? config.sessionWaitMs;
    let waiting = false;
    while ((await this.inUse(kind)) >= limit) {
      if (!waiting) {
        waiting = true;
        metrics.count('SessionsWaiting', 1, { Kind: kind });
        if (designId) await this.channel.publishSession(designId, 'waiting').catch(() => undefined);
      }
      if (Date.now() - started > waitMs) throw new CapacityError(waitMs < config.sessionWaitMs ? 'Every workspace is busy, try again in a minute.' : 'Every workspace is busy right now. Try again in a few minutes.');
      await new Promise(resolve => setTimeout(resolve, config.sessionPollMs * (1 + Math.random() / 2)));
    }
    if (waiting) metrics.stage(`${kind}-queue`, Date.now() - started);
    if (designId) await this.channel.publishSession(designId, 'starting').catch(() => undefined);
  }
}
