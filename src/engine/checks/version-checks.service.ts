import AxeBuilder from '@axe-core/playwright';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, type Design, type Draft } from '../../generated/prisma/client';
import type { Page } from 'playwright-core';
import { CheckPack, SiteDirectory, type TerminalCaller } from '../ports';
import { BrowserSessions } from '../browser/browser-sessions.service';
import { flowSchema, runFlow } from '../browser/flows';
import { WCAG_TAGS } from '../browser/page-audit';
import { PageDriver } from '../browser/page-driver';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { WritersService } from '../drafts/writers.service';
import { PreviewTokens } from '../preview/preview-tokens';
import { PrismaService } from '../prisma/prisma.service';
import { StudioQueue } from '../queue/studio-queue';
import { metrics } from '../scaling/metrics';
import { unpackToStorage } from '../storage/archives';
import { Storage } from '../storage/storage';
import { VersionStore } from '../versions/version-store.service';
import { WorkspaceService } from '../workspaces/workspace.service';

export interface CheckResult {
  tree: string;
  status: 'passed' | 'failed';
  summary: string;
  build: { ok: boolean; ms: number; pages: number; output: string | null };
  routes: Array<{ path: string; ok: boolean; problems: string[] }>;
  accessibility: Array<{ path: string; rule: string; impact: string | null; help: string; count: number }>;
  contract: Array<{ check: string; ok: boolean; detail?: string }>;
  flows: Array<{ name: string; passed: boolean; failedStep: string | null; detail: string | null }>;
  ranAt: string;
}

const RR_WRAPPER = "import config from './react-router.config.original';\n\nexport default { ...config, basename: process.env.STUDIO_BASE ?? '/' };\n";
const VITE_WRAPPER =
  "import config from './vite.config.original';\n\nconst base = process.env.STUDIO_BASE ?? '/';\n\nexport default typeof config === 'function' ? (env: never) => ({ ...(config as (env: never) => object)(env), base }) : { ...config, base };\n";

export function settleNetwork(page: Page) {
  return page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
}

const MAX_ROUTES = 8;

export function checkedRoutes(pages: string[]): string[] {
  const routes = pages
    .map(file => `/${file.replace(/index\.html$/, '')}`)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return routes.length ? routes.slice(0, MAX_ROUTES) : ['/'];
}

