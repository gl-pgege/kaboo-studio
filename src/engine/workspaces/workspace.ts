export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface WorkspaceFile {
  path: string;
  bytes: Buffer;
}

export interface Workspace {
  readonly provider: string;
  readonly id: string;
  exec(command: string, timeoutMs?: number): Promise<CommandResult>;
  background(command: string): Promise<void>;
  write(files: WorkspaceFile[]): Promise<void>;
  read(paths: string[]): Promise<Map<string, Buffer>>;
  extract(archive: { url: string | null; localPath: string | null; bytes: () => Promise<Buffer> }): Promise<void>;
  upload(file: string, target: { url: string | null; localPath: string | null }): Promise<void>;
  alive(): Promise<boolean>;
  stop(): Promise<void>;
}

export abstract class WorkspaceProvider {
  abstract readonly name: string;
  abstract start(label: string): Promise<Workspace>;
  abstract attach(id: string): Workspace;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function envFile(entries: Record<string, string>): string {
  return `${Object.entries(entries)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join('\n')}\n`;
}

export const READ_SCRIPT =
  "const fs=require('fs');const out={};for(const p of JSON.parse(process.argv[1])){try{out[p]=fs.readFileSync(p).toString('base64')}catch{}}process.stdout.write(JSON.stringify(out))";

export function parseReadOutput(stdout: string): Map<string, Buffer> {
  const start = stdout.indexOf('{');
  const parsed = JSON.parse(start >= 0 ? stdout.slice(start) : '{}') as Record<string, string>;
  return new Map(Object.entries(parsed).map(([file, base64]) => [file, Buffer.from(base64, 'base64')]));
}
