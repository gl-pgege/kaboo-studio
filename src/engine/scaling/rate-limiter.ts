import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { config } from '../config';
import type { Workspace } from '../workspaces/workspace';
import { WorkspaceProvider } from '../workspaces/workspace';
import { metrics } from './metrics';

export const GCRA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
local wait = tat - now - (burst - 1) * interval
if wait < 0 then wait = 0 end
redis.call('SET', KEYS[1], tostring(tat + interval), 'PX', math.ceil((burst + 1) * interval) + 60000)
return math.ceil(wait)`;

@Injectable()
export class SandboxRateLimiter implements OnModuleDestroy {
  private readonly logger = new Logger(SandboxRateLimiter.name);
  private readonly redis = new Redis({ ...config.redis, maxRetriesPerRequest: 2 });

  async acquire(): Promise<number> {
    let wait = 0;
    try {
      wait = Number(await this.redis.eval(GCRA, 1, 'studio:rate:sandbox', String(1000 / config.sandboxTps), String(config.sandboxTps)));
    } catch (error) {
      this.logger.warn(`Sandbox rate limiter unavailable: ${String(error)}`);
    }
    metrics.count('SandboxCalls');
    if (wait > 0) {
      metrics.count('SandboxThrottled');
      metrics.stage('sandbox-wait', wait);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
    return wait;
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}

export class RateLimitedProvider extends WorkspaceProvider {
  constructor(
    private readonly inner: WorkspaceProvider,
    private readonly limiter: SandboxRateLimiter,
  ) {
    super();
  }

  get name() {
    return this.inner.name;
  }

  async start(label: string): Promise<Workspace> {
    await this.limiter.acquire();
    return this.wrap(await this.inner.start(label));
  }

  attach(id: string): Workspace {
    return this.wrap(this.inner.attach(id));
  }

  private wrap(workspace: Workspace): Workspace {
    const paced =
      <A extends unknown[], R>(call: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        await this.limiter.acquire();
        return call(...args);
      };
    return {
      provider: workspace.provider,
      id: workspace.id,
      exec: paced(workspace.exec.bind(workspace)),
      background: paced(workspace.background.bind(workspace)),
      write: paced(workspace.write.bind(workspace)),
      read: paced(workspace.read.bind(workspace)),
      extract: paced(workspace.extract.bind(workspace)),
      upload: paced(workspace.upload.bind(workspace)),
      alive: paced(workspace.alive.bind(workspace)),
      stop: paced(workspace.stop.bind(workspace)),
    };
  }
}
