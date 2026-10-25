import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PreviewTokens } from '../preview/preview-tokens';
import { Storage } from '../storage/storage';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  data: 'text/x-script',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml',
};

@Controller('_studio/check/:store/:tree/:key')
export class CheckController {
  constructor(
    private readonly tokens: PreviewTokens,
    private readonly storage: Storage,
  ) {}

  @Get()
  root(@Param('store') store: string, @Param('tree') tree: string, @Param('key') key: string, @Res() res: Response) {
    return this.serve(store, tree, key, '', res);
  }

  @Get('*file')
  file(@Param('store') store: string, @Param('tree') tree: string, @Param('key') key: string, @Param('file') file: string | string[], @Res() res: Response) {
    return this.serve(store, tree, key, Array.isArray(file) ? file.join('/') : file, res);
  }

  private async serve(store: string, tree: string, key: string, requested: string, res: Response) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(store) || !/^[0-9a-f]{64}$/.test(tree) || !this.tokens.verifyCheck(store, tree, key) || requested.includes('..')) throw new NotFoundException();
    const prefix = `stores/${store}/checks/${tree}/client`;
    const name = requested.replace(/\/+$/, '');
    const hasExtension = /\.[a-z0-9]+$/i.test(name);
    const candidates = hasExtension ? [name] : [name ? `${name}/index.html` : 'index.html', '__spa-fallback.html', 'index.html'];
    for (const candidate of candidates) {
      const bytes = await this.storage.get(`${prefix}/${candidate}`);
      if (!bytes) continue;
      res
        .setHeader('content-type', TYPES[candidate.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream')
        .setHeader('cache-control', 'private, max-age=300')
        .end(bytes);
      return;
    }
    throw new NotFoundException();
  }
}