@Injectable()
export class VersionChecks implements OnModuleInit {
  private readonly logger = new Logger(VersionChecks.name);
  private readonly running = new Map<string, Promise<CheckResult>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly designs: DesignService,
    private readonly versions: VersionStore,
    private readonly workspaces: WorkspaceService,
    private readonly browsers: BrowserSessions,
    private readonly storage: Storage,
    private readonly tokens: PreviewTokens,
    private readonly queue: StudioQueue,
    private readonly writers: WritersService,
    private readonly checkPack: CheckPack,
    private readonly sites: SiteDirectory,
  ) {}

  onModuleInit() {
    this.queue.register('checks', {
      concurrency: config.checkConcurrency,
      process: async job => {
        const { designId, store, tree } = job.data as { designId: string; store: string; tree: string };
        const { design, draft } = await this.designs.get(designId, store);
        if (design.status === 'archived') return { status: 'skipped' };
        const result = await this.check(design, draft, tree);
        if (!(await this.result(store, tree))) throw new Error(result.summary);
        return { status: result.status };
      },
    });
  }

  async runForDraft(caller: TerminalCaller): Promise<string> {
    const { design, draft } = await this.designs.get(caller.designId, caller.store);
    return formatCheck(await this.check(design, draft, draft.tree, { retryFailed: true }));
  }

  schedule(design: Design, _draft: Draft, tree: string): void {
    void this.queue
      .add('checks', 'check', { designId: design.id, store: design.store, tree }, { jobId: `check-${design.store}-${tree}` })
      .catch(error => this.logger.warn(`Queueing the check of ${tree.slice(0, 8)} failed: ${String(error)}`));
  }

  async result(store: string, tree: string): Promise<CheckResult | null> {
    const row = await this.prisma.treeCheck.findUnique({ where: { store_tree: { store, tree } } });
    return row && row.status !== 'pending' ? (row.results as unknown as CheckResult) : null;
  }

  check(design: Design, draft: Draft, tree: string, options: { retryFailed?: boolean } = {}): Promise<CheckResult> {
    const key = `${design.store}/${tree}`;
    let pending = this.running.get(key);
    if (!pending) {
      pending = this.checkOnce(design, draft, tree, options.retryFailed ?? false).finally(() => this.running.delete(key));
      this.running.set(key, pending);
    }
    return pending;
  }

  private checkOnce(design: Design, draft: Draft, tree: string, retryFailed: boolean): Promise<CheckResult> {
    return this.writers.lock(`studio:check:${design.id}`, () => this.checkLocked(design, draft, tree, retryFailed), 30 * 60_000);
  }

  private async checkLocked(design: Design, draft: Draft, tree: string, retryFailed: boolean): Promise<CheckResult> {
    const cached = await this.result(design.store, tree);
    if (cached && !(retryFailed && cached.status === 'failed')) return cached;
    const where = { store_tree: { store: design.store, tree } };
    await this.prisma.treeCheck.upsert({ where, create: { store: design.store, tree, status: 'pending', results: {} }, update: { status: 'pending' } });
    let result: CheckResult;
    try {
      result = await metrics.time('check', () => this.perform(design, draft, tree));
    } catch (error) {
      await this.prisma.treeCheck.delete({ where }).catch(() => undefined);
      return { tree, status: 'failed', summary: `The check couldn't run: ${error instanceof Error ? error.message : String(error)}`, build: { ok: false, ms: 0, pages: 0, output: null }, routes: [], accessibility: [], contract: [], flows: [], ranAt: new Date().toISOString() };
    }
    await this.prisma.treeCheck.update({ where, data: { status: result.status, summary: result.summary, results: result as unknown as Prisma.InputJsonValue } });
    return result;
  }

  private async perform(design: Design, draft: Draft, tree: string): Promise<CheckResult> {
    const session = await this.workspaces.forDraft(design, draft);
    const files = await this.versions.files(design.store, tree);
    const draftLock = (await this.versions.tree(design.store, draft.tree))['package-lock.json'];
    const treeLock = (await this.versions.tree(design.store, tree))['package-lock.json'];
    const { token } = this.tokens.sign({ design: design.id, store: design.store, tree, agent: false }, 2 * 3600);
    const base = this.tokens.checkBase(design.store, tree);
    const copy: Array<{ path: string; bytes: Buffer }> = [];
    for (const [file, bytes] of files) {
      if (file === 'react-router.config.ts' || file === 'vite.config.ts') copy.push({ path: `.studio/cache/check/${file.replace(/\.ts$/, '.original.ts')}`, bytes });
      else copy.push({ path: `.studio/cache/check/${file}`, bytes });
    }
    copy.push({ path: '.studio/cache/check/react-router.config.ts', bytes: Buffer.from(RR_WRAPPER) }, { path: '.studio/cache/check/vite.config.ts', bytes: Buffer.from(VITE_WRAPPER) });
    await session.workspace.exec('rm -rf .studio/cache/check .studio/cache/check.tgz && mkdir -p .studio/cache/check');
    await session.workspace.write(copy);
    const started = Date.now();
    const deps = draftLock === treeLock ? 'ln -s ../../../node_modules node_modules' : 'npm ci --loglevel=error > ../install.log 2>&1';
    const built = await session.workspace.exec(
      [
        'cd .studio/cache/check',
        `${deps} || { tail -c 3000 ../install.log; echo "@@EXIT@@1"; exit 0; }`,
        'set -a; [ -f ../../state/env.sh ] && . ../../state/env.sh; set +a',
        `STUDIO_BASE='${base}' STUDIO_PRERENDER=sample NODE_ENV=production npx --no-install react-router build > ../build.log 2>&1; code=$?`,
        'tail -c 5000 ../build.log',
        'echo "@@EXIT@@$code"',
        `if [ "$code" = 0 ] && [ -d "build/client${base}" ]; then cp -R "build/client${base}." build/client/ && rm -rf build/client/_studio; fi`,
        '[ "$code" = 0 ] && tar -czf ../check.tgz -C build/client . && echo "@@PACKED@@"',
      ].join('\n'),
      15 * 60_000,
    );
    const exit = built.stdout.match(/@@EXIT@@(\d+)/)?.[1];
    const output = built.stdout.split('@@EXIT@@')[0].trim();
    if (exit !== '0' || !built.stdout.includes('@@PACKED@@')) {
      return this.finish(tree, { ok: false, ms: Date.now() - started, pages: 0, output: output.slice(-4000) || built.stderr.slice(-2000) }, [], [], [], []);
    }
    const archiveKey = `stores/${design.store}/checks/${tree}/client.tgz`;
    await session.workspace.upload('.studio/cache/check.tgz', { url: await this.storage.signedPutUrl(archiveKey, 900), localPath: this.storage.localPath(archiveKey) });
    const archive = await this.storage.get(archiveKey);
    const pages = archive ? (await unpackToStorage(this.storage, archive, `stores/${design.store}/checks/${tree}/client`)).filter(file => file.endsWith('index.html')) : [];
    const build = { ok: true, ms: Date.now() - started, pages: pages.length, output: null };
    const routes = checkedRoutes(pages);
    const hints = (await this.sites.previewConfig(design.store, design.id)).hints as { api?: { path?: string } } | undefined;
    const hostApi = hints?.api?.path ?? null;
    const flowFiles = [...files.keys()].filter(file => /^tests\/flows\/[a-z0-9-]+\.json$/.test(file));
    const origin = config.previewOrigin;
    const results = await this.browsers.withFreshContext(design.store, draft.id, 'phone', async context => {
      await context.setExtraHTTPHeaders({ [`x-${config.brandId}-preview`]: token });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => {
        if (message.type() !== 'error' || /favicon/.test(message.text())) return;
        if (hostApi && new URL(message.location().url || origin, origin).pathname.includes(hostApi)) return;
        errors.push(message.text().slice(0, 300));
      });
      const routeResults: CheckResult['routes'] = [];
      const accessibility: CheckResult['accessibility'] = [];
      const contract: CheckResult['contract'] = [];
      for (const route of routes) {
        errors.length = 0;
        const problems: string[] = [];
        const url = `${origin}${base.slice(0, -1)}${route}`;
        const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(error => {
          problems.push(`didn't load: ${String(error).split('\n')[0]}`);
          return null;
        });
        await settleNetwork(page);
        if (response && response.status() >= 400) problems.push(`answered ${response.status()}`);
        if ((await page.locator('[data-not-found]').count()) > 0) problems.push('shows the not-found page');
        problems.push(...errors.map(error => `error: ${error}`));
        routeResults.push({ path: route, ok: problems.length === 0, problems });
        const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze().catch(() => null);
        for (const violation of axe?.violations ?? []) {
          if (violation.impact === 'serious' || violation.impact === 'critical') accessibility.push({ path: route, rule: violation.id, impact: violation.impact, help: violation.help, count: violation.nodes.length });
        }
        for (const outcome of await this.checkPack.run(page, url)) contract.push(routes.length > 1 ? { ...outcome, check: `${route} ${outcome.check}` } : outcome);
      }
      const flows: CheckResult['flows'] = [];
      for (const file of flowFiles) {
        const parsed = flowSchema.safeParse(JSON.parse(files.get(file)!.toString('utf8')));
        if (!parsed.success) {
          flows.push({ name: file, passed: false, failedStep: null, detail: 'the flow file is not valid' });
          continue;
        }
        const flowPage = await context.newPage();
        await flowPage.goto(`${origin}${base.slice(0, -1)}/`, { waitUntil: 'load' });
        const run = await runFlow(new PageDriver(flowPage, base.slice(0, -1), parsed.data.device === 'phone'), parsed.data);
        const failed = run.failedAt === null ? null : run.steps[run.failedAt];
        flows.push({ name: parsed.data.name, passed: run.passed, failedStep: failed?.step ?? null, detail: failed?.detail ?? null });
        await flowPage.close();
      }
      return { routeResults, accessibility, contract, flows };
    });
    return this.finish(tree, build, results.routeResults, results.accessibility, results.contract, results.flows);
  }

  private finish(
    tree: string,
    build: CheckResult['build'],
    routes: CheckResult['routes'],
    accessibility: CheckResult['accessibility'],
    contract: CheckResult['contract'],
    flows: CheckResult['flows'],
  ): CheckResult {
    const failures = [
      ...(build.ok ? [] : ['the production build failed']),
      ...routes.filter(route => !route.ok).map(route => `${route.path} ${route.problems[0]}`),
      ...accessibility.map(issue => `${issue.path}: ${issue.rule} (${issue.impact})`),
      ...contract.filter(check => !check.ok).map(check => check.check),
      ...flows.filter(flow => !flow.passed).map(flow => `flow ${flow.name}`),
    ];
    return {
      tree,
      status: failures.length ? 'failed' : 'passed',
      summary: failures.length ? `${failures.length} problem${failures.length === 1 ? '' : 's'}: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? '…' : ''}` : `Built ${build.pages} pages; ${routes.length} routes, accessibility, the host's checks${flows.length ? ` and ${flows.length} flow${flows.length === 1 ? '' : 's'}` : ''} passed`,
      build,
      routes,
      accessibility,
      contract,
      flows,
      ranAt: new Date().toISOString(),
    };
  }
}

export function formatCheck(result: CheckResult): string {
  const lines = [`Checks ${result.status} for ${result.tree.slice(0, 8)}: ${result.summary}`];
  lines.push(result.build.ok ? `Build: ${result.build.pages} pages in ${(result.build.ms / 1000).toFixed(1)} s, from the studio's store alone` : `Build: failed\n${result.build.output ?? ''}`);
  for (const route of result.routes) lines.push(`${route.ok ? '✓' : '✗'} ${route.path}${route.ok ? '' : `: ${route.problems.join('; ')}`}`);
  for (const issue of result.accessibility) lines.push(`✗ accessibility on ${issue.path}: ${issue.rule} (${issue.impact}, ${issue.count}) ${issue.help}`);
  for (const check of result.contract) lines.push(`${check.ok ? '✓' : '✗'} ${check.check}${check.detail ? `: ${check.detail}` : ''}`);
  for (const flow of result.flows) lines.push(`${flow.passed ? '✓' : '✗'} flow ${flow.name}${flow.passed ? '' : `: ${flow.failedStep ?? ''} ${flow.detail ?? ''}`}`);
  return lines.join('\n');
}
