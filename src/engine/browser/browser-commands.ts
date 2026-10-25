import type { ChangeResult } from '../../contract';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Design, Draft } from '../../generated/prisma/client';
import Redis from 'ioredis';
import type { TerminalCaller } from '../ports';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { DraftService } from '../drafts/draft.service';
import { PreviewTokens } from '../preview/preview-tokens';
import { VersionStore } from '../versions/version-store.service';
import { type AgentPage, BrowserSessions, type Device } from './browser-sessions.service';
import { describeTarget, type Flow, flowSchema, type FlowStep, runFlow, stableTarget } from './flows';
import { DriverError, PageDriver } from './page-driver';
import { describe, formatOutline, type Outline, outlineChanges } from './page-outline';
import { PageInspector } from './page-inspector';

export interface BrowserAnswer {
  text: string;
  images: Buffer[];
  result: ChangeResult | null;
}

function take(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const [, value] = args.splice(index, 2);
  return value;
}

function has(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index >= 0) args.splice(index, 1);
  return index >= 0;
}

const deviceOf = (args: string[]): Device | undefined => (has(args, '--phone') ? 'phone' : has(args, '--desktop') ? 'desktop' : undefined);

@Injectable()
export class BrowserCommands implements OnModuleDestroy {
  private readonly redis = new Redis({ ...config.redis, maxRetriesPerRequest: 2, keyPrefix: 'studio:browser:' });

  constructor(
    private readonly browsers: BrowserSessions,
    private readonly inspector: PageInspector,
    private readonly designs: DesignService,
    private readonly drafts: DraftService,
    private readonly versions: VersionStore,
    private readonly tokens: PreviewTokens,
  ) {}

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  async run(caller: TerminalCaller, name: string, args: string[], owner: string): Promise<BrowserAnswer> {
    const { design, draft } = await this.designs.get(caller.designId, caller.store);
    if (name === 'audit') return this.audit(caller, design, draft, args);
    if (name === 'flow') return this.flow(caller, design, draft, args, owner);
    if (name === 'compare') return this.compare(design, draft, args);
    const device = deviceOf(args);
    const newVisitor = has(args, '--new-visitor');
    const withShot = has(args, '--screenshot');
    return this.browsers.withAgentPage(design, draft, { device, newVisitor }, async agent => {
      const driver = new PageDriver(agent.page, agent.basename, agent.device === 'phone');
      await driver.drain();
      try {
        return await this.act(name, args, agent, driver, withShot);
      } catch (error) {
        if (!(error instanceof DriverError)) throw error;
        const shot = await this.inspector.screenshot(agent.page, null).catch(() => null);
        return { text: `${error.message}\n(${driver.path()} on a ${agent.device})`, images: shot ? [shot] : [], result: null };
      }
    });
  }

