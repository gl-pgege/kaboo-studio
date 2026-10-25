import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DelayedError, type Job, Queue, type JobsOptions, Worker } from 'bullmq';
import Redis from 'ioredis';
import { config } from '../config';
import { metrics } from '../scaling/metrics';

export type QueueName = 'checks' | 'kit-upgrades' | 'deployments' | 're-renders';

const QUEUES: QueueName[] = ['checks', 'kit-upgrades', 'deployments', 're-renders'];
const PREFIX = 'studio:bull';
const UNLOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

interface Registration {
  process: (job: Job) => Promise<unknown>;
  concurrency: number;
  oneAtATime?: (data: Record<string, unknown>) => string;
}

@Injectable()
export class StudioQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(StudioQueue.name);
  private readonly connection = { ...config.redis, maxRetriesPerRequest: null };
  private readonly queues = new Map<QueueName, Queue>(
    QUEUES.map(name => [
      name,
      new Queue(name, { connection: this.connection, prefix: PREFIX, defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 2, backoff: { type: 'exponential', delay: 30_000 } } }),
    ]),
  );
  private readonly registrations = new Map<QueueName, Registration>();
  private readonly workers: Worker[] = [];
  private readonly locks = new Redis({ ...config.redis, maxRetriesPerRequest: 2 });
  private timer?: NodeJS.Timeout;

  queue(name: QueueName): Queue {
    return this.queues.get(name)!;
  }

  add(name: QueueName, job: string, data: Record<string, unknown>, options: JobsOptions = {}) {
    return this.queue(name).add(job, data, options);
  }

  register(name: QueueName, registration: Registration): void {
    this.registrations.set(name, registration);
  }

  onApplicationBootstrap() {
    if (config.role === 'api') return;
    for (const [name, registration] of this.registrations) this.workers.push(this.worker(name, registration));
    this.timer = setInterval(() => void this.report().catch(() => undefined), 60_000);
    this.timer.unref();
  }

  async depth(): Promise<Record<QueueName, number>> {
    const out = {} as Record<QueueName, number>;
    for (const [name, queue] of this.queues) {
      const counts = await queue.getJobCounts('waiting', 'delayed', 'active', 'prioritized');
      out[name] = (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0) + (counts.prioritized ?? 0);
    }
    return out;
  }

  private worker(name: QueueName, { process, concurrency, oneAtATime }: Registration): Worker {
    const worker = new Worker(
      name,
      async (job, token) => {
        if (!oneAtATime) return metrics.time(name, () => process(job));
        const key = `studio:queue-lock:${name}:${oneAtATime(job.data as Record<string, unknown>)}`;
        const holder = `${job.id}`;
        if ((await this.locks.set(key, holder, 'PX', 30 * 60_000, 'NX')) !== 'OK') {
          await job.moveToDelayed(Date.now() + 5000 + Math.floor(Math.random() * 5000), token);
          throw new DelayedError();
        }
        try {
          return await metrics.time(name, () => process(job));
        } finally {
          await this.locks.eval(UNLOCK, 1, key, holder).catch(() => undefined);
        }
      },
      { connection: this.connection, prefix: PREFIX, concurrency },
    );
    worker.on('failed', (job, error) => {
      metrics.count('JobsFailed', 1, { Queue: name });
      this.logger.warn(`${name} job ${job?.id ?? ''} failed: ${error.message}`);
    });
    worker.on('error', error => this.logger.warn(`${name} worker: ${error.message}`));
    return worker;
  }

  private async report() {
    for (const [name, value] of Object.entries(await this.depth())) metrics.count('QueueDepth', value, { Queue: name });
  }

    async onModuleDestroy() {
        clearInterval(this.timer);
        await Promise.all(
            this.workers.map(worker => Promise.race([worker.close(), new Promise(resolve => setTimeout(resolve, 10_000))]).then(() => worker.close(true))),
        );
    await Promise.all([...this.queues.values()].map(queue => queue.close()));
    await this.locks.quit().catch(() => undefined);
  }
}
