export const MODULE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs'];
export const BUILTINS = new Set(['@react-router/dev/routes']);

export type Resolved =
  | { kind: 'app'; path: string }
  | { kind: 'file'; path: string }
  | { kind: 'stub' }
  | { kind: 'builtin'; name: string }
  | { kind: 'vendor'; specifier: string };

export function dirname(file: string): string {
  const index = file.lastIndexOf('/');
  return index < 0 ? '' : file.slice(0, index);
}

export function join(base: string, relative: string): string {
  const parts = base ? base.split('/') : [];
  for (const part of relative.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

export function resolveSpecifier(importer: string, specifier: string, modules: Record<string, unknown>, files: Record<string, unknown>): Resolved {
  const [bare, query] = specifier.split('?');
  if (/\.css$/.test(bare) || query !== undefined) return { kind: 'stub' };
  if (BUILTINS.has(bare)) return { kind: 'builtin', name: bare };
  let target: string;
  if (bare.startsWith('~/')) target = `app/${bare.slice(2)}`;
  else if (bare.startsWith('/')) target = bare.slice(1);
  else if (bare.startsWith('.')) target = join(dirname(importer), bare);
  else return { kind: 'vendor', specifier: bare };
  const candidates = [target, ...MODULE_EXTS.map(ext => `${target}${ext}`), ...MODULE_EXTS.map(ext => `${target}/index${ext}`)];
  for (const candidate of candidates) {
    if (candidate in modules) return { kind: 'app', path: candidate };
    if (candidate in files) return { kind: 'file', path: candidate };
  }
  throw new Error(`Cannot find "${specifier}" imported by ${importer}`);
}

export interface RouteEntry {
  id?: string;
  file: string;
  path?: string;
  index?: boolean;
  caseSensitive?: boolean;
  children?: RouteEntry[];
}

function split(rest: unknown[]): [Record<string, unknown>, RouteEntry[] | undefined] {
  if (Array.isArray(rest[0])) return [{}, rest[0] as RouteEntry[]];
  return [(rest[0] as Record<string, unknown>) ?? {}, rest[1] as RouteEntry[] | undefined];
}

export const routeHelpers = {
  index: (file: string, options: Record<string, unknown> = {}): RouteEntry => ({ ...options, index: true, file }),
  route: (path: string | null | undefined, file: string, ...rest: unknown[]): RouteEntry => {
    const [options, children] = split(rest);
    return { ...options, path: path ?? undefined, file, children };
  },
  layout: (file: string, ...rest: unknown[]): RouteEntry => {
    const [options, children] = split(rest);
    return { ...options, file, children };
  },
  prefix: (prefixPath: string, routes: RouteEntry[]): RouteEntry[] =>
    routes.map(route => (route.index ? { ...route, index: undefined, path: prefixPath } : { ...route, path: route.path ? `${prefixPath}/${route.path}`.replace(/\/+/g, '/') : prefixPath })),
  relative: (directory: string) => ({
    index: (file: string, options?: Record<string, unknown>) => routeHelpers.index(join(directory, file), options),
    route: (path: string, file: string, ...rest: unknown[]) => routeHelpers.route(path, join(directory, file), ...rest),
    layout: (file: string, ...rest: unknown[]) => routeHelpers.layout(join(directory, file), ...rest),
  }),
};

export function routeFiles(entries: RouteEntry[]): string[] {
  return entries.flatMap(entry => [entry.file, ...routeFiles(entry.children ?? [])]);
}

export function parsePreviewPath(pathname: string): { design: string; token: string; basename: string; rest: string } | null {
  const match = pathname.match(/^\/d\/([0-9a-zA-Z-]+)\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(\/.*)?$/);
  if (!match) return null;
  return { design: match[1], token: match[2], basename: `/d/${match[1]}/${match[2]}`, rest: match[3] ?? '/' };
}

export function missedUpdate(current: number | null, incoming: number): boolean {
  return current !== null && incoming !== current + 1;
}
