import type { Actor, ChangeResult, Diagnostic } from '../../contract';
import { Injectable, Logger } from '@nestjs/common';
import type { Design, Draft } from '../../generated/prisma/client';
import { randomBytes } from 'node:crypto';
import { EventSink } from '../ports';
import { VersionChecks } from '../checks/version-checks.service';
import { metrics } from '../scaling/metrics';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { PreviewService } from '../preview/preview.service';
import { treeId, type TreeFiles } from '../versions/tree';
import { VersionStore } from '../versions/version-store.service';
import { type OpenSession, WorkspaceService } from '../workspaces/workspace.service';
import { bytesOf, parseSyncOutput, RESULT_FILE, RESULT_MARKER, SandboxError, type SyncResult } from './sync-result';
import { WritersService } from './writers.service';

export type ChangeStep =
  | { kind: 'command'; command: string; timeoutMs?: number }
  | { kind: 'files'; write: Map<string, Buffer>; delete: string[] }
  | { kind: 'tree'; tree: string };

export interface ChangeOptions {
  owner: string;
  ownerTtlMs?: number;
  releaseAfter?: boolean;
  diagnose?: boolean;
}

export interface ChangeOutcome {
  result: ChangeResult;
  sync: SyncResult;
  design: Design;
  draft: Draft;
  session: OpenSession;
}

export interface DraftProblems {
  tree: string;
  compile: Diagnostic[];
  types: Diagnostic[];
  lint: Diagnostic[];
}

function problemsAfter(draft: Draft, tree: string, sync: SyncResult): DraftProblems {
  const before = draft.problems as unknown as DraftProblems | null;
  const known = before?.tree === draft.tree ? before : null;
  const touched = new Set([...sync.changed.map(entry => entry.path), ...sync.deleted]);
  const keep = (old: Diagnostic[] | undefined, fresh: Diagnostic[]) => [...(old ?? []).filter(item => !touched.has(item.file)), ...fresh];
  return { tree, compile: keep(known?.compile, sync.compileErrors), types: sync.types ?? [], lint: keep(known?.lint, sync.lint ?? []) };
}

interface StepPayload {
  promote: string;
  run?: string;
  timeoutMs?: number;
  write?: Record<string, { text?: string; base64?: string }>;
  delete?: string[];
  replaceAll?: boolean;
  allowProtected?: boolean;
  compileAll?: boolean;
  diagnose?: boolean;
  check?: boolean;
}

export class OutOfSyncError extends Error {
  constructor() {
    super('The workspace had fallen out of step with the saved draft, so it was restarted. Run the command again.');
  }
}

function encode(bytes: Buffer): { text?: string; base64?: string } {
  return bytes.subarray(0, 8000).includes(0) ? { base64: bytes.toString('base64') } : { text: bytes.toString('utf8') };
}

@Injectable()
export class DraftService {
  private readonly logger = new Logger(DraftService.name);

  constructor(
    private readonly designs: DesignService,
    private readonly versions: VersionStore,
    private readonly workspaces: WorkspaceService,
    private readonly writers: WritersService,
    private readonly preview: PreviewService,
    private readonly checks: VersionChecks,
    private readonly events: EventSink,
  ) {}

  async change(designId: string, store: string, actor: Actor, step: ChangeStep, options: ChangeOptions): Promise<ChangeOutcome> {
    const { draft: initial } = await this.designs.get(designId, store);
    await this.writers.claim(initial.id, options.owner, options.ownerTtlMs ?? 120_000);
    try {
      return await this.writers.exclusive(initial.id, () => this.apply(designId, store, actor, step, options.diagnose ?? false));
    } finally {
      if (options.releaseAfter) await this.writers.release(initial.id, options.owner);
    }
  }

