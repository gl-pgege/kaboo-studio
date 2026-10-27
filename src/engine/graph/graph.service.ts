import {
  type Actor,
  brandSchema,
  type ChangeResult,
  type Deployment,
  type Design,
  type Diagnostic,
  editedFileSchema,
  type PreviewResult,
  rerenderRequestSchema,
  type Routing,
  studioSchemaSdl,
} from '../../contract';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { GraphQLError, type GraphQLSchema, GraphQLScalarType, graphql } from 'graphql';
import { z } from 'zod';
import { BrowserSessions } from '../browser/browser-sessions.service';
import { PreviewViews } from '../browser/preview-views';
import { VersionChecks } from '../checks/version-checks.service';
import { config } from '../config';
import { DeploymentService } from '../deployments/deployment.service';
import { RerenderService } from '../deployments/rerender.service';
import { RoutingService } from '../deployments/routing.service';
import { DesignService } from '../designs/design.service';
import { DraftService, type DraftProblems } from '../drafts/draft.service';
import { RunService } from '../drafts/run.service';
import { EditorService } from '../editor/editor.service';
import { studioErrorOf } from '../internal/studio-errors.filter';
import { PreviewTokens } from '../preview/preview-tokens';
import { StudioQueue } from '../queue/studio-queue';
import { callWait } from '../scaling/admission';
import { metrics } from '../scaling/metrics';
import { TemplateService } from '../templates/template.service';
import { withoutTokens } from '../terminal/output';
import { TerminalService } from '../terminal/terminal.service';
import { VersionStore } from '../versions/version-store.service';
import { WorkspaceService } from '../workspaces/workspace.service';
import { shellQuote } from '../workspaces/workspace';
import { imageOf } from './images';

export interface StudioActivity {
  action: string;
  design: { id: string; name: string };
  version?: number | null;
  files?: string[];
  message?: string | null;
  previousName?: string;
  deployment?: string | null;
}

export interface GraphContext {
  store: string | null;
  actor: Actor;
  activity: StudioActivity[];
}

export interface GraphRequest {
  query: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

type Args = Record<string, any>;

const UUID = /^[0-9a-f-]{36}$/;
const passThrough = new GraphQLScalarType({ name: 'JSON', serialize: value => value, parseValue: value => value });
const dateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize: value => (value instanceof Date ? value.toISOString() : value),
  parseValue: value => value,
});

function storeOf(ctx: GraphContext): string {
  if (!ctx.store) throw new BadRequestException('x-studio-store names the store');
  return ctx.store;
}

function designId(id: string): string {
  if (!UUID.test(id)) throw new NotFoundException('There is no such design in this store.');
  return id;
}

function nameOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new BadRequestException('A design name has 1 to 80 characters');
  return trimmed;
}

const clamp = (value: number | null | undefined, fallback: number, max: number) => Math.min(Math.max(value ?? fallback, 1), max);
const MAX_COMMAND_CHARS = 100_000;

function manifestOf(files: Map<string, Buffer>): { templateVersion: string; kitVersion: string } {
  const manifest = JSON.parse(files.get('.studio/manifest.json')?.toString('utf8') ?? '{}') as { templateVersion?: string };
  const pkg = JSON.parse(files.get('package.json')?.toString('utf8') ?? '{}') as { dependencies?: Record<string, string> };
  return { templateVersion: manifest.templateVersion ?? '0.0.0', kitVersion: pkg.dependencies?.[config.kitPackage] ?? '0.0.0' };
}

function diagnostics(result: ChangeResult) {
  return [
    ...result.compileErrors.map(item => ({ kind: 'compile', ...item })),
    ...result.types.map(item => ({ kind: 'types', ...item })),
    ...result.lint.map(item => ({ kind: 'lint', ...item })),
  ];
}

function faultsOf(preview: PreviewResult | null | undefined): string[] {
  if (preview?.status === 'timeout') return ["The preview didn't confirm the change within 5 s, which usually means an infinite loop or a crash"];
  return preview?.faults ?? [];
}

