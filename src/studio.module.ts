import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { BrowserCommands } from './engine/browser/browser-commands';
import { BrowserSessions } from './engine/browser/browser-sessions.service';
import { CheckController } from './engine/browser/check.controller';
import { PageInspector } from './engine/browser/page-inspector';
import { PreviewViews } from './engine/browser/preview-views';
import { AgentCoreBrowserProvider, BrowserProvider, LocalChromiumProvider } from './engine/browser/providers';
import { VersionChecks } from './engine/checks/version-checks.service';
import { config } from './engine/config';
import { DeploymentService } from './engine/deployments/deployment.service';
import { DeploymentFilesController, LocalEdge } from './engine/deployments/local-edge';
import { RerenderService } from './engine/deployments/rerender.service';
import { RoutingService } from './engine/deployments/routing.service';
import { CloudFrontCache, EdgeCache, KeyValueStoreRouting, LocalRoutingStore, NoEdgeCache, RoutingStore } from './engine/deployments/routing-store';
import { DesignService } from './engine/designs/design.service';
import { DraftService } from './engine/drafts/draft.service';
import { RunService } from './engine/drafts/run.service';
import { WritersService } from './engine/drafts/writers.service';
import { EditorService } from './engine/editor/editor.service';
import { GraphController } from './engine/graph/graph.controller';
import { StudioGraph } from './engine/graph/graph.service';
import { PreviewChannel } from './engine/preview/preview-channel.service';
import { PreviewController } from './engine/preview/preview.controller';
import { PreviewService } from './engine/preview/preview.service';
import { PreviewTokens } from './engine/preview/preview-tokens';
import { VendorService } from './engine/preview/vendor.service';
import { PrismaService } from './engine/prisma/prisma.service';
import { StudioQueue } from './engine/queue/studio-queue';
import { SessionAdmission } from './engine/scaling/admission';
import { RateLimitedProvider, SandboxRateLimiter } from './engine/scaling/rate-limiter';
import { DeployStorage, LocalStorage, S3Storage, Storage } from './engine/storage/storage';
import { TemplateService } from './engine/templates/template.service';
import { StudioCommands } from './engine/terminal/studio-commands';
import { TerminalService } from './engine/terminal/terminal.service';
import { VersionStore } from './engine/versions/version-store.service';
import { CodeInterpreterProvider } from './engine/workspaces/code-interpreter.provider';
import { DockerProvider } from './engine/workspaces/docker.provider';
import { ToolchainService } from './engine/workspaces/toolchain.service';
import { WorkspaceProvider } from './engine/workspaces/workspace';
import { WorkspaceService } from './engine/workspaces/workspace.service';
import { LiveEventsModule } from './live-events';

export interface StudioModuleOptions {
  /** Providers for the host ports: `SiteDirectory`, `EventSink` and `CheckPack`. */
  host: Provider[];
  /** The service name live events are published under. */
  service?: string;
}

const SERVICES = [
  PrismaService,
  BrowserSessions,
  PageInspector,
  PreviewViews,
  BrowserCommands,
  VersionChecks,
  StudioCommands,
  TerminalService,
  StudioGraph,
  DeploymentService,
  RoutingService,
  RerenderService,
  LocalEdge,
  SandboxRateLimiter,
  SessionAdmission,
  StudioQueue,
  VersionStore,
  ToolchainService,
  WorkspaceService,
  WritersService,
  DesignService,
  PreviewTokens,
  PreviewChannel,
  VendorService,
  PreviewService,
  DraftService,
  RunService,
  EditorService,
  TemplateService,
];

@Module({})
export class StudioModule {
  static forRoot(options: StudioModuleOptions): DynamicModule {
    return {
      module: StudioModule,
      imports: [LiveEventsModule.forRoot({ service: options.service ?? 'studio', redis: config.redis })],
      controllers: [GraphController, PreviewController, CheckController, DeploymentFilesController],
      providers: [
        ...options.host,
        ...SERVICES,
        { provide: BrowserProvider, useFactory: () => (config.browsers === 'agentcore' ? new AgentCoreBrowserProvider() : new LocalChromiumProvider()) },
        { provide: Storage, useFactory: () => (config.storage === 's3' ? new S3Storage(config.bucket, config.region) : new LocalStorage(config.storageDir)) },
        { provide: DeployStorage, useFactory: () => (config.deployStorage === 's3' ? new S3Storage(config.deployBucket, config.region) : new LocalStorage(config.deployDir)) },
        { provide: RoutingStore, useFactory: () => (config.routingStoreArn ? new KeyValueStoreRouting(config.routingStoreArn) : new LocalRoutingStore(config.routingFile)) },
        { provide: EdgeCache, useFactory: () => (config.distributionId ? new CloudFrontCache(config.distributionId) : new NoEdgeCache()) },
        {
          provide: WorkspaceProvider,
          useFactory: (limiter: SandboxRateLimiter) => new RateLimitedProvider(config.workspaces === 'agentcore' ? new CodeInterpreterProvider() : new DockerProvider(), limiter),
          inject: [SandboxRateLimiter],
        },
      ],
      exports: [...SERVICES, LiveEventsModule],
    };
  }
}