  private async apply(designId: string, store: string, actor: Actor, step: ChangeStep, diagnose: boolean): Promise<ChangeOutcome> {
    const { design, draft } = await this.designs.get(designId, store);
    const session = await this.workspaces.forDraft(design, draft);
    const payload = { ...(await this.payload(store, draft, step)), diagnose };
    let sync = await this.run(session, payload);
    if (sync.previousTree !== draft.tree) {
      this.logger.warn(`Session ${session.id} knew ${sync.previousTree} but the draft is ${draft.tree}; restarting it`);
      await this.workspaces.discard(draft.id);
      throw new OutOfSyncError();
    }
    const base = await this.versions.tree(store, draft.tree);
    const next = await this.save(store, draft, base, sync);
    if (sync.refused.length) {
      const putBack = new Map<string, Buffer>();
      const remove: string[] = [];
      for (const { path } of sync.refused) {
        if (next[path]) putBack.set(path, await this.versions.blob(store, next[path]));
        else remove.push(path);
      }
      const followUp = await this.run(session, {
        promote: treeId(next),
        write: Object.fromEntries([...putBack].map(([file, bytes]) => [file, encode(bytes)])),
        delete: remove,
        allowProtected: true,
      });
      sync = {
        ...sync,
        modules: { ...sync.modules, ...followUp.modules },
        css: followUp.css ?? sync.css,
        cssAssets: followUp.css !== null ? followUp.cssAssets : sync.cssAssets,
        compileErrors: [...sync.compileErrors, ...followUp.compileErrors],
      };
    }
    const tree = treeId(next);
    await this.versions.advance(draft.id, draft.tree, tree);
    if (diagnose && tree !== draft.tree) await this.versions.recordProblems(draft.id, problemsAfter(draft, tree, sync) as never);
    await this.workspaces.touch(session);
    if (tree !== draft.tree) {
      await this.designs.touch(design.id);
      if (actor.runId) await this.versions.touchRun(actor.runId, design.id, store, actor);
      void this.events
        .live(store, 'studio.draft', { design: design.id, draft: tree, previousDraft: draft.tree, changed: sync.changed.map(entry => entry.path), deleted: sync.deleted, actor })
        .catch(error => this.logger.warn(`Announcing the draft of ${design.id} failed: ${String(error)}`));
    }
    const saved = { ...draft, tree };
    const preview =
      tree !== draft.tree
        ? await this.preview
            .publish(design, tree, sync, session, () => this.run(session, { promote: tree, compileAll: true }), { wait: diagnose })
            .catch(error => {
              this.logger.warn(`Publishing the preview of ${design.id} failed: ${String(error)}`);
              return null;
            })
        : null;
    return {
      design,
      draft: saved,
      session,
      sync,
      result: {
        changed: sync.changed.map(entry => entry.path),
        deleted: sync.deleted,
        draft: tree === draft.tree ? null : tree,
        previousDraft: draft.tree,
        refused: sync.refused,
        compileErrors: sync.compileErrors,
        types: sync.types ?? [],
        lint: sync.lint ?? [],
        preview,
        command: sync.command,
        diagnosed: diagnose,
      },
    };
  }

  async diagnose(designId: string, store: string): Promise<DraftProblems> {
    const { draft: initial } = await this.designs.get(designId, store);
    return this.writers.exclusive(initial.id, async () => {
      const { design, draft } = await this.designs.get(designId, store);
      const recorded = draft.problems as unknown as DraftProblems | null;
      if (recorded?.tree === draft.tree) return recorded;
      const session = await this.workspaces.forDraft(design, draft);
      const sync = await metrics.time('diagnose', () => this.run(session, { promote: draft.tree, check: true }));
      if (sync.previousTree !== draft.tree) {
        await this.workspaces.discard(draft.id);
        throw new OutOfSyncError();
      }
      const problems: DraftProblems = { tree: draft.tree, compile: sync.compileErrors, types: sync.types ?? [], lint: sync.lint ?? [] };
      await this.versions.recordProblems(draft.id, problems as never);
      await this.workspaces.touch(session);
      return problems;
    });
  }

  private async save(store: string, draft: Draft, base: TreeFiles, sync: SyncResult): Promise<TreeFiles> {
    const next: TreeFiles = { ...base };
    for (const file of sync.deleted) delete next[file];
    for (const entry of sync.changed) next[entry.path] = entry.hash;
    if (treeId(next) !== sync.tree) {
      await this.workspaces.discard(draft.id);
      throw new OutOfSyncError();
    }
    await this.versions.putBlobs(
      store,
      sync.changed.map(entry => ({ hash: entry.hash, bytes: bytesOf(entry) })),
    );
    await this.versions.putTree(store, next);
    return next;
  }

