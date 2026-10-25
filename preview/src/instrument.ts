export interface StudioLog {
  pending: number;
  errors: string[];
  failed: string[];
  thrown: string[];
  last: { errors: string[]; faults: string[] } | null;
  take(): { errors: string[]; failed: string[]; thrown: string[] };
}

export interface Hints {
  blockedPicture?: string;
  blockedRequest?: string;
  missingPicture?: string;
  externalPicture?: string;
  media?: { path: string; message: string };
  api?: { path: string; refused: string; status: string; unreachable: string };
}

const DEFAULTS: Required<Pick<Hints, 'blockedPicture' | 'blockedRequest' | 'missingPicture' | 'externalPicture'>> = {
  blockedPicture: 'The picture {source} is blocked on the live site, which only shows its own pictures',
  blockedRequest: '{method} {url} is blocked on the live site, which only talks to its own address',
  missingPicture: "The picture {source} didn't load: there's no such file",
  externalPicture: "The picture {source} didn't load, and the live site would block it anyway",
};

const LIMIT = 50;

function push(list: string[], value: string) {
  if (list.length < LIMIT && !list.includes(value)) list.push(value);
}

function fill(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

const pathPattern = (path: string) => new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?|/|$)`);

export function instrument(basename: string, allowedOrigins: string[] = [], hints: Hints = {}): StudioLog {
  const text = { ...DEFAULTS, ...hints };
  const origins = new Set([location.origin, ...allowedOrigins.map(origin => new URL(origin, location.href).origin)]);
  const pictures = new Set<string>();
  const apiPattern = hints.api ? pathPattern(hints.api.path) : null;
  const log: StudioLog = {
    pending: 0,
    errors: [],
    failed: [],
    thrown: [],
    last: null,
    take() {
      for (const image of Array.from(document.images)) {
        const source = image.currentSrc || image.src;
        if (!/^https?:/.test(source) || origins.has(new URL(source).origin) || pictures.has(source)) continue;
        pictures.add(source);
        push(log.failed, fill(text.blockedPicture, { source }));
      }
      const out = { errors: [...log.errors], failed: [...log.failed], thrown: [...log.thrown] };
      log.errors.length = 0;
      log.failed.length = 0;
      log.thrown.length = 0;
      return out;
    },
  };
  Object.defineProperty(window, '__studio', { value: log, configurable: true });
  const shown = (url: string) => url.replace(location.origin, '').replace(basename, '').replace(/\/_studio\/preview\/[^/]+\//, '/_studio/');
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const api = hints.api && apiPattern?.test(url) ? hints.api : null;
    if (!url.includes('/_studio/') && !origins.has(new URL(url, location.href).origin)) {
      push(log.failed, fill(text.blockedRequest, { method, url }));
    }
    log.pending++;
    try {
      const response = await original(input, init);
      if (api && response.ok) {
        void response
          .clone()
          .json()
          .then((body: { errors?: Array<{ message?: string }> }) => {
            if (body.errors?.length) push(log.failed, fill(api.refused, { message: body.errors[0].message ?? 'no reason given' }));
          })
          .catch(() => undefined);
      }
      if (response.status >= 400 && !url.includes('/_studio/')) {
        push(log.failed, api ? fill(api.status, { status: response.status, method, url: shown(url) }) : `${response.status} ${method} ${shown(url)}`);
      }
      return response;
    } catch (error) {
      if (!url.includes('/_studio/')) {
        const reason = error instanceof Error ? error.message : String(error);
        push(log.failed, api ? fill(api.unreachable, { method, url: shown(url), reason }) : `failed ${method} ${shown(url)}: ${reason}`);
      }
      throw error;
    } finally {
      log.pending--;
    }
  };
  const error = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push(log.errors, args.map(arg => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ').slice(0, 500));
    error(...args);
  };
  window.addEventListener('error', event => push(log.errors, String(event.error?.message ?? event.message).slice(0, 500)));
  window.addEventListener('unhandledrejection', event => push(log.errors, String(event.reason?.message ?? event.reason).slice(0, 500)));
  window.addEventListener(
    'error',
    event => {
      const target = event.target as HTMLElement | null;
      if (!target || target === (window as unknown as HTMLElement) || !('src' in target)) return;
      const source = String((target as HTMLImageElement).src);
      if (target.tagName === 'IMG') pictures.add(source);
      if (target.tagName !== 'IMG') push(log.failed, `failed to load ${shown(source)}`);
      else if (hints.media && source.includes(hints.media.path)) push(log.failed, fill(hints.media.message, { source: shown(source) }));
      else if (origins.has(new URL(source, location.href).origin)) push(log.failed, fill(text.missingPicture, { source: shown(source) }));
      else push(log.failed, fill(text.externalPicture, { source }));
    },
    true,
  );
  return log;
}
