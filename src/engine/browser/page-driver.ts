import type { Locator, Page } from 'playwright-core';
import { captureOutline, describe, keep, type Outline, type OutlineNode } from './page-outline';

export class DriverError extends Error {}

export interface ActionReport {
  did: string;
  target: OutlineNode | null;
  settled: boolean;
  settleMs: number;
  url: string;
  errors: string[];
  failed: string[];
  outline: Outline;
}

export interface FlowTarget {
  role?: string;
  name?: string;
  within?: string;
  nth?: number;
}

const CLICKABLE = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'option', 'switch', 'combobox', 'textbox', 'searchbox'];
const FILLABLE = ['textbox', 'searchbox', 'combobox', 'spinbutton'];

const SETTLE = async ({ quietMs, timeoutMs }: { quietMs: number; timeoutMs: number }) => {
  const started = performance.now();
  let last = performance.now();
  const observer = new MutationObserver(() => {
    last = performance.now();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    while (performance.now() - started < timeoutMs) {
      const pending = (window as unknown as { __studio?: { pending: number } }).__studio?.pending ?? 0;
      const animating = document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity);
      if (!pending && !animating && performance.now() - last >= quietMs) return { settled: true, ms: Math.round(performance.now() - started) };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return { settled: false, ms: Math.round(performance.now() - started) };
  } finally {
    observer.disconnect();
  }
};

export class PageDriver {
  constructor(
    private readonly page: Page,
    private readonly basename: string,
    private readonly phone: boolean,
  ) {}

  path(): string {
    const url = new URL(this.page.url());
    const path = url.pathname.startsWith(this.basename) ? url.pathname.slice(this.basename.length) || '/' : url.pathname;
    return `${path}${url.search}`;
  }

  async settle(timeoutMs = 5000) {
    return this.page.evaluate(SETTLE, { quietMs: 300, timeoutMs }).catch(() => ({ settled: false, ms: timeoutMs }));
  }

  async drain(): Promise<{ errors: string[]; failed: string[] }> {
    return this.page
      .evaluate(() => {
        const log = (window as unknown as { __studio?: { take?: () => { errors: string[]; failed: string[]; thrown?: string[] } } }).__studio;
        const taken = log?.take?.() ?? { errors: [], failed: [], thrown: [] };
        return { errors: [...new Set([...(taken.thrown ?? []), ...taken.errors])], failed: taken.failed };
      })
      .catch(() => ({ errors: [], failed: [] }));
  }

  async outline(): Promise<Outline> {
    return captureOutline(this.page, this.basename);
  }

  async open(path: string): Promise<void> {
    const target = path.startsWith('/') ? path : `/${path}`;
    await this.page.goto(`${new URL(this.page.url()).origin}${this.basename}${target}`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForFunction(() => (document.querySelector('#studio-root') ?? document.body)?.textContent?.trim(), null, { timeout: 20_000, polling: 100 }).catch(() => undefined);
  }

  resolve(outline: Outline, spec: string, options: { within?: string; roles?: string[]; previous?: Outline | null } = {}): { node: OutlineNode; locator: Locator } {
    if (/^e\d+$/.test(spec)) {
      const seen = options.previous?.nodes.find(candidate => candidate.ref === spec);
      let node = outline.nodes.find(candidate => candidate.ref === spec);
      if (seen && (!node || node.role !== seen.role || node.name !== seen.name)) {
        const moved = outline.nodes.filter(candidate => candidate.role === seen.role && candidate.name === seen.name);
        if (moved.length !== 1) throw new DriverError(`${spec} (${describe(seen)}) isn't on the page any more, or the page changed around it. Take a fresh look with studio screenshot.`);
        node = moved[0];
      }
      if (!node) throw new DriverError(`There is no ${spec} on the page now. Take a fresh look with studio screenshot.`);
      return { node, locator: this.page.locator(`aria-ref=${node.ref}`) };
    }
    const wanted = spec.trim().toLowerCase();
    const roles = options.roles ?? CLICKABLE;
    const pool = outline.nodes.filter(node => roles.includes(node.role) && (!options.within || node.context.some(name => name.toLowerCase().includes(options.within!.toLowerCase()))));
    let matches = pool.filter(node => node.name.trim().toLowerCase() === wanted);
    if (!matches.length) matches = pool.filter(node => node.name.toLowerCase().includes(wanted));
    if (!matches.length) {
      const near = outline.nodes.filter(keep).filter(node => node.name.toLowerCase().includes(wanted.split(/\s+/)[0] ?? wanted)).slice(0, 5);
      throw new DriverError(`Nothing on the page is called "${spec}"${options.within ? ` inside "${options.within}"` : ''}.${near.length ? ` Close matches:\n${near.map(node => `  ${node.ref} ${describe(node)}${node.source ? `  ${node.source}` : ''}`).join('\n')}` : ' Take a fresh look with studio screenshot.'}`);
    }
    if (matches.length > 1) {
      const listed = matches.slice(0, 12).map(node => `  ${node.ref} ${describe(node)}${node.context.length ? ` in "${node.context[node.context.length - 1]}"` : ''}${node.source ? `  ${node.source}` : ''}`);
      throw new DriverError(`${matches.length} things are called "${spec}". Pick one by number, or narrow it with --in "<section or card>":\n${listed.join('\n')}`);
    }
    return { node: matches[0], locator: this.page.locator(`aria-ref=${matches[0].ref}`) };
  }

  resolveFlowTarget(outline: Outline, target: FlowTarget): { node: OutlineNode; locator: Locator } {
    if (target.nth !== undefined) {
      const pool = outline.nodes.filter(node => node.role === (target.role ?? 'link') && (!target.within || node.context.some(name => name.toLowerCase() === target.within!.toLowerCase())));
      const node = pool[target.nth];
      if (!node) throw new DriverError(`There is no link number ${target.nth + 1} in "${target.within}".`);
      return { node, locator: this.page.locator(`aria-ref=${node.ref}`) };
    }
    return this.resolve(outline, target.name ?? '', { roles: target.role ? [target.role] : undefined, within: target.within });
  }

  async click(locator: Locator, node: OutlineNode): Promise<void> {
    try {
      await locator.click({ timeout: 5000 });
    } catch (error) {
      throw new DriverError(await this.explain(error, locator, node, 'click'));
    }
  }

  async clickAt(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }

  async fill(locator: Locator, node: OutlineNode, value: string): Promise<void> {
    try {
      await locator.fill(value, { timeout: 5000 });
    } catch (error) {
      throw new DriverError(await this.explain(error, locator, node, 'fill'));
    }
  }

  async select(outline: Outline, label: string, value: string, within?: string): Promise<OutlineNode> {
    const { node, locator } = this.resolve(outline, label, { roles: ['combobox', 'listbox', 'radiogroup', 'group'], within });
    if (node.role === 'radiogroup' || node.role === 'group') {
      const radio = locator.getByRole('radio', { name: value, exact: false });
      if (!(await radio.count())) throw new DriverError(`"${label}" has no choice called "${value}".`);
      await radio.first().click({ timeout: 5000 });
      return node;
    }
    const native = await locator.evaluate(element => element.tagName === 'SELECT').catch(() => false);
    if (native) {
      await locator.selectOption({ label: value }).catch(() => locator.selectOption(value));
      return node;
    }
    await locator.click({ timeout: 5000 });
    await this.settle(2000);
    const option = this.page.getByRole('option', { name: value, exact: false });
    if (!(await option.count())) throw new DriverError(`"${label}" opened, but has no option called "${value}".`);
    await option.first().click({ timeout: 5000 });
    return node;
  }

  async hover(locator: Locator, node: OutlineNode): Promise<void> {
    if (this.phone) throw new DriverError("Phones can't hover: designs shouldn't need it. Use studio click, or open on --desktop.");
    await locator.hover({ timeout: 5000 }).catch(async error => {
      throw new DriverError(await this.explain(error, locator, node, 'hover'));
    });
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async scroll(direction: 'up' | 'down', screens = 1): Promise<void> {
    const height = await this.page.evaluate(() => innerHeight);
    for (let index = 0; index < screens; index++) await this.page.mouse.wheel(0, (direction === 'down' ? 1 : -1) * Math.round(height * 0.85));
  }

  async scrollSideways(locator: Locator, direction: 'left' | 'right'): Promise<number> {
    return locator.evaluate((element, dir) => {
      const before = element.scrollLeft;
      element.scrollBy({ left: (dir === 'right' ? 1 : -1) * Math.round(element.clientWidth * 0.85), behavior: 'instant' as ScrollBehavior });
      return element.scrollLeft - before;
    }, direction);
  }

  async scrollToBottom(): Promise<number> {
    let stable = 0;
    let previous = 0;
    for (let step = 0; step < 25 && stable < 2; step++) {
      await this.scroll('down');
      await this.settle(1500);
      const height = await this.page.evaluate(() => document.documentElement.scrollHeight);
      stable = height === previous ? stable + 1 : 0;
      previous = height;
    }
    return previous;
  }

  async swipe(locator: Locator, direction: 'left' | 'right' | 'up' | 'down'): Promise<void> {
    if (direction === 'left' || direction === 'right') {
      const moved = await this.scrollSideways(locator, direction === 'left' ? 'right' : 'left');
      if (moved) return;
    }
    const box = await locator.boundingBox();
    if (!box) throw new DriverError('That element is not on the page.');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    const dx = direction === 'left' ? -box.width * 0.6 : direction === 'right' ? box.width * 0.6 : 0;
    const dy = direction === 'up' ? -box.height * 0.6 : direction === 'down' ? box.height * 0.6 : 0;
    await this.page.mouse.move(startX, startY);
    await this.page.mouse.down();
    await this.page.mouse.move(startX + dx, startY + dy, { steps: 8 });
    await this.page.mouse.up();
  }

  async wait(text: string, gone: boolean): Promise<void> {
    await this.page
      .getByText(text, { exact: false })
      .first()
      .waitFor({ state: gone ? 'hidden' : 'visible', timeout: 5000 })
      .catch(() => {
        throw new DriverError(`"${text}" ${gone ? 'is still on the page' : "didn't appear"} after 5 seconds.`);
      });
  }

  async evaluate(code: string): Promise<string> {
    const value = await this.page.evaluate(code).catch(error => {
      throw new DriverError(`The script failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    });
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
    return text === undefined ? 'undefined' : text.length > 4000 ? `${text.slice(0, 4000)}… (${text.length} characters)` : text;
  }

  async back(): Promise<void> {
    await this.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }

  private async explain(error: unknown, locator: Locator, node: OutlineNode, verb: string): Promise<string> {
    const message = error instanceof Error ? error.message : String(error);
    const covering = message.match(/<([a-z0-9-]+)[^>]*> (?:from <[^>]+> subtree )?intercepts pointer events/);
    if (covering) {
      const cover = await locator
        .evaluate(element => {
          const rect = element.getBoundingClientRect();
          const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          const source = top?.closest<HTMLElement>('[data-studio-source]')?.dataset.studioSource ?? null;
          return { tag: top?.tagName.toLowerCase() ?? covering[1], text: (top?.textContent ?? '').trim().slice(0, 60), source };
        })
        .catch(() => ({ tag: covering[1], text: '', source: null }));
      return `Couldn't ${verb} ${node.ref} ${describe(node)}: a ${cover.tag}${cover.text ? ` ("${cover.text}")` : ''} is on top of it${cover.source ? ` (${cover.source})` : ''}. That's often a real bug, such as a sticky header or a banner covering content.`;
    }
    if (/not visible|outside of the viewport/.test(message)) return `Couldn't ${verb} ${node.ref} ${describe(node)}: it isn't visible.`;
    if (/not enabled|disabled/.test(message)) return `Couldn't ${verb} ${node.ref} ${describe(node)}: it is disabled.`;
    if (/Timeout/.test(message)) {
      const log = message.split('\n').filter(line => /^\s+-/.test(line)).slice(-2).map(line => line.trim().replace(/^- /, ''));
      return `Couldn't ${verb} ${node.ref} ${describe(node)} within 5 seconds${log.length ? ` (${log.join('; ')})` : ''}.`;
    }
    return `Couldn't ${verb} ${node.ref} ${describe(node)}: ${message.split('\n')[0]}`;
  }
}

export { FILLABLE };
