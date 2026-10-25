import type { PreviewAck, PreviewResult } from '../../contract';
import { LiveEventsService } from '../../live-events';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { config } from '../config';

export interface PreviewUpdate {
  tree: string;
  seq: number;
  manifest: string;
  modules: Record<string, string>;
  deleted: string[];
  css: string | null;
  reload: boolean;
}

export interface Ack extends PreviewAck {
  seq: number | null;
  subscriber: string;
  agent: boolean;
}

const SUBSCRIBER_TTL_MS = 45_000;

@Injectable()
export class PreviewChannel implements OnModuleDestroy {
  private readonly redis = new Redis({ ...config.redis, maxRetriesPerRequest: 2 });
  private readonly subscriber = new Redis({ ...config.redis, enableReadyCheck: false });
  private readonly waiters = new Map<string, Set<(ack: Ack) => void>>();

  constructor(private readonly live: LiveEventsService) {
    void this.subscriber.psubscribe('studio:preview:acks:*');
    this.subscriber.on('pmessage', (_pattern, channel, message) => {
      const design = channel.slice('studio:preview:acks:'.length);
      const ack = JSON.parse(message) as Ack;
      for (const resolve of this.waiters.get(design) ?? []) resolve(ack);
    });
  }

  scope(design: string) {
    return `preview:${design}`;
  }

  async nextSeq(design: string): Promise<number> {
    const seq = await this.redis.incr(`studio:preview:seq:${design}`);
    await this.redis.expire(`studio:preview:seq:${design}`, 7 * 24 * 3600);
    return seq;
  }

  async currentSeq(design: string): Promise<number> {
    return Number((await this.redis.get(`studio:preview:seq:${design}`)) ?? 0);
  }

  async publishUpdate(design: string, update: PreviewUpdate): Promise<void> {
    await this.live.publish(this.scope(design), 'update', update);
  }

  async publishError(design: string, tree: string, errors: Array<{ file: string; line: number | null; message: string }>): Promise<void> {
    await this.live.publish(this.scope(design), 'compile-error', { tree, errors });
  }

  async publishSession(design: string, state: 'waiting' | 'starting' | 'ready' | 'stopped'): Promise<void> {
    await this.live.publish(this.scope(design), 'session', { state });
  }

  async join(design: string, agent: boolean): Promise<{ id: string; heartbeat: () => Promise<void>; leave: () => Promise<void> }> {
    const id = `${agent ? 'agent' : 'view'}:${randomUUID()}`;
    const key = `studio:preview:subs:${design}`;
    const heartbeat = async () => {
      await this.redis.zadd(key, Date.now() + SUBSCRIBER_TTL_MS, id);
      await this.redis.pexpire(key, SUBSCRIBER_TTL_MS * 2);
    };
    await heartbeat();
    return { id, heartbeat, leave: async () => void (await this.redis.zrem(key, id)) };
  }

  async watchers(design: string): Promise<number> {
    const key = `studio:preview:subs:${design}`;
    await this.redis.zremrangebyscore(key, 0, Date.now());
    return this.redis.zcard(key);
  }

  async acknowledge(design: string, ack: Ack): Promise<void> {
    await this.redis.publish(`studio:preview:acks:${design}`, JSON.stringify(ack));
    await this.redis.set(`studio:preview:last-ack:${design}`, JSON.stringify({ ...ack, at: Date.now() }), 'EX', 3600);
  }

  async result(design: string, tree: string, timeoutMs = config.previewAckMs): Promise<PreviewResult> {
    if (!(await this.watchers(design))) return { status: 'no-preview', tree: null, route: null, ms: null, errors: [], faults: [] };
    const ack = await this.waitForAck(design, tree, timeoutMs);
    if (!ack) return { status: 'timeout', tree: null, route: null, ms: null, errors: [], faults: [] };
    return { status: ack.errors.length ? 'errors' : 'rendered', tree: ack.tree, route: ack.route ?? null, ms: ack.ms ?? null, errors: ack.errors, faults: ack.faults ?? [] };
  }

  private async waitForAck(design: string, tree: string, timeoutMs: number): Promise<Ack | null> {
    return new Promise(resolve => {
      const waiters = this.waiters.get(design) ?? new Set();
      this.waiters.set(design, waiters);
      let settled: Ack | null = null;
      const done = (ack: Ack | null) => {
        clearTimeout(timer);
        waiters.delete(listener);
        resolve(ack);
      };
      const listener = (ack: Ack) => {
        if (ack.tree !== tree) return;
        settled = ack;
        if (ack.agent || ack.errors.length) done(ack);
        else setTimeout(() => done(settled), 150);
      };
      const timer = setTimeout(() => done(settled), timeoutMs);
      waiters.add(listener);
    });
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.redis.quit(), this.subscriber.quit()]);
  }
}
