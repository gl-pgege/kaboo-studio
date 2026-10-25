import { previewAckSchema } from '../../contract';
import { LiveEventsService } from '../../live-events';
import { Body, Controller, Get, type MessageEvent, NotFoundException, Param, Post, Res, Sse, UseFilters } from '@nestjs/common';
import type { Response } from 'express';
import { defer, finalize, from, ignoreElements, interval, merge, type Observable, switchMap, tap } from 'rxjs';
import { z } from 'zod';
import { SiteDirectory } from '../ports';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { DraftService } from '../drafts/draft.service';
import { parse } from '../internal/internal-key.guard';
import { StudioErrorsFilter } from '../internal/studio-errors.filter';
import { VersionStore } from '../versions/version-store.service';
import { PreviewChannel } from './preview-channel.service';
import { PreviewTokens } from './preview-tokens';
import { PreviewService } from './preview.service';
import { VendorService } from './vendor.service';

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
};
const IMMUTABLE = 'public, max-age=31536000, immutable';
const ackSchema = previewAckSchema.extend({ seq: z.number().int().nullable(), errors: z.array(z.string().max(2000)).max(20), faults: z.array(z.string().max(2000)).max(20).default([]) });

const typeOf = (file: string) => TYPES[file.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
const joined = (value: string | string[]) => (Array.isArray(value) ? value.join('/') : value);

@Controller('_studio/preview/:token')
@UseFilters(StudioErrorsFilter)
export class PreviewController {
  constructor(
    private readonly tokens: PreviewTokens,
    private readonly preview: PreviewService,
    private readonly drafts: DraftService,
    private readonly designs: DesignService,
    private readonly versions: VersionStore,
    private readonly vendor: VendorService,
    private readonly channel: PreviewChannel,
    private readonly live: LiveEventsService,
    private readonly sites: SiteDirectory,
  ) {}

  @Get('manifest')
  async manifest(@Param('token') token: string) {
    const grant = this.tokens.verify(token);
    const { design, draft } = await this.designs.get(grant.design, grant.store);
    const tree = grant.tree ?? draft.tree;
    const manifest = (await this.preview.manifest(grant.store, tree)) ?? (grant.tree ? null : await this.drafts.refreshPreview(design.id, grant.store));
    if (!manifest) throw new NotFoundException('This version has no preview yet.');
    return {
      manifest,
      seq: grant.tree ? null : await this.channel.currentSeq(design.id),
      live: !grant.tree,
      agent: grant.agent,
      parentOrigins: config.previewParentOrigins,
      brand: config.brandId,
      config: await this.sites.previewConfig(grant.store, design.id),
    };
  }

  @Get('modules/:hash')
  async module(@Param('token') token: string, @Param('hash') hash: string, @Res() res: Response) {
    const grant = this.tokens.verify(token);
    const code = await this.preview.module(grant.store, hash);
    if (!code) throw new NotFoundException();
    res.setHeader('content-type', TYPES.js).setHeader('cache-control', IMMUTABLE).end(code);
  }

  @Get('css/:hash')
  async css(@Param('token') token: string, @Param('hash') hash: string, @Res() res: Response) {
    const grant = this.tokens.verify(token);
    const css = await this.preview.module(grant.store, hash);
    if (!css) throw new NotFoundException();
    res.setHeader('content-type', TYPES.css).setHeader('cache-control', IMMUTABLE).end(css);
  }

  @Get('vendor/:key/*file')
  async vendorFile(@Param('token') token: string, @Param('key') key: string, @Param('file') file: string | string[], @Res() res: Response) {
    this.tokens.verify(token);
    const name = joined(file);
    if (!/^[0-9a-f]{64}$/.test(key) || name.includes('..')) throw new NotFoundException();
    const bytes = await this.vendor.file(key, name);
    if (!bytes) throw new NotFoundException();
    res.setHeader('content-type', typeOf(name)).setHeader('cache-control', IMMUTABLE).end(bytes);
  }

  @Get('files/*file')
  async file(@Param('token') token: string, @Param('file') file: string | string[], @Res() res: Response) {
    const grant = this.tokens.verify(token);
    const { draft } = await this.designs.get(grant.design, grant.store);
    const tree = await this.versions.tree(grant.store, grant.tree ?? draft.tree);
    const name = joined(file);
    const hash = tree[name];
    if (!hash || !(name.startsWith('public/') || name.startsWith('app/'))) throw new NotFoundException();
    res.setHeader('content-type', typeOf(name)).setHeader('cache-control', 'private, max-age=60').end(await this.versions.blob(grant.store, hash));
  }

  @Sse('events')
  events(@Param('token') token: string): Observable<MessageEvent> {
    const grant = this.tokens.verify(token);
    return defer(() => from(this.channel.join(grant.design, grant.agent))).pipe(
      switchMap(member => {
        const beats = interval(15_000).pipe(
          tap(() => void member.heartbeat()),
          ignoreElements(),
        );
        const events = from(this.live.stream([this.channel.scope(grant.design)]) as unknown as Observable<MessageEvent>);
        return merge(events, beats).pipe(finalize(() => void member.leave()));
      }),
    );
  }

  @Post('ack')
  async ack(@Param('token') token: string, @Body() body: unknown) {
    const grant = this.tokens.verify(token);
    const ack = parse(ackSchema, body);
    await this.channel.acknowledge(grant.design, { ...ack, subscriber: grant.agent ? 'agent' : 'view', agent: grant.agent });
    return { ok: true };
  }
}
