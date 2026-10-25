import { brandTitle, config } from '../config';

type Unit = 'Milliseconds' | 'Count';

export const METRICS_NAMESPACE = `${brandTitle()}/Studio`;

function emit(name: string, value: number, unit: Unit, dimensions: Record<string, string> = {}) {
  if (config.metrics !== 'emf') return;
  const all = { Environment: config.environment, ...dimensions };
  process.stdout.write(
    `${JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: METRICS_NAMESPACE, Dimensions: [Object.keys(all)], Metrics: [{ Name: name, Unit: unit }] }] }, ...all, [name]: value })}\n`,
  );
}

export const metrics = {
  stage(stage: string, ms: number) {
    emit('StageDuration', Math.round(ms), 'Milliseconds', { Stage: stage });
  },
  count(name: string, value = 1, dimensions?: Record<string, string>) {
    emit(name, value, 'Count', dimensions);
  },
  async time<T>(stage: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      return await work();
    } finally {
      metrics.stage(stage, performance.now() - started);
    }
  },
};
