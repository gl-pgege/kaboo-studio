import { type Boot, PreviewApp } from './app.ts';
import { type Hints, instrument } from './instrument.ts';
import { parsePreviewPath } from './resolve.ts';

function fatal(message: string) {
  const root = document.getElementById('studio-root')!;
  root.innerHTML = '';
  const box = document.createElement('main');
  box.style.cssText = 'font:15px/1.5 system-ui,sans-serif;max-width:36rem;margin:20vh auto;padding:0 24px;color:#111827';
  const title = document.createElement('h1');
  title.style.cssText = 'font-size:20px;margin:0 0 8px';
  title.textContent = 'This preview could not be opened';
  const detail = document.createElement('p');
  detail.style.color = '#4b5563';
  detail.textContent = message;
  box.append(title, detail);
  root.append(box);
}

function connect(api: (path: string) => string, app: PreviewApp) {
  const source = new EventSource(api('events'));
  let opened = false;
  const data = (event: Event) => (JSON.parse((event as MessageEvent).data) as { data: Record<string, unknown> }).data;
  source.addEventListener('open', () => {
    if (opened) void app.reload();
    opened = true;
  });
  source.addEventListener('update', event => void app.update(data(event) as never));
  source.addEventListener('compile-error', event => {
    const detail = data(event) as { tree: string; errors: Array<{ file: string; line: number | null; message: string }> };
    app.compileError(detail.tree, detail.errors);
  });
  source.addEventListener('session', event => app.bridge.post('session', data(event)));
}

async function main() {
  const place = parsePreviewPath(location.pathname);
  if (!place) return fatal('This address is not a preview. Open the preview from the studio.');
  const api = (path: string) => `/_studio/preview/${place.token}/${path}`;
  const response = await fetch(api('manifest'));
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    return fatal(body?.message ?? `The studio answered ${response.status}.`);
  }
  const boot = (await response.json()) as Boot;
  const brand = boot.brand ?? 'studio';
  const log = instrument(place.basename, typeof boot.config.assetOrigin === 'string' ? [boot.config.assetOrigin] : [], (boot.config.hints ?? {}) as Hints);
  Object.assign(globalThis, {
    [`__${brand.toUpperCase()}__`]: { ...boot.config, preview: { token: place.token } },
    process: { env: { NODE_ENV: 'production', STUDIO_BLOCKS: '1' } },
  });
  const app = new PreviewApp(api, place.basename, boot, log);
  await app.start();
  if (boot.live) connect(api, app);
}

main().catch(error => fatal(error instanceof Error ? error.message : String(error)));