  private async act(name: string, args: string[], agent: AgentPage, driver: PageDriver, withShot: boolean): Promise<BrowserAnswer> {
    const within = take(args, '--in');
    const saved = await this.lastOutline(agent.session.id);
    const current = await driver.outline();
    const resolve = (spec: string, options: { within?: string; roles?: string[] } = {}) => driver.resolve(current, spec, { ...options, previous: saved });
    const startPath = driver.path();
    const report = async (did: string, extra: string[] = [], forceShot = false): Promise<BrowserAnswer> => {
      const settle = await driver.settle();
      const outline = await driver.outline();
      await this.saveOutline(agent.session.id, outline);
      const { errors, failed } = await driver.drain();
      const lines = [did, `${settle.settled ? `Settled in ${settle.ms} ms` : "Didn't settle within 5 s (something kept loading or moving)"} · ${driver.path()} on a ${agent.device}`];
      const changes = name === 'open' ? [] : driver.path() !== startPath ? [`went to ${driver.path()}`] : outlineChanges(current, outline);
      if (changes.length) lines.push(`Changes: ${changes.join('; ')}`);
      lines.push(...extra);
      if (errors.length) lines.push(`Console errors:\n${errors.map(error => `  ${error}`).join('\n')}`);
      if (failed.length) lines.push(`Failed requests:\n${failed.map(request => `  ${request}`).join('\n')}`);
      const images = withShot || forceShot ? [await this.inspector.screenshot(agent.page, null)] : [];
      return { text: lines.join('\n'), images, result: null };
    };
    const record = (step: FlowStep) => this.recordStep(agent.session.id, step);

    switch (name) {
      case 'open': {
        const path = args[0] ?? '/';
        await driver.open(path);
        await this.resetSteps(agent.session.id, { do: 'open', path });
        const answer = await report(`Opened ${path}`);
        const outline = (await this.lastOutline(agent.session.id))!;
        return { ...answer, text: `${answer.text}\n\n${this.formatOutline(outline, agent.device)}` };
      }
      case 'screenshot': {
        const ref = args.find(arg => /^e\d+$/.test(arg));
        const path = args.find(arg => arg.startsWith('/'));
        if (path) {
          await driver.open(path);
          await this.resetSteps(agent.session.id, { do: 'open', path });
        }
        await driver.settle();
        const fresh = path ? await driver.outline() : current;
        await this.saveOutline(agent.session.id, fresh);
        const target = ref ? (path ? driver.resolve(fresh, ref) : resolve(ref)).locator : null;
        const image = await this.inspector.screenshot(agent.page, target, has(args, '--full'));
        const { errors, failed } = await driver.drain();
        const lines = [`Screenshot of ${ref ?? driver.path()} on a ${agent.device}`];
        if (errors.length) lines.push(`Console errors:\n${errors.map(error => `  ${error}`).join('\n')}`);
        if (failed.length) lines.push(`Failed requests:\n${failed.map(request => `  ${request}`).join('\n')}`);
        if (!ref) lines.push('', this.formatOutline(fresh, agent.device));
        return { text: lines.join('\n'), images: [image], result: null };
      }
      case 'inspect': {
        const { node, locator } = resolve(args[0] ?? '');
        const details = await this.inspector.inspect(locator);
        return { text: `${node.ref} ${describe(node)}\n${JSON.stringify(details, null, 2)}`, images: [], result: null };
      }
      case 'click': {
        const at = take(args, '--at');
        if (at) {
          const [x, y] = at.split(',').map(Number);
          await driver.clickAt(x, y);
          return report(`Clicked at ${x},${y}`);
        }
        const outline = current;
        const { node, locator } = resolve(args.join(' '), { within });
        await driver.click(locator, node);
        await record({ do: 'click', target: stableTarget(node, outline.nodes) });
        return report(`Clicked ${node.ref} ${describe(node)}${node.source ? `  ${node.source}` : ''}`);
      }
      case 'fill': {
        const [label, ...rest] = args;
        const outline = current;
        const { node, locator } = resolve(label ?? '', { within, roles: ['textbox', 'searchbox', 'combobox', 'spinbutton'] });
        await driver.fill(locator, node, rest.join(' '));
        await record({ do: 'fill', target: stableTarget(node, outline.nodes), value: rest.join(' ') });
        return report(`Filled ${node.ref} ${describe(node)}`);
      }
      case 'select': {
        const [label, ...rest] = args;
        const node = await driver.select(current, label ?? '', rest.join(' '), within);
        await record({ do: 'select', label: label ?? '', value: rest.join(' ') });
        return report(`Chose "${rest.join(' ')}" in ${node.ref} ${describe(node)}`);
      }
      case 'press': {
        await driver.press(args[0] ?? 'Enter');
        await record({ do: 'press', key: args[0] ?? 'Enter' });
        return report(`Pressed ${args[0] ?? 'Enter'}`);
      }
      case 'hover': {
        const { node, locator } = resolve(args.join(' '), { within });
        await driver.hover(locator, node);
        return report(`Hovered over ${node.ref} ${describe(node)}`, [], true);
      }
      case 'swipe': {
        const direction = args.pop() as 'left' | 'right' | 'up' | 'down';
        if (!['left', 'right', 'up', 'down'].includes(direction)) throw new DriverError('Say which way: studio swipe e40 left');
        const { node, locator } = resolve(args.join(' '), { within, roles: ['list', 'region', 'group', 'listbox', 'img', 'generic', 'article', 'tablist'] });
        await driver.swipe(locator, direction);
        return report(`Swiped ${direction} on ${node.ref} ${describe(node)}`);
      }
      case 'scroll': {
        const [first, second] = args;
        if (first === 'down' || first === 'up') {
          await driver.scroll(first, Number(second ?? 1) || 1);
          await record({ do: 'scroll', direction: first });
          return report(`Scrolled ${first}`, [], withShot);
        }
        if (first === 'bottom') {
          const height = await driver.scrollToBottom();
          await record({ do: 'scroll', direction: 'bottom' });
          return report(`Scrolled to the bottom (${height}px tall)`);
        }
        const direction = args.pop();
        if (direction !== 'left' && direction !== 'right') throw new DriverError('Use studio scroll down, up, bottom, or <element> left|right');
        const { node, locator } = resolve(args.join(' '), { roles: ['list', 'region', 'group', 'generic', 'listbox', 'tablist'] });
        const moved = await driver.scrollSideways(locator, direction);
        return report(moved ? `Scrolled ${node.ref} ${direction} by ${Math.abs(moved)}px` : `${node.ref} doesn't scroll ${direction} any further`);
      }
      case 'scroll-to': {
        const { node, locator } = resolve(args.join(' '), { roles: ['heading', 'region', 'navigation', 'form', 'list', 'contentinfo', 'banner', 'img', 'group', 'article'] });
        await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
        return report(`Scrolled to ${node.ref} ${describe(node)}`, [], withShot);
      }
      case 'back': {
        await driver.back();
        await record({ do: 'back' });
        return report('Went back');
      }
      case 'wait': {
        const gone = has(args, '--gone');
        await driver.wait(args.join(' '), gone);
        await record({ do: 'wait', text: args.join(' '), gone });
        return report(`${gone ? 'Gone' : 'Found'}: "${args.join(' ')}"`);
      }
      case 'eval': {
        const value = await driver.evaluate(args.join(' '));
        return report('Ran the script in the page', [`Result: ${value}`]);
      }
      default:
        throw new DriverError(`There is no studio ${name} command.`);
    }
  }

