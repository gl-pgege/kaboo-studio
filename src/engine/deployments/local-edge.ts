import { Controller, Get, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { config } from '../config';
import { DeployStorage } from '../storage/storage';
import { deploymentFile, loadRouter, type Router } from './edge';
import { RoutingStore } from './routing-store';

const platformPaths = () => new RegExp(config.localEdgePlatformPaths);

@Controller('d')
export class DeploymentFilesController {
  constructor(private readonly files: DeployStorage) {}

  @Get('*path')
  async serve(@Req() req: Request, @Res() res: Response) {
    const file = await deploymentFile(this.files, req.path);
    if (!file) throw new NotFoundException();
    res.setHeader('content-type', file.type).setHeader('cache-control', file.cache).end(file.body);
  }
}

@Injectable()
export class LocalEdge implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LocalEdge.name);
  private server?: Server;
  private router?: Router;

  constructor(
    private readonly routes: RoutingStore,
    private readonly files: DeployStorage,
  ) {}

  onApplicationBootstrap() {
    if (!config.localEdgePort || config.role === 'worker') return;
    this.router = loadRouter(this.routes);
    this.server = createServer((req, res) =>
      void this.handle(req, res).catch(error => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`The local edge failed: ${String(error)}`);
      }),
    );
    this.server.on('error', error => this.logger.warn(`The local edge couldn't listen on ${config.localEdgePort}: ${error.message}`));
    this.server.listen(config.localEdgePort, config.host, () => this.logger.log(`Local edge for live sites on http://<store>.localhost:${config.localEdgePort}`));
  }

  onModuleDestroy() {
    this.server?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://edge');
    const host = req.headers.host ?? '';
    if (platformPaths().test(url.pathname)) return this.proxy(req, res, host);
    const headers = { host: { value: host }, ...(req.headers.referer ? { referer: { value: req.headers.referer } } : {}) };
    const result = await this.router!({ request: { uri: url.pathname, headers } });
    if ('statusCode' in result) {
      res.writeHead(result.statusCode, { 'content-type': 'text/plain' }).end(result.statusDescription ?? '');
      return;
    }
    if (!result.uri.startsWith('/d/')) return this.proxy(req, res, host);
    const file = await deploymentFile(this.files, result.uri);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
      return;
    }
    res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-cache', [`x-${config.brandId}-file`]: result.uri }).end(req.method === 'HEAD' ? undefined : file.body);
  }

  private proxy(req: IncomingMessage, res: ServerResponse, host: string) {
    const upstream = new URL(config.localEdgeUpstream);
    const forward = request(
      { hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: `${host.split(':')[0]}:${upstream.port}` } },
      response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    forward.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`The web app at ${config.localEdgeUpstream} didn't answer: ${error.message}`);
    });
    req.pipe(forward);
  }
}
