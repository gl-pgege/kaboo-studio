import { readFileSync } from 'node:fs';
import { config } from '../config';
import type { Storage } from '../storage/storage';

export interface EdgeRequest {
  uri: string;
  headers: Record<string, { value: string } | undefined>;
}
export type EdgeResult = EdgeRequest | { statusCode: number; statusDescription?: string };
export type Router = (event: { request: EdgeRequest }) => Promise<EdgeResult>;

export interface KeyValues {
  get(key: string): Promise<string | null>;
}

export const ASSET_CACHE = 'public, max-age=31536000, immutable';
export const PAGE_CACHE = 'public, max-age=0, s-maxage=31536000, must-revalidate';
export const SHELL_CACHE = 'public, max-age=0, s-maxage=60';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  data: 'text/x-script',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
  webmanifest: 'application/manifest+json',
};

export function contentType(file: string): string {
  return TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export function cacheControlOf(file: string): string {
  return file.startsWith('assets/') ? ASSET_CACHE : PAGE_CACHE;
}

export function loadRouter(values: KeyValues, source = readFileSync(config.routerFile, 'utf8')): Router {
  const body = source.replace(/^import cf from 'cloudfront';\s*$/m, '');
  const cf = {
    kvs: () => ({
      get: async (key: string) => {
        const value = await values.get(key);
        if (value === null) throw new Error(`The key ${key} does not exist`);
        return value;
      },
    }),
  };
  return new Function('cf', `${body}\nreturn handler;`)(cf) as Router;
}

const DEPLOYMENT_URI = /^\/d\/([a-z0-9][a-z0-9-]*)\/([0-9a-f-]{36})\/(.*)$/;

export async function deploymentFile(storage: Storage, uri: string): Promise<{ body: Buffer; type: string; cache: string } | null> {
  const match = DEPLOYMENT_URI.exec(uri);
  if (!match || match[3].split('/').includes('..')) return null;
  const prefix = `d/${match[1]}/${match[2]}`;
  const file = match[3] || 'index.html';
  const exact = await storage.get(`${prefix}/${file}`).catch(() => null);
  if (exact) return { body: exact, type: contentType(file), cache: cacheControlOf(file) };
  if (file !== 'index.html' && !file.endsWith('/index.html')) return null;
  const shell = await storage.get(`${prefix}/__spa-fallback.html`).catch(() => null);
  return shell ? { body: shell, type: contentType('index.html'), cache: SHELL_CACHE } : null;
}