  private formatOutline(outline: Outline, device: Device): string {
    const text = formatOutline(outline, device);
    const lines = text.split('\n');
    return lines.length > 160 ? `${lines.slice(0, 160).join('\n')}\n… ${lines.length - 160} more lines (scroll, or screenshot an element)` : text;
  }

  private async audit(caller: TerminalCaller, design: Design, draft: Draft, args: string[]): Promise<BrowserAnswer> {
    const device = deviceOf(args);
    const path = args.find(arg => arg.startsWith('/')) ?? '/';
    const { token } = this.tokens.sign({ design: design.id, store: design.store, tree: null, agent: false }, 3600);
    const result = await this.inspector.audit(this.tokens.url(design.id, token, path), device ? [device === 'phone' ? 'mobile' : 'desktop'] : ['mobile', 'desktop'], caller.store, draft.id);
    return { text: JSON.stringify(result, null, 1), images: [], result: null };
  }

  private async compare(design: Design, draft: Draft, args: string[]): Promise<BrowserAnswer> {
    const device = deviceOf(args) ?? 'phone';
    const number = Number(args.find(arg => /^\d+$/.test(arg)));
    const path = args.find(arg => arg.startsWith('/')) ?? '/';
    if (!number) throw new DriverError('Say which version to compare with: studio compare 12 /products/tee');
    const version = await this.versions.version(design.id, number);
    if (!version) throw new DriverError(`There is no version ${number}.`);
    const shots: Buffer[] = [];
    for (const tree of [null, version.tree]) {
      const { token } = this.tokens.sign({ design: design.id, store: design.store, tree, agent: false }, 900);
      shots.push(
        await this.browsers.withFreshContext(design.store, draft.id, device, async context => {
          const page = await context.newPage();
          await page.goto(this.tokens.url(design.id, token, path), { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => document.querySelector('#studio-root')?.childElementCount, null, { timeout: 30_000 }).catch(() => undefined);
          await new PageDriver(page, '', device === 'phone').settle();
          return page.screenshot({ type: 'jpeg', quality: 70 });
        }),
      );
    }
    return { text: `First the draft, then version ${number}, of ${path} on a ${device}.`, images: shots, result: null };
  }

  private async flow(caller: TerminalCaller, design: Design, draft: Draft, args: string[], owner: string): Promise<BrowserAnswer> {
    const [action, name] = args;
    if (action === 'list') {
      const tree = await this.versions.tree(caller.store, draft.tree);
      const flows = Object.keys(tree).filter(file => /^tests\/flows\/[a-z0-9-]+\.json$/.test(file));
      return { text: flows.length ? flows.map(file => file.slice('tests/flows/'.length, -5)).join('\n') : 'No saved flows yet. Use the site, then studio flow save <name>.', images: [], result: null };
    }
    if (!name || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw new DriverError('Name the flow in lowercase with dashes: studio flow save add-to-cart');
    if (action === 'save') {
      const session = await this.browsers.withAgentPage(design, draft, {}, async agent => agent);
      const steps = await this.steps(session.session.id);
      if (steps.length < 2) throw new DriverError('There is nothing to save yet: open a page and use it first.');
      const flow: Flow = flowSchema.parse({ name, device: session.device, steps });
      const outcome = await this.drafts.change(caller.designId, caller.store, caller.actor, { kind: 'files', write: new Map([[`tests/flows/${name}.json`, Buffer.from(`${JSON.stringify(flow, null, 2)}\n`)]]), delete: [] }, { owner, ownerTtlMs: 20 * 60_000 });
      const lines = flow.steps.map((step, index) => `  ${index + 1}. ${step.do}${'path' in step ? ` ${step.path}` : ''}${'target' in step ? ` ${describeTarget(step.target)}` : ''}${'value' in step ? ` "${step.value}"` : ''}${'text' in step ? ` "${step.text}"` : ''}`);
      return { text: `Saved tests/flows/${name}.json (${flow.steps.length} steps; it runs in every version check):\n${lines.join('\n')}`, images: [], result: outcome.result };
    }
    if (action === 'run') {
      const tree = await this.versions.tree(caller.store, draft.tree);
      const hash = tree[`tests/flows/${name}.json`];
      if (!hash) throw new DriverError(`There is no flow called ${name}. studio flow list shows them.`);
      const flow = flowSchema.parse(JSON.parse((await this.versions.blob(caller.store, hash)).toString('utf8')));
      const { token } = this.tokens.sign({ design: design.id, store: design.store, tree: null, agent: false }, 900);
      return this.browsers.withFreshContext(design.store, draft.id, flow.device, async context => {
        const page = await context.newPage();
        await page.goto(this.tokens.url(design.id, token, '/'), { waitUntil: 'domcontentloaded' });
        const basename = new URL(page.url()).pathname.match(/^\/d\/[^/]+\/[^/]+/)?.[0] ?? '';
        const run = await runFlow(new PageDriver(page, basename, flow.device === 'phone'), flow);
        const text = [`Flow ${name} ${run.passed ? 'passed' : 'failed'} on a ${flow.device}:`, ...run.steps.map((step, index) => `  ${step.ok ? '✓' : '✗'} ${index + 1}. ${step.step}${step.detail ? `\n     ${step.detail}` : ''}`)].join('\n');
        return { text, images: run.passed ? [] : [await page.screenshot({ type: 'jpeg', quality: 70 })], result: null };
      });
    }
    throw new DriverError('Use studio flow save <name>, studio flow run <name> or studio flow list');
  }

  private async lastOutline(session: string): Promise<Outline | null> {
    const saved = await this.redis.get(`outline:${session}`);
    return saved ? (JSON.parse(saved) as Outline) : null;
  }

  private async saveOutline(session: string, outline: Outline): Promise<void> {
    await this.redis.set(`outline:${session}`, JSON.stringify(outline), 'EX', 6 * 3600);
  }

  private async resetSteps(session: string, step: FlowStep): Promise<void> {
    await this.redis.multi().del(`steps:${session}`).rpush(`steps:${session}`, JSON.stringify(step)).expire(`steps:${session}`, 6 * 3600).exec();
  }

  private async recordStep(session: string, step: FlowStep): Promise<void> {
    await this.redis.multi().rpush(`steps:${session}`, JSON.stringify(step)).ltrim(`steps:${session}`, -40, -1).expire(`steps:${session}`, 6 * 3600).exec();
  }

  private async steps(session: string): Promise<FlowStep[]> {
    return (await this.redis.lrange(`steps:${session}`, 0, -1)).map(step => JSON.parse(step) as FlowStep);
  }
}
