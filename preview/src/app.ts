import { Bridge } from './bridge.ts';
import { EditMode } from './edit.ts';
import type { StudioLog } from './instrument.ts';
import { type Exports, type Manifest, Registry } from './registry.ts';
import { missedUpdate, type RouteEntry, routeFiles, routeHelpers } from './resolve.ts';
import { Vendor } from './vendor.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type ReactModule = any;

export interface Boot {
  manifest: Manifest;
  seq: number | null;
  live: boolean;
  agent: boolean;
  parentOrigins: string[];
  config: Record<string, unknown>;
  brand?: string;
}

interface Update {
  tree: string;
  seq: number;
  modules: Record<string, string>;
  deleted: string[];
  reload: boolean;
}

const UPDATE_WINDOW_MS = 3000;
const RELOAD_FILES = new Set(['app/root.tsx', 'app/routes.ts']);

const nextPaint = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export class PreviewApp {
  private React!: ReactModule;
  private ReactDOM!: ReactModule;
  private RR!: ReactModule;
  private vendor!: Vendor;
  private registry!: Registry;
  private previous: Registry | null = null;
  private root: any = null;
  private router: any = null;
  private routes: RouteEntry[] = [];
  private shapes = new Map<string, string>();
  private version = 0;
  private generation = 0;
  private listeners = new Set<() => void>();
  private seq: number | null;
  private updatedAt = 0;
  private errors: string[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly codes = new Map<string, Promise<string>>();
  private readonly pill: HTMLElement;
  readonly bridge: Bridge;
  readonly edit: EditMode;

  constructor(
    private readonly api: (path: string) => string,
    private readonly basename: string,
    private boot: Boot,
    private readonly log: StudioLog,
  ) {
    this.seq = boot.seq;
    this.bridge = new Bridge(boot.parentOrigins, boot.brand);
    this.edit = new EditMode(this.bridge);
    this.pill = document.createElement('div');
    this.pill.setAttribute('role', 'status');
    this.pill.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483647;display:none;max-width:min(420px,80vw);padding:8px 12px;border-radius:999px;background:#111827;color:#fff;font:500 12px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    document.body.append(this.pill);
    window.addEventListener('error', event => this.recordError(event.error ?? event.message));
    window.addEventListener('unhandledrejection', event => this.recordError(event.reason));
    window.addEventListener(`${boot.brand ?? 'studio'}:route`, event => this.bridge.post('route', (event as CustomEvent).detail));
    document.addEventListener('click', event => this.keepInside(event));
    this.bridge.onMessage(message => {
      if (message.type === 'select-mode') this.edit.setSelecting(message.on);
      else if (message.type === 'edit-mode') this.edit.setEditing(message.on);
      else if (message.type === 'navigate') void this.router?.navigate(message.path);
      else if (message.type === 'reload') void this.reload();
    });
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = () => this.version;

  private vendorKey = '';

  private async openVendor(key: string) {
    this.vendor = await Vendor.open(this.api(`vendor/${key}/`));
    [this.React, this.ReactDOM, this.RR] = await Promise.all([this.vendor.load('react'), this.vendor.load('react-dom/client'), this.vendor.load('react-router')]);
    this.vendorKey = key;
    this.guardClass = undefined;
  }

  async start(): Promise<void> {
    await this.openVendor(this.boot.manifest.vendor);
    const started = performance.now();
    await this.mount(this.boot.manifest);
    await nextPaint();
    await this.acknowledge(this.boot.manifest.tree, this.seq, started);
    this.bridge.post('ready', { tree: this.boot.manifest.tree, agent: this.boot.agent });
  }

  update(update: Update): Promise<void> {
    this.queue = this.queue.then(() => this.apply(update)).catch(error => this.recordError(error));
    return this.queue;
  }

  compileError(tree: string, errors: Array<{ file: string; line: number | null; message: string }>) {
    const first = errors[0];
    this.showPill(first ? `Working… ${first.file}${first.line ? `:${first.line}` : ''} ${first.message}` : 'Working…');
    this.bridge.post('errors', { tree, errors: errors.map(error => `${error.file}${error.line ? `:${error.line}` : ''} ${error.message}`) });
  }

  async reload(): Promise<void> {
    const started = performance.now();
    const boot = (await (await fetch(this.api('manifest'))).json()) as Boot;
    this.boot = boot;
    this.seq = boot.seq;
    await this.remount(boot.manifest);
    await nextPaint();
    await this.acknowledge(boot.manifest.tree, this.seq, started);
  }

  private async apply(update: Update) {
    const started = performance.now();
    if (missedUpdate(this.seq, update.seq) || update.reload || update.deleted.length || Object.keys(update.modules).some(file => RELOAD_FILES.has(file))) {
      await this.reload();
      return;
    }
    this.seq = update.seq;
    const boot = (await (await fetch(this.api('manifest'))).json()) as Boot;
    if (boot.manifest.tree !== update.tree) {
      await this.reload();
      return;
    }
    if (boot.manifest.vendor !== this.registry.manifest.vendor) {
      await this.remount(boot.manifest);
      await nextPaint();
      await this.acknowledge(update.tree, update.seq, started);
      return;
    }
    const changed = Object.keys(update.modules);
    const affected = this.registry.affectedBy(changed);
    const staged = this.createRegistry(boot.manifest, this.registry, affected);
    this.errors = [];
    try {
      await staged.prefetch();
      await Promise.all([staged.load('app/root.tsx'), ...routeFiles(this.routes).map(file => staged.load(`app/${file}`))]);
    } catch (error) {
      this.recordError(error);
      this.showPill(`Working… ${error instanceof Error ? error.message : String(error)}`);
      await this.acknowledge(update.tree, update.seq, started, false);
      return;
    }
    if (this.shapeChanged(staged)) {
      await this.remount(boot.manifest);
      await nextPaint();
      await this.acknowledge(update.tree, update.seq, started);
      return;
    }
    this.previous = this.registry;
    this.registry = staged;
    this.applyCss(boot.manifest);
    this.updatedAt = Date.now();
    this.bump();
    if (changed.some(file => routeFiles(this.routes).includes(file.replace(/^app\//, '')))) await this.router.revalidate();
    await nextPaint();
    await this.acknowledge(update.tree, update.seq, started);
  }

  private createRegistry(manifest: Manifest, inherited?: Registry, affected?: Set<string>) {
    return new Registry(
      manifest,
      hash => {
        let pending = this.codes.get(hash);
        if (!pending) {
          pending = fetch(this.api(`modules/${hash}`)).then(response => {
            if (!response.ok) throw new Error(`Module ${hash.slice(0, 8)} is missing (${response.status})`);
            return response.text();
          });
          this.codes.set(hash, pending);
        }
        return pending;
      },
      async resolved => {
        if (resolved.kind === 'vendor') return this.vendor.load(resolved.specifier);
        if (resolved.kind === 'builtin') return { ...routeHelpers, default: routeHelpers } as Exports;
        if (resolved.kind === 'file') return { default: this.api(`files/${resolved.path}`) } as Exports;
        return { default: '' } as Exports;
      },
      inherited,
      affected,
    );
  }

  private async mount(manifest: Manifest) {
    const registry = this.createRegistry(manifest);
    await registry.prefetch();
    const routesModule = await registry.load('app/routes.ts');
    const routes = (await (routesModule.default as Promise<RouteEntry[]> | RouteEntry[])) ?? [];
    await Promise.all([registry.load('app/root.tsx'), ...routeFiles(routes).map(file => registry.load(`app/${file}`))]);
    this.registry = registry;
    this.previous = null;
    this.routes = routes;
    this.shapes = this.shapesOf(registry);
    this.applyCss(manifest);
    const { createElement } = this.React;
    this.router = this.RR.createBrowserRouter(this.createRoutes(routes), { basename: this.basename });
    const container = document.getElementById('studio-root')!;
    this.root = this.ReactDOM.createRoot(container, {
      onCaughtError: (error: unknown) => this.recordError(error),
      onUncaughtError: (error: unknown) => this.recordError(error),
      onRecoverableError: (error: unknown) => this.recordError(error),
    });
    this.root.render(createElement(this.RR.RouterProvider, { router: this.router }));
  }

  private currentPath(): string | null {
    if (!this.router) return null;
    const { pathname } = this.router.state.location as { pathname: string };
    return pathname.startsWith(this.basename) ? pathname.slice(this.basename.length) || '/' : pathname;
  }

  private async remount(manifest: Manifest) {
    const location = this.router ? `${this.currentPath()}${this.router.state.location.search}` : null;
    this.root?.unmount();
    this.router?.dispose();
    this.root = null;
    if (manifest.vendor !== this.vendorKey) await this.openVendor(manifest.vendor);
    this.errors = [];
    await this.mount(manifest);
    if (location) await this.router.navigate(location, { replace: true });
    this.hidePill();
  }

  private createRoutes(entries: RouteEntry[]) {
    const make = (entry: RouteEntry): Record<string, unknown> => {
      const file = `app/${entry.file}`;
      const module = this.registry.exportsOf(file);
      const route: Record<string, unknown> = { id: entry.id ?? entry.file.replace(/\.[^.]+$/, ''), path: entry.path, index: entry.index, caseSensitive: entry.caseSensitive };
      if (typeof module.loader === 'function' || typeof module.clientLoader === 'function') route.loader = (args: Record<string, unknown>) => this.callLoader(file, args);
      if ('default' in module) route.Component = this.routeComponent(file, 'default');
      if (typeof module.ErrorBoundary === 'function') route.ErrorBoundary = this.routeComponent(file, 'ErrorBoundary');
      if (typeof module.HydrateFallback === 'function') route.HydrateFallback = this.fallback(file);
      if (!entry.index && entry.children?.length) route.children = entry.children.map(make);
      return route;
    };
    return [make({ id: 'root', file: 'root.tsx', path: '', children: entries })];
  }

  private async callLoader(file: string, args: Record<string, unknown>) {
    const module = this.registry.exportsOf(file);
    if (typeof module.clientLoader === 'function') return module.clientLoader({ ...args, serverLoader: () => Promise.reject(new Error('Previews have no server')) });
    if (typeof module.loader === 'function') return module.loader(args);
    return null;
  }

  private routeComponent(file: string, name: 'default' | 'ErrorBoundary') {
    const app = this;
    const { createElement, useSyncExternalStore } = this.React;
    const RR = this.RR;
    const Guard = this.guard();
    function StudioRoute() {
      useSyncExternalStore(app.subscribe, app.snapshot);
      const loaderData = RR.useLoaderData();
      const params = RR.useParams();
      const matches = RR.useMatches();
      const error = name === 'ErrorBoundary' ? RR.useRouteError() : undefined;
      const Component = app.registry.exportsOf(file)[name] as unknown;
      if (typeof Component !== 'function' && typeof Component !== 'object') return null;
      return createElement(Guard, { key: app.generation, file }, createElement(Component, { loaderData, params, matches, error }));
    }
    StudioRoute.displayName = `StudioRoute(${file})`;
    return StudioRoute;
  }

  private fallback(file: string) {
    const app = this;
    const { createElement } = this.React;
    function StudioFallback() {
      const Component = app.registry.exportsOf(file).HydrateFallback as unknown;
      return typeof Component === 'function' ? createElement(Component) : null;
    }
    return StudioFallback;
  }

  private guardClass: unknown;

  private guard() {
    if (this.guardClass) return this.guardClass;
    const app = this;
    class Guard extends this.React.Component {
      state = { error: null as unknown };
      static getDerivedStateFromError(error: unknown) {
        return { error };
      }
      componentDidCatch(error: unknown) {
        app.recordError(error);
        if (Date.now() - app.updatedAt < UPDATE_WINDOW_MS && app.previous) app.rollback(error);
      }
      render() {
        if (this.state.error) {
          if (Date.now() - app.updatedAt < UPDATE_WINDOW_MS && app.previous) return null;
          throw this.state.error;
        }
        return (this as any).props.children;
      }
    }
    this.guardClass = Guard;
    return Guard;
  }

  private rollback(error: unknown) {
    if (!this.previous) return;
    this.registry = this.previous;
    this.previous = null;
    this.generation++;
    this.showPill(`Working… ${error instanceof Error ? error.message : String(error)}`);
    queueMicrotask(() => this.bump());
  }

  private shapesOf(registry: Registry) {
    const shapes = new Map<string, string>();
    for (const file of ['root.tsx', ...routeFiles(this.routes)]) {
      const module = registry.exportsOf(`app/${file}`);
      shapes.set(file, ['loader', 'clientLoader', 'ErrorBoundary', 'HydrateFallback', 'default'].filter(name => name in module).join(','));
    }
    return shapes;
  }

  private shapeChanged(staged: Registry): boolean {
    const next = this.shapesOf(staged);
    return [...next].some(([file, shape]) => this.shapes.get(file) !== shape);
  }

  private applyCss(manifest: Manifest) {
    const style = document.getElementById('studio-css')!;
    if (!manifest.css) {
      style.textContent = '';
      return;
    }
    const css = manifest.css;
    void fetch(this.api(`css/${css}`))
      .then(response => response.text())
      .then(text => {
        if (this.registry.manifest.css !== css) return;
        style.textContent = text.replaceAll('__VENDOR__/', this.api(`vendor/${manifest.vendor}/`)).replaceAll('__FILES__/', this.api('files/'));
      });
  }

  private bump() {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  private keepInside(event: MouseEvent) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = anchor?.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith(this.basename) || anchor?.getAttribute('target')) return;
    event.preventDefault();
    void this.router?.navigate(href);
  }

  recordError(error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (!this.errors.includes(message) && this.errors.length < 10) this.errors.push(message);
    if (!this.log.thrown.includes(message) && this.log.thrown.length < 10) this.log.thrown.push(message);
    this.bridge.post('runtime-error', { message });
  }

  private async quiet(limitMs = 1500) {
    const until = performance.now() + limitMs;
    while (performance.now() < until && (this.log.pending > 0 || Array.from(document.images).some(image => !image.complete))) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private async acknowledge(tree: string, seq: number | null, started: number, rendered = true) {
    const ms = Math.round(performance.now() - started);
    if (rendered) await this.quiet();
    const route = this.currentPath();
    const errors = [...this.errors];
    if (rendered && !errors.length) this.hidePill();
    const taken = this.log.take();
    const faults = [...taken.failed, ...taken.errors.filter(message => !errors.some(error => error.includes(message) || message.includes(error))).map(message => `Console error: ${message}`)].slice(0, 12);
    const ack = { tree: rendered ? tree : null, seq, route, ms, errors, faults };
    this.log.last = { errors, faults };
    this.bridge.post('rendered', ack);
    await fetch(this.api('ack'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...ack, tree: ack.tree ?? tree }) }).catch(() => undefined);
  }

  private showPill(text: string) {
    this.pill.textContent = text.length > 160 ? `${text.slice(0, 157)}…` : text;
    this.pill.style.display = 'block';
  }

  private hidePill() {
    this.pill.style.display = 'none';
  }
}