const deploymentOf = (deployment: Deployment) => ({ ...deployment, design: deployment.designId, author: deployment.actor });
const routingOf = (routing: Routing) => ({ ...routing, live: routing.live ? deploymentOf(routing.live) : null, previous: routing.previous ? deploymentOf(routing.previous) : null });

@Injectable()
export class StudioGraph {
  readonly schema: GraphQLSchema;

  constructor(
    private readonly designs: DesignService,
    private readonly drafts: DraftService,
    private readonly editor: EditorService,
    private readonly versions: VersionStore,
    private readonly templates: TemplateService,
    private readonly tokens: PreviewTokens,
    private readonly checks: VersionChecks,
    private readonly workspaces: WorkspaceService,
    private readonly browsers: BrowserSessions,
    private readonly queue: StudioQueue,
    private readonly deployments: DeploymentService,
    private readonly routing: RoutingService,
    private readonly rerenders: RerenderService,
    private readonly terminal: TerminalService,
    private readonly runs: RunService,
    private readonly views: PreviewViews,
  ) {
    this.schema = makeExecutableSchema({
      typeDefs: studioSchemaSdl,
      resolvers: { JSON: passThrough, DateTime: dateTime, Query: this.queries(), Mutation: this.mutations() },
    });
  }

  async execute(request: GraphRequest, context: GraphContext) {
    const result = await callWait.run(config.callWaitMs, () =>
      graphql({ schema: this.schema, source: request.query, variableValues: request.variables ?? undefined, operationName: request.operationName ?? undefined, contextValue: context }),
    );
    const errors = result.errors?.map(error => {
      if (!error.originalError || error.originalError instanceof GraphQLError) return { message: error.message, path: error.path, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } };
      const { code, message } = studioErrorOf(error.originalError);
      return { message, path: error.path, extensions: { code } };
    });
    return { data: result.data ?? null, ...(errors?.length ? { errors } : {}), extensions: { activity: context.activity } };
  }

  private async design(ctx: GraphContext, id: string) {
    return this.designs.get(designId(id), storeOf(ctx));
  }

  private record(ctx: GraphContext, action: string, design: { id: string; name: string }, details: Omit<StudioActivity, 'action' | 'design'> = {}) {
    ctx.activity.push({ action, design: { id: design.id, name: design.name }, ...details });
  }

  private async tree(ctx: GraphContext, id: string, version: number | null | undefined) {
    return this.editor.tree(designId(id), storeOf(ctx), version ?? undefined);
  }

  private queries() {
    return {
      studioDesigns: (_: unknown, args: Args, ctx: GraphContext) => this.designs.list(storeOf(ctx), args.archived === true),
      studioDesign: async (_: unknown, args: Args, ctx: GraphContext) => {
        if (!UUID.test(args.id)) return null;
        return this.designs.view(args.id, storeOf(ctx)).catch(error => {
          if (error instanceof NotFoundException) return null;
          throw error;
        });
      },
      studioRunVersions: (_: unknown, args: Args, ctx: GraphContext) => this.versions.runVersions(storeOf(ctx), (args.runs as string[]).slice(0, 50)),
      studioDesignVersions: async (_: unknown, args: Args, ctx: GraphContext) => {
        await this.design(ctx, args.design);
        return this.versions.versions(args.design, { before: args.before ?? undefined, take: clamp(args.take, 20, 50) });
      },
      studioDesignPreview: async (_: unknown, args: Args, ctx: GraphContext) => {
        const store = storeOf(ctx);
        await this.design(ctx, args.design);
        if (args.path && !String(args.path).startsWith('/')) throw new BadRequestException('A preview path starts with /');
        const version = args.version ? await this.versions.version(args.design, args.version) : null;
        if (args.version && !version) throw new BadRequestException(`There is no version ${args.version} of this design.`);
        const tree = version?.tree ?? null;
        const { token, expiresAt } = this.tokens.sign({ design: args.design, store, tree, agent: false }, 4 * 3600);
        return { url: this.tokens.url(args.design, token, args.path ?? undefined), expiresAt, tree };
      },
      studioDesignCheck: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { draft } = await this.design(ctx, args.design);
        const row = args.version ? await this.versions.version(args.design, args.version) : null;
        if (args.version && !row) throw new BadRequestException(`There is no version ${args.version} of this design.`);
        return this.checks.result(storeOf(ctx), row?.tree ?? draft.tree);
      },
      studioDesignHealth: async (_: unknown, args: Args, ctx: GraphContext) => {
        const store = storeOf(ctx);
        const { draft } = await this.design(ctx, args.design);
        const recorded = draft.problems as unknown as DraftProblems | null;
        const [known, render, checked] = await Promise.all([
          recorded?.tree === draft.tree ? recorded : config.diagnoseOnChange ? null : this.drafts.diagnose(designId(args.design), store),
          metrics.time('health-render', () => this.views.health(store, designId(args.design))),
          this.checks.result(store, draft.tree),
        ]);
        const at = (item: Diagnostic) => `${item.file}${item.line ? `:${item.line}` : ''}`;
        const problems = [
          ...(known?.compile ?? []).map(item => `Compile error in ${at(item)}: ${item.message}`),
          ...render.errors.map(error => `The home page throws: ${error}`),
          ...render.faults,
          ...(known?.types ?? []).map(item => `Type error in ${at(item)}: ${item.message}`),
          ...(known?.lint ?? []).map(item => `Lint error${item.rule ? ` (${item.rule})` : ''} in ${at(item)}: ${item.message}`),
          ...(checked?.status === 'failed' ? [`The checks failed: ${checked.summary}`] : []),
        ];
        return {
          ok: problems.length === 0,
          draft: draft.tree,
          problems: problems.slice(0, 25),
          errors: render.errors,
          faults: render.faults,
          diagnostics: known
            ? [...known.compile.map(item => ({ kind: 'compile', ...item })), ...known.types.map(item => ({ kind: 'types', ...item })), ...known.lint.map(item => ({ kind: 'lint', ...item }))]
            : [],
          diagnosed: !!known,
          checks: checked ? { status: checked.status, summary: checked.summary } : null,
        };
      },
      studioPreviewShot: (_: unknown, args: Args, ctx: GraphContext) =>
        metrics.time('screenshot', () => this.views.shot(storeOf(ctx), designId(args.design), args.version ?? null, args.path ?? null, args.device ?? 'phone', args.fullPage === true)),
      studioPreviewOutline: (_: unknown, args: Args, ctx: GraphContext) => this.views.outline(storeOf(ctx), designId(args.design), args.version ?? null, args.path ?? null, args.device ?? 'phone'),
      studioPreviewAudit: (_: unknown, args: Args, ctx: GraphContext) => this.views.audit(storeOf(ctx), designId(args.design), args.version ?? null, args.path ?? null, args.devices?.length ? args.devices : ['phone', 'desktop']),
      studioDesignFiles: async (_: unknown, args: Args, ctx: GraphContext) => {
        const tree = await this.tree(ctx, args.design, args.version);
        const manifest = tree.files.find(file => file.path === '.studio/manifest.json');
        let protectedFiles: string[] = [];
        if (manifest) {
          const blob = (await this.editor.blobs(args.design, storeOf(ctx), [manifest.hash]))[manifest.hash];
          try {
            protectedFiles = (JSON.parse(blob?.text ?? '{}') as { protected?: string[] }).protected ?? [];
          } catch {
            protectedFiles = [];
          }
        }
        return { tree: tree.tree, files: tree.files, protected: protectedFiles };
      },
      studioDesignFile: async (_: unknown, args: Args, ctx: GraphContext) => {
        const entry = (await this.tree(ctx, args.design, args.version)).files.find(file => file.path === args.path);
        if (!entry) return null;
        const blob = (await this.editor.blobs(args.design, storeOf(ctx), [entry.hash]))[entry.hash];
        return { path: args.path, hash: entry.hash, text: blob?.text ?? null, base64: blob?.base64 ?? null };
      },
      studioDesignCodeArchive: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design } = await this.design(ctx, args.design);
        const { zip } = await this.editor.archive(args.design, storeOf(ctx), args.version ?? undefined);
        return { filename: `${design.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'design'}.zip`, base64: zip.toString('base64') };
      },
      studioDeployments: async (_: unknown, args: Args, ctx: GraphContext) => {
        const store = storeOf(ctx);
        if (args.design) await this.design(ctx, args.design);
        const [rows, liveId] = await Promise.all([this.deployments.list(store, args.design ?? undefined, clamp(args.take, 20, 100)), this.routing.liveId(store)]);
        return rows.map(row => deploymentOf(this.deployments.view(row, liveId)));
      },
      studioRouting: async (_: unknown, _args: Args, ctx: GraphContext) => routingOf(await this.routing.view(storeOf(ctx))),
      studioTemplate: () => this.templates.latest(),
      studioQueues: () => this.queue.depth(),
    };
  }

  private mutations() {
    return {
      createStudioDesign: async (_: unknown, args: Args, ctx: GraphContext) => {
        const brand = brandSchema.safeParse(Object.fromEntries(Object.entries(args.brand ?? {}).filter(([, value]) => value != null)));
        if (!brand.success) throw new BadRequestException(`The brand isn't valid: ${brand.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`);
        const design = await this.templates.create({ store: storeOf(ctx), name: nameOf(args.name), actor: ctx.actor, brand: brand.data });
        this.record(ctx, 'created', design);
        return design;
      },
      duplicateStudioDesign: async (_: unknown, args: Args, ctx: GraphContext) => {
        const store = storeOf(ctx);
        const { design: source, draft } = await this.design(ctx, args.id);
        const files = await this.versions.files(store, draft.tree);
        const design = await this.designs.create({ store, name: nameOf(args.name ?? `${source.name} copy`), actor: ctx.actor, files, ...manifestOf(files), message: `Copied from ${source.name}` });
        this.record(ctx, 'duplicated', design, { message: `From ${source.name}` });
        return design;
      },
      renameStudioDesign: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design: before } = await this.design(ctx, args.id);
        const design = await this.designs.update(args.id, storeOf(ctx), { name: nameOf(args.name) });
        this.record(ctx, 'renamed', design, { previousName: before.name });
        return design;
      },
      archiveStudioDesign: (_: unknown, args: Args, ctx: GraphContext) => this.setArchived(ctx, args.id, true),
      unarchiveStudioDesign: (_: unknown, args: Args, ctx: GraphContext) => this.setArchived(ctx, args.id, false),
      restoreStudioDesignVersion: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design } = await this.design(ctx, args.design);
        const restored = await this.editor.restore(args.design, storeOf(ctx), ctx.actor, args.version);
        if (!restored) throw new BadRequestException(`The draft already matches version ${args.version}`);
        this.record(ctx, 'restored', design, { version: restored.number, message: `Restored version ${args.version}` });
        return restored;
      },
      editStudioText: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design } = await this.design(ctx, args.design);
        const saved = await this.editor.editText(args.design, storeOf(ctx), ctx.actor, String(args.at), String(args.before), String(args.after));
        if (saved.version) this.record(ctx, 'saved', design, { files: saved.result.changed, version: saved.version.number, message: saved.version.message });
        return { version: saved.version, conflicts: saved.conflicts, changed: saved.result.changed, deleted: saved.result.deleted, refused: saved.result.refused, diagnostics: diagnostics(saved.result), preview: saved.result.preview, draftTree: saved.result.draft };
      },
      editStudioImage: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design } = await this.design(ctx, args.design);
        const saved = await this.editor.editImage(args.design, storeOf(ctx), ctx.actor, String(args.at), String(args.before), String(args.after));
        if (saved.version) this.record(ctx, 'saved', design, { files: saved.result.changed, version: saved.version.number, message: saved.version.message });
        return { version: saved.version, conflicts: saved.conflicts, changed: saved.result.changed, deleted: saved.result.deleted, refused: saved.result.refused, diagnostics: diagnostics(saved.result), preview: saved.result.preview, draftTree: saved.result.draft };
      },
      saveStudioDesignFiles: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design } = await this.design(ctx, args.design);
        const files = z.array(editedFileSchema).min(1, 'Choose at least one file to save').max(200).parse((args.files as Args[]).map(file => ({ path: file.path, contents: file.contents ?? null, baseHash: file.baseHash ?? null })));
        const message = typeof args.message === 'string' ? args.message.trim() || null : null;
        const saved = await this.editor.save(args.design, storeOf(ctx), ctx.actor, files, message);
        const touched = [...saved.result.changed, ...saved.result.deleted];
        if (touched.length) this.record(ctx, 'saved', design, { files: touched, version: saved.version?.number ?? null, message });
        return {
          version: saved.version,
          conflicts: saved.conflicts,
          changed: saved.result.changed,
          deleted: saved.result.deleted,
          refused: saved.result.refused,
          diagnostics: diagnostics(saved.result),
          preview: saved.result.preview,
          draftTree: saved.result.draft,
        };
      },
      formatStudioDesignFile: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design, draft } = await this.design(ctx, args.design);
        const session = await this.workspaces.forDraft(design, draft);
        const encoded = Buffer.from(String(args.text)).toString('base64');
        const output = await session.workspace.exec(`printf '%s' ${shellQuote(encoded)} | base64 -d | npx --no-install prettier --stdin-filepath ${shellQuote(args.path)}`, 60_000);
        await this.workspaces.touch(session);
        if (output.exitCode !== 0) throw new BadRequestException(`Prettier couldn't format ${args.path}: ${(output.stderr || output.stdout).split('\n').find(line => line.trim()) ?? 'unknown error'}`);
        return output.stdout;
      },
      warmStudioDesign: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design, draft } = await this.design(ctx, args.design);
        void this.workspaces.forDraft(design, draft).catch(() => undefined);
        return true;
      },
      runStudioDesignCheck: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { design, draft } = await this.design(ctx, args.design);
        const version = args.version ? await this.versions.version(args.design, args.version) : null;
        if (args.version && !version) throw new BadRequestException(`There is no version ${args.version} of this design.`);
        return this.checks.check(design, draft, version?.tree ?? draft.tree, { retryFailed: true });
      },
      runStudioCommand: async (_: unknown, args: Args, ctx: GraphContext) => {
        await this.design(ctx, args.design);
        const command = String(args.command);
        if (!command.trim() || command.length > MAX_COMMAND_CHARS) throw new BadRequestException(`A command has 1 to ${MAX_COMMAND_CHARS} characters`);
        const answer = await this.terminal.run({ store: storeOf(ctx), designId: args.design, actor: ctx.actor }, command);
        const result = answer.result;
        return {
          output: withoutTokens(answer.text),
          summary: answer.summary,
          exitCode: result?.command?.exitCode ?? null,
          changed: result?.changed ?? [],
          deleted: result?.deleted ?? [],
          refused: result?.refused ?? [],
          draft: result?.draft ?? null,
          diagnostics: result ? diagnostics(result) : [],
          preview: result?.preview ?? null,
          faults: faultsOf(result?.preview),
          screenshots: answer.images.map(image => imageOf(image)),
        };
      },
      deployStudioDesign: async (_: unknown, args: Args, ctx: GraphContext) => {
        const store = storeOf(ctx);
        await this.design(ctx, args.design);
        const row = await this.deployments.deploy(args.design, store, args.version, ctx.actor);
        const deployment = this.deployments.view(row, await this.routing.liveId(store));
        this.record(ctx, 'deployed', { id: deployment.designId, name: deployment.designName }, { version: deployment.version, deployment: deployment.id });
        return deploymentOf(deployment);
      },
      setLiveStudioDeployment: async (_: unknown, args: Args, ctx: GraphContext) => {
        if (!UUID.test(args.deployment)) throw new BadRequestException('This store has no such deployment.');
        const routing = await this.routing.setLive(storeOf(ctx), args.deployment, ctx.actor);
        if (routing.live) this.record(ctx, 'set-live', { id: routing.live.designId, name: routing.live.designName }, { version: routing.live.version, deployment: routing.live.id });
        return routingOf(routing);
      },
      rollBackStudioDeployment: async (_: unknown, _args: Args, ctx: GraphContext) => {
        const store = storeOf(ctx);
        const before = await this.routing.view(store);
        const routing = await this.routing.rollBack(store, ctx.actor);
        const subject = routing.live ?? before.live;
        const target = routing.live ? `version ${routing.live.version} of ${routing.live.designName}` : 'the standard site';
        if (subject) this.record(ctx, 'rolled-back', { id: subject.designId, name: subject.designName }, { version: subject.version, deployment: subject.id, message: target });
        return routingOf(routing);
      },
      importStudioDesign: async (_: unknown, args: Args, ctx: GraphContext) => {
        const files = new Map(
          Object.entries(z.record(z.string(), z.string()).parse(args.files))
            .filter(([file]) => !/^\.studio\/(toolchain|state|cache)\//.test(file) && !file.split('/').includes('node_modules'))
            .map(([file, text]) => [file, Buffer.from(text, 'utf8')]),
        );
        return this.designs.create({ store: storeOf(ctx), name: nameOf(args.name), actor: ctx.actor, files, ...manifestOf(files), message: 'Created from files' });
      },
      endStudioRun: (_: unknown, args: Args, ctx: GraphContext) => {
        const outcome = z.enum(['finished', 'stopped', 'failed']).parse(args.outcome);
        const run = (typeof args.run === 'string' && args.run) || ctx.actor.runId;
        if (!run) throw new BadRequestException('Name the run, or call as the run');
        return this.runs.end(run, ctx.actor, typeof args.summary === 'string' ? args.summary : null, outcome, ctx.store);
      },
      requestStudioRerender: (_: unknown, args: Args, ctx: GraphContext) => this.rerenders.request(storeOf(ctx), rerenderRequestSchema.parse(Object.fromEntries(Object.entries(args.input ?? {}).filter(([, value]) => value != null)))),
      syncStudioRouting: async (_: unknown, _args: Args, ctx: GraphContext) => {
        await this.routing.sync(storeOf(ctx));
        return true;
      },
      upgradeStudioKit: async (_: unknown, args: Args) => ({ results: await this.templates.upgradeStores(args.version, args.stores ?? undefined, args.designs ?? undefined) }),
      queueStudioKitUpgrades: async () => ({ stores: await this.templates.queueNightlyUpgrades() }),
      stageStudioTemplateMerge: (_: unknown, args: Args, ctx: GraphContext) => this.templates.stageMerge(designId(args.design), storeOf(ctx)),
      finishStudioTemplateMerge: async (_: unknown, args: Args, ctx: GraphContext) => {
        await this.templates.finishMerge(designId(args.design), storeOf(ctx));
        return this.designs.view(args.design, storeOf(ctx));
      },
      stopStudioSessions: async (_: unknown, args: Args, ctx: GraphContext) => {
        const { draft } = await this.design(ctx, args.design);
        await Promise.all([this.workspaces.discard(draft.id), this.browsers.discard(draft.id)]);
        return true;
      },
    };
  }

  private async setArchived(ctx: GraphContext, id: string, archived: boolean): Promise<Design> {
    const { draft } = await this.design(ctx, id);
    const design = await this.designs.update(id, storeOf(ctx), { status: archived ? 'archived' : 'active' });
    if (archived) await Promise.all([this.workspaces.discard(draft.id), this.browsers.discard(draft.id)]).catch(() => undefined);
    this.record(ctx, archived ? 'archived' : 'unarchived', design);
    return design;
  }
}