  private async payload(store: string, draft: Draft, step: ChangeStep): Promise<StepPayload> {
    if (step.kind === 'command') return { promote: draft.tree, run: step.command, timeoutMs: step.timeoutMs };
    if (step.kind === 'files') {
      return {
        promote: draft.tree,
        write: Object.fromEntries([...step.write].map(([file, bytes]) => [file, encode(bytes)])),
        delete: step.delete,
      };
    }
    const files = await this.versions.files(store, step.tree);
    return {
      promote: draft.tree,
      write: Object.fromEntries([...files].map(([file, bytes]) => [file, encode(bytes)])),
      replaceAll: true,
      allowProtected: true,
    };
  }

  private async run(session: OpenSession, payload: StepPayload): Promise<SyncResult> {
    const fence = `__STUDIO_${randomBytes(6).toString('hex')}__`;
    const script = [
      'mkdir -p .studio/state',
      'set -a; [ -f .studio/state/env.sh ] && . .studio/state/env.sh; set +a',
      `cat > .studio/state/step.json <<'${fence}'`,
      JSON.stringify(payload),
      fence,
      `rm -f ${RESULT_FILE}`,
      'node .studio/toolchain/sync.mjs --step .studio/state/step.json',
    ].join('\n');
    const timeout = (payload.timeoutMs ?? 14 * 60_000) + 60_000;
    const output = await metrics.time(payload.run ? 'command-sync' : 'sync', () => session.workspace.exec(script, timeout));
    if (output.exitCode !== 0 && !output.stdout.includes(RESULT_MARKER) && !(await session.workspace.alive())) {
      if (session.draftId) await this.workspaces.discard(session.draftId);
      throw new SandboxError('The workspace stopped unexpectedly. Run the command again to start a fresh one.');
    }
    try {
      return parseSyncOutput(output.stdout, output.stderr);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const saved = (await session.workspace.read([RESULT_FILE])).get(RESULT_FILE);
      if (!saved) throw error;
      this.logger.warn(`The workspace's answer was cut short; read the saved result instead`);
      return parseSyncOutput(`${RESULT_MARKER}${saved.toString('utf8')}`, '');
    }
  }

  async refreshPreview(designId: string, store: string) {
    const { draft: initial } = await this.designs.get(designId, store);
    return this.writers.exclusive(initial.id, async () => {
      const { design, draft } = await this.designs.get(designId, store);
      const existing = await this.preview.manifest(store, draft.tree);
      if (existing) return existing;
      const session = await this.workspaces.forDraft(design, draft);
      const sync = await this.run(session, { promote: draft.tree, compileAll: true });
      if (sync.previousTree !== draft.tree) {
        await this.workspaces.discard(draft.id);
        throw new OutOfSyncError();
      }
      await this.workspaces.touch(session);
      return this.preview.rebuild(design, draft.tree, sync, session);
    });
  }

  async heldBy(designId: string, store: string): Promise<string | null> {
    const { draft } = await this.designs.get(designId, store);
    return this.writers.holder(draft.id);
  }

  async claim(designId: string, store: string, owner: string, ttlMs: number): Promise<Draft> {
    const { draft } = await this.designs.get(designId, store);
    await this.writers.claim(draft.id, owner, ttlMs);
    return draft;
  }

  async release(designId: string, store: string, owner: string): Promise<void> {
    const { draft } = await this.designs.get(designId, store);
    await this.writers.release(draft.id, owner);
  }

  async commit(designId: string, store: string, actor: Actor, message: string) {
    const { design, draft } = await this.designs.get(designId, store);
    const version = await this.versions.commit(draft.id, actor, message);
    if (version && actor.kind !== 'platform' && config.autoChecks) this.checks.schedule(design, draft, version.tree);
    if (version && actor.kind !== 'person') {
      void this.events
        .version({ store, design: { id: design.id, name: design.name }, version: { number: version.number, message: version.message }, actor })
        .catch(error => this.logger.warn(`Recording version ${version.number} of ${design.id} failed: ${String(error)}`));
    }
    if (version) {
      void this.events
        .live(store, 'studio.version', { design: design.id, version: version.number, run: version.runId, message: version.message })
        .catch(error => this.logger.warn(`Announcing version ${version.number} of ${design.id} failed: ${String(error)}`));
    }
    return version ? (await this.versions.views([version]))[0] : null;
  }
}
