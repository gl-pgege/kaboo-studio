import type { Actor } from '../../contract';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { config } from '../config';

const CLAIM = `
local holder = redis.call('GET', KEYS[1])
if holder == false or holder == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return ARGV[1]
end
return holder`;

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

const RENEW = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return 0`;

/**
 * The writer a run holds a design as, released when the run ends: an assistant's chat, so every run of one
 * chat shares the design (a turn that pauses for an approval or a question resumes in a new run), and any
 * other run itself. Another chat, a person or a platform job waits.
 */
export function runWriter(actor: Actor): string | null {
  if (actor.kind === 'assistant' && actor.chatId) return `assistant:${actor.chatId}`;
  return actor.runId ? `run:${actor.runId}` : null;
}

export function isAssistantWriter(holder: string): boolean {
  return holder.startsWith('assistant:') || holder.startsWith('run:');
}

export class BusyError extends Error {
  constructor(readonly holder: string) {
    super(isAssistantWriter(holder) ? 'An assistant is working on this design. Stop it or wait for it to finish.' : 'Someone else is saving changes to this design. Try again in a moment.');
  }
}

@Injectable()
export class WritersService implements OnModuleDestroy {
  private readonly redis = new Redis({ ...config.redis, maxRetriesPerRequest: 2 });

  async claim(draftId: string, owner: string, ttlMs: number): Promise<void> {
    const holder = (await this.redis.eval(CLAIM, 1, `studio:writer:${draftId}`, owner, String(ttlMs))) as string;
    if (holder !== owner) throw new BusyError(holder);
  }

  async release(draftId: string, owner: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, `studio:writer:${draftId}`, owner);
  }

  async holder(draftId: string): Promise<string | null> {
    return this.redis.get(`studio:writer:${draftId}`);
  }

  exclusive<T>(draftId: string, work: () => Promise<T>, waitMs = 60_000): Promise<T> {
    return this.lock(`studio:change:${draftId}`, work, waitMs);
  }

  async lock<T>(key: string, work: () => Promise<T>, waitMs: number): Promise<T> {
    const token = randomUUID();
    const ttl = 120_000;
    const deadline = Date.now() + waitMs;
    while ((await this.redis.set(key, token, 'PX', ttl, 'NX')) !== 'OK') {
      if (Date.now() > deadline) throw new BusyError('change');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const renew = setInterval(() => void this.redis.eval(RENEW, 1, key, token, String(ttl)).catch(() => undefined), ttl / 3);
    try {
      return await work();
    } finally {
      clearInterval(renew);
      await this.redis.eval(RELEASE, 1, key, token).catch(() => undefined);
    }
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
