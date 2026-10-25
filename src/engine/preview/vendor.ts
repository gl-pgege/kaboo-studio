import { createHash } from 'node:crypto';

export const BASE_ENTRIES = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'react-router'];
const PREVIEW_ONLY = new Set(['@react-router/dev/routes']);

export function isBare(specifier: string): boolean {
  return !/^(\.|\/|~\/|[a-z]+:)/.test(specifier) && !PREVIEW_ONLY.has(specifier) && !/\.css(\?|$)/.test(specifier);
}

export function vendorEntries(modules: Record<string, { deps?: string[]; dynamicDeps?: string[] }>): string[] {
  const entries = new Set(BASE_ENTRIES);
  for (const module of Object.values(modules)) for (const dep of [...(module.deps ?? []), ...(module.dynamicDeps ?? [])]) if (isBare(dep)) entries.add(dep.split('?')[0]);
  return [...entries].sort();
}

export function vendorKey(lockfileHash: string, entries: string[], assets: string[]): string {
  return createHash('sha256').update(`${lockfileHash}\n${entries.join(',')}\n${assets.join(',')}`).digest('hex');
}
