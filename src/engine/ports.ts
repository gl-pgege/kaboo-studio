import type { Actor } from '../contract';
import type { Page } from 'playwright-core';

export interface TerminalCaller {
  store: string;
  designId: string;
  actor: Actor;
}

export interface Site {
  code: string;
  name: string;
  url: string;
}

export interface VersionActivity {
  store: string;
  design: { id: string; name: string };
  version: { number: number; message: string };
  actor: Actor;
}

export interface CheckOutcome {
  check: string;
  ok: boolean;
  detail?: string;
}

export abstract class SiteDirectory {
  abstract site(store: string, options?: { fresh?: boolean }): Promise<Site>;
  abstract buildEnv(store: string, design: string, deployment?: { id: string; siteUrl: string; paths: string[] | null }): Promise<Record<string, string>>;
  abstract previewConfig(store: string, design: string): Promise<Record<string, unknown>>;
}

export abstract class EventSink {
  abstract version(activity: VersionActivity): Promise<void>;
  abstract live(store: string, type: 'studio.draft' | 'studio.deployment' | 'studio.routing' | 'studio.version', data: Record<string, unknown>): Promise<void>;
}

export abstract class CheckPack {
  abstract run(page: Page, url: string): Promise<CheckOutcome[]>;
}
