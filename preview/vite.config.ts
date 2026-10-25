import type { IncomingMessage } from 'node:http';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';

const studio = process.env.STUDIO_URL ?? 'http://localhost:3105';
const proxied = (process.env.PREVIEW_PROXY ?? '')
  .split(',')
  .map(entry => entry.trim())
  .filter(Boolean)
  .map(entry => {
    const at = entry.indexOf('=');
    return { path: entry.slice(0, at), target: entry.slice(at + 1) };
  })
  .filter(entry => entry.path.startsWith('/') && entry.target);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN = new RegExp(`^/(d/|_studio/|src/|@|node_modules/|_runtime/|favicon${proxied.map(entry => `|${escape(entry.path.slice(1))}`).join('')})`);

function designFiles(): Plugin {
  return {
    name: 'studio-design-files',
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, _res, next) => {
        const url = req.url ?? '/';
        const referer = req.headers.referer ? new URL(req.headers.referer).pathname : '';
        const preview = referer.match(/^\/d\/([^/]+)\/([^/]+)\//);
        if (preview && url !== '/' && !OWN.test(url)) req.url = `/_studio/preview/${preview[2]}/files/public${url.split('?')[0]}`;
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.PREVIEW_BASE ?? '/_preview/') : '/',
  plugins: [designFiles()],
  appType: 'spa',
  server: {
    port: Number(process.env.PREVIEW_PORT ?? 4300),
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: ['preview.localhost', '.localhost'],
    proxy: {
      '/_studio': { target: studio },
      ...Object.fromEntries(proxied.map(entry => [entry.path, { target: entry.target, changeOrigin: true } satisfies ProxyOptions])),
    },
  },
  build: { outDir: 'dist', assetsDir: '_runtime', target: 'es2022' },
}));
