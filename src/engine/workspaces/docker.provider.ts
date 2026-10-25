import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config';
import { type CommandResult, parseReadOutput, READ_SCRIPT, shellQuote, type Workspace, type WorkspaceFile, WorkspaceProvider } from './workspace';

const run = promisify(execFile);
const ROOT = '/workspace/design';

function pipe(args: string[], input: string | Buffer, timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: code ?? 124 });
    });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: error.message, exitCode: 1 });
    });
    child.stdin.end(input);
  });
}

class DockerWorkspace implements Workspace {
  readonly provider = 'docker';

  constructor(readonly id: string) {}

  exec(command: string, timeoutMs = 15 * 60_000): Promise<CommandResult> {
    return pipe(['exec', '-i', '-w', ROOT, this.id, 'bash', '-s'], command, timeoutMs);
  }

  async background(command: string): Promise<void> {
    await run('docker', ['exec', '-d', '-w', ROOT, this.id, 'bash', '-lc', command]);
  }

  async write(files: WorkspaceFile[]): Promise<void> {
    if (!files.length) return;
    const payload = JSON.stringify(Object.fromEntries(files.map(file => [file.path, file.bytes.toString('base64')])));
    const script =
      "const fs=require('fs'),path=require('path');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{for(const [p,b] of Object.entries(JSON.parse(s))){const t=path.resolve(p);if(!t.startsWith(process.cwd()+path.sep))throw new Error('outside '+p);fs.mkdirSync(path.dirname(t),{recursive:true});fs.writeFileSync(t,Buffer.from(b,'base64'))}})";
    const result = await pipe(['exec', '-i', '-w', ROOT, this.id, 'node', '-e', script], payload, 120_000);
    if (result.exitCode !== 0) throw new Error(`Writing files failed: ${result.stderr.slice(0, 500)}`);
  }

  async read(paths: string[]): Promise<Map<string, Buffer>> {
    const { stdout } = await run('docker', ['exec', '-w', ROOT, this.id, 'node', '-e', READ_SCRIPT, JSON.stringify(paths)], { maxBuffer: 256 * 1024 * 1024 });
    return parseReadOutput(stdout);
  }

  async extract(archive: { url: string | null; localPath: string | null; bytes: () => Promise<Buffer> }): Promise<void> {
    if (archive.localPath) {
      await run('docker', ['cp', archive.localPath, `${this.id}:/tmp/studio-archive.tgz`]);
    } else if (archive.url) {
      const fetched = await this.exec(`curl -sSf -o /tmp/studio-archive.tgz ${shellQuote(archive.url)}`, 300_000);
      if (fetched.exitCode !== 0) throw new Error(`Downloading the archive failed: ${fetched.stderr.slice(0, 500)}`);
    } else {
      await pipe(['exec', '-i', this.id, 'bash', '-c', 'cat > /tmp/studio-archive.tgz'], await archive.bytes(), 300_000);
    }
    const result = await this.exec('tar -xzf /tmp/studio-archive.tgz -C . && rm -f /tmp/studio-archive.tgz', 300_000);
    if (result.exitCode !== 0) throw new Error(`Extracting the archive failed: ${result.stderr.slice(0, 500)}`);
  }

  async upload(file: string, target: { url: string | null; localPath: string | null }): Promise<void> {
    if (target.localPath) {
      await mkdir(path.dirname(target.localPath), { recursive: true });
      await run('docker', ['cp', `${this.id}:${ROOT}/${file}`, target.localPath]);
      return;
    }
    const result = await this.exec(`curl -sSf -X PUT --upload-file ${shellQuote(file)} ${shellQuote(target.url ?? '')}`, 600_000);
    if (result.exitCode !== 0) throw new Error(`Uploading ${file} failed: ${result.stderr.slice(0, 500)}`);
  }

  async alive(): Promise<boolean> {
    try {
      const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Running}}', this.id]);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    await run('docker', ['rm', '-f', this.id]).catch(() => undefined);
  }
}

export class DockerProvider extends WorkspaceProvider {
  readonly name = 'docker';

  async start(label: string): Promise<Workspace> {
    const name = `${label}-${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const { stdout } = await run('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      `${config.brandId}.studio=1`,
      '--cpus',
      '2',
      '--memory',
      '8g',
      '--add-host',
      'host.docker.internal:host-gateway',
      config.sandboxImage,
    ]);
    const workspace = new DockerWorkspace(stdout.trim());
    await run('docker', ['exec', workspace.id, 'mkdir', '-p', ROOT]);
    return workspace;
  }

  attach(id: string): Workspace {
    return new DockerWorkspace(id);
  }
}
