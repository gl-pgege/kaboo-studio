import type { Diagnostic } from '../../contract';

export interface CompiledModule {
  code: string;
  deps: string[];
  dynamicDeps: string[];
}

export interface SyncResult {
  tree: string;
  previousTree: string | null;
  changed: Array<{ path: string; hash: string; size: number; text?: string; base64?: string }>;
  deleted: string[];
  refused: Array<{ path: string; reason: string }>;
  modules: Record<string, CompiledModule>;
  compileErrors: Diagnostic[];
  types?: Diagnostic[];
  lint?: Diagnostic[];
  css: string | null;
  cssAssets: string[];
  command: { output: string; exitCode: number; durationMs: number } | null;
  timings: Record<string, number>;
}

export const RESULT_MARKER = '@@STUDIO_RESULT@@';
export const RESULT_FILE = '.studio/state/result.json';

export class SandboxError extends Error {}

export function parseSyncOutput(stdout: string, stderr: string): SyncResult {
  const at = stdout.lastIndexOf(RESULT_MARKER);
  if (at < 0) throw new SandboxError(`The workspace did not answer: ${(stderr || stdout).slice(-800)}`);
  const parsed = JSON.parse(stdout.slice(at + RESULT_MARKER.length)) as SyncResult & { error?: string };
  if (parsed.error) throw new SandboxError(parsed.error);
  return parsed;
}

export function bytesOf(entry: SyncResult['changed'][number]): Buffer {
  return entry.base64 !== undefined ? Buffer.from(entry.base64, 'base64') : Buffer.from(entry.text ?? '', 'utf8');
}
