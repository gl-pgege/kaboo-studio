import { CodeartifactClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-codeartifact';
import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config';
import { Storage } from '../storage/storage';
import { sha256 } from '../versions/tree';
import type { Workspace, WorkspaceFile } from './workspace';

export class ToolchainError extends Error {}

const SESSION_SCRIPTS = ['sync.mjs', 'vendor.mjs', 'lint-daemon.mjs'];
const TOKEN_SECONDS = 12 * 3600;
const LONGEST_SESSION_MS = 8 * 3600_000;

@Injectable()
export class ToolchainService {
  private cachedScripts?: WorkspaceFile[];
  private codeArtifact?: CodeartifactClient;
  private token?: { value: string; expires: number };

  constructor(private readonly storage: Storage) {}

  async files(): Promise<WorkspaceFile[]> {
    this.cachedScripts ??= await Promise.all(SESSION_SCRIPTS.map(async name => ({ path: `.studio/toolchain/${name}`, bytes: await readFile(path.join(config.toolchainScripts, name)) })));
    const token = await this.registryToken();
    const auth = token ? [`${config.npmRegistry.replace(/^https?:/, '')}:_authToken=${token}`] : [];
    const npmrc = [`registry=${config.npmRegistry}`, ...config.registryScopes.map(scope => `${scope}:registry=${config.npmRegistry}`), ...auth, 'replace-registry-host=always', 'audit=false', 'fund=false', ''].join('\n');
    return [...this.cachedScripts, { path: '.npmrc', bytes: Buffer.from(npmrc) }];
  }

  private async registryToken(): Promise<string | null> {
    if (!config.codeArtifactDomain) return null;
    if (!this.token || this.token.expires - Date.now() < LONGEST_SESSION_MS) {
      this.codeArtifact ??= new CodeartifactClient({ region: config.region });
      const result = await this.codeArtifact.send(
        new GetAuthorizationTokenCommand({ domain: config.codeArtifactDomain, domainOwner: config.codeArtifactOwner || undefined, durationSeconds: TOKEN_SECONDS }),
      );
      this.token = { value: result.authorizationToken!, expires: result.expiration?.getTime() ?? Date.now() + TOKEN_SECONDS * 1000 };
    }
    return this.token.value;
  }

  async startDaemons(workspace: Workspace): Promise<void> {
    await workspace.exec('npx --no-install react-router typegen > /dev/null 2>&1; true', 120_000);
    await workspace.background('echo $$ > .studio/state/tsc.pid; NODE_OPTIONS=--max-old-space-size=1536 exec npx --no-install tsc --watch --noEmit --preserveWatchOutput --pretty false > .studio/state/tsc.log 2>&1');
    await workspace.background('exec node --max-old-space-size=1024 .studio/toolchain/lint-daemon.mjs > .studio/state/lint-daemon.log 2>&1');
  }

  key(lockfile: Buffer): string {
    return `toolchains/${sha256(lockfile)}.tar.gz`;
  }

  async install(workspace: Workspace, lockfile: Buffer | null): Promise<'cache' | 'install' | 'none'> {
    if (!lockfile) return 'none';
    const key = this.key(lockfile);
    if (await this.storage.has(key)) {
      const localPath = this.storage.localPath(key);
      await workspace.extract({
        url: await this.storage.signedUrl(key, 600),
        localPath: localPath && existsSync(localPath) ? localPath : null,
        bytes: async () => (await this.storage.get(key))!,
      });
      return 'cache';
    }
    const installed = await workspace.exec('npm ci --loglevel=error > .studio/state/npm.log 2>&1; code=$?; tail -n 40 .studio/state/npm.log; exit $code', 15 * 60_000);
    if (installed.exitCode !== 0) {
      throw new ToolchainError(`Installing packages failed. ${installed.stdout.slice(-1500)}`);
    }
    const packed = await workspace.exec('tar -czf .studio/state/toolchain.tgz node_modules', 600_000);
    if (packed.exitCode === 0) {
      await workspace
        .upload('.studio/state/toolchain.tgz', { url: await this.storage.signedPutUrl(key, 900), localPath: this.storage.localPath(key) })
        .catch(() => undefined);
      await workspace.exec('rm -f .studio/state/toolchain.tgz');
    }
    return 'install';
  }
}
