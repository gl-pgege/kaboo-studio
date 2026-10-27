import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { BrowserSession, Design, Draft } from '../../generated/prisma/client';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { config } from '../config';
import { PreviewTokens } from '../preview/preview-tokens';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAdmission } from '../scaling/admission';
import { metrics } from '../scaling/metrics';
import { BrowserProvider } from './providers';

export type Device = 'phone' | 'desktop';

export const DEVICES: Record<Device, { width: number; height: number; deviceScaleFactor: number; mobile: boolean; userAgent: string | null }> = {
  phone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
  desktop: { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36' },
};

export interface AgentPage {
  page: Page;
  basename: string;
  device: Device;
  session: BrowserSession;
}

const CONSENT_KEY = `${config.brandId}:analytics-consent`;

@Injectable()
export class BrowserSessions implements OnModuleInit {
  private readonly logger = new Logger(BrowserSessions.name);
  private readonly starting = new Map<string, Promise<BrowserSession>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: BrowserProvider,
    private readonly tokens: PreviewTokens,
    private readonly admission: SessionAdmission,
  ) {}

  private readonly queues = new Map<string, Promise<unknown>>();

  async onModuleInit() {
    const timer = setInterval(() => void this.stopIdle().catch(error => this.logger.warn(`Stopping idle browsers failed: ${String(error)}`)), 60_000);
    timer.unref();
    if (this.provider.name === 'local') {
      const orphans = await this.prisma.browserSession.findMany({ where: { status: 'ready', provider: 'local' } });
      await Promise.all(orphans.map(session => this.stop(session)));
    }
  }

  withAgentPage<T>(design: Design, draft: Draft, options: { device?: Device; newVisitor?: boolean }, work: (agent: AgentPage) => Promise<T>): Promise<T> {
    const previous = this.queues.get(draft.id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => this.agentPage(design, draft, options, work));
    this.queues.set(draft.id, next);
    const forget = () => {
      if (this.queues.get(draft.id) === next) this.queues.delete(draft.id);
    };
    next.then(forget, forget);
    return next;
  }

  private async agentPage<T>(design: Design, draft: Draft, options: { device?: Device; newVisitor?: boolean }, work: (agent: AgentPage) => Promise<T>): Promise<T> {
    const session = await this.ensure(draft.id, design.store);
    const browser = await this.provider.connect(session.externalId, session.endpoint);
    try {
      const device = options.device ?? (session.device as Device);
      const page = await this.agentTab(browser, design, device, options.newVisitor ?? false);
      if (device !== session.device) await this.prisma.browserSession.update({ where: { id: session.id }, data: { device } });
      await this.prisma.browserSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } });
      return await work({ page, basename: this.basename(page), device, session });
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  async withFreshContext<T>(store: string, draftId: string | null, device: Device, work: (context: BrowserContext, browser: Browser) => Promise<T>): Promise<T> {
    const session = draftId ? await this.ensure(draftId, store) : await this.ensure(null, store, 'review');
    const browser = await this.provider.connect(session.externalId, session.endpoint);
    const spec = DEVICES[device];
    const context = await browser.newContext({
      viewport: { width: spec.width, height: spec.height },
      deviceScaleFactor: spec.deviceScaleFactor,
      isMobile: spec.mobile,
      hasTouch: spec.mobile,
      ...(spec.userAgent ? { userAgent: spec.userAgent } : {}),
      locale: 'en-US',
      colorScheme: 'light',
      serviceWorkers: 'block',
    });
    try {
      return await work(context, browser);
    } finally {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      await this.prisma.browserSession.update({ where: { id: session.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
  }

  async emulate(page: Page, device: Device): Promise<void> {
    const spec = DEVICES[device];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: spec.width, height: spec.height, deviceScaleFactor: spec.deviceScaleFactor, mobile: spec.mobile });
    await cdp.send('Emulation.setTouchEmulationEnabled', spec.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    if (spec.userAgent) await cdp.send('Emulation.setUserAgentOverride', { userAgent: spec.userAgent });
    await cdp.detach().catch(() => undefined);
  }

  async stopForDraft(draftId: string): Promise<void> {
    const sessions = await this.prisma.browserSession.findMany({ where: { draftId, status: 'ready' } });
    await Promise.all(sessions.map(session => this.stop(session)));
  }

  private async agentTab(browser: Browser, design: Design, device: Device, newVisitor: boolean): Promise<Page> {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const prefix = `${config.previewOrigin}/d/${design.id}/`;
    let page = context.pages().find(candidate => candidate.url().startsWith(prefix));
    if (page && !newVisitor) {
      await page.bringToFront();
      await this.emulate(page, device);
      return page;
    }
    if (!page) {
      page = await context.newPage();
      await page.goto('about:blank');
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    await page.bringToFront();
    await this.emulate(page, device);
    const { token } = this.tokens.sign({ design: design.id, store: design.store, tree: null, agent: true }, 8 * 3600);
    await page.addInitScript(
      ([key, fresh]) => {
        try {
          if (fresh) localStorage.removeItem(key);
          else if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ choice: 'declined', at: Date.now() }));
        } catch {}
      },
      [CONSENT_KEY, newVisitor] as const,
    );
    await page.goto(this.tokens.url(design.id, token, '/'), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#studio-root')?.childElementCount, null, { timeout: 30_000, polling: 100 }).catch(() => undefined);
    return page;
  }

  private basename(page: Page): string {
    return new URL(page.url()).pathname.match(/^\/d\/[^/]+\/[^/]+/)?.[0] ?? '';
  }

  private ensure(draftId: string | null, store: string, purpose = 'agent'): Promise<BrowserSession> {
    const key = draftId ?? `review:${store}`;
    let pending = this.starting.get(key);
    if (!pending) {
      pending = this.resolve(draftId, store, purpose).finally(() => this.starting.delete(key));
      this.starting.set(key, pending);
    }
    return pending;
  }

  private async resolve(draftId: string | null, store: string, purpose: string): Promise<BrowserSession> {
    const existing = await this.prisma.browserSession.findFirst({ where: { draftId, store, purpose, status: 'ready', provider: this.provider.name }, orderBy: { startedAt: 'desc' } });
    if (existing && (await this.provider.alive(existing.externalId, existing.endpoint))) return existing;
    if (existing) await this.markStopped(existing.id);
    await this.admission.admit('browser', null);
    const started = Date.now();
    const browser = await this.provider.start(`studio-${store}`);
    metrics.stage('browser-start', Date.now() - started);
    const session = await this.prisma.browserSession.create({ data: { draftId, store, purpose, provider: this.provider.name, externalId: browser.id, endpoint: browser.endpoint } });
    this.logger.log(`Started a ${this.provider.name} browser for ${purpose} in ${store} in ${Date.now() - started} ms`);
    return session;
  }

  private async stopIdle(): Promise<void> {
    const idle = await this.prisma.browserSession.findMany({ where: { status: 'ready', lastUsedAt: { lt: new Date(Date.now() - config.sessionIdleMs) } } });
    await Promise.all(idle.map(session => this.stop(session)));
  }

  async discard(draftId: string): Promise<void> {
    const sessions = await this.prisma.browserSession.findMany({ where: { draftId, status: 'ready' } });
    await Promise.all(sessions.map(session => this.stop(session)));
  }

  private async stop(session: BrowserSession): Promise<void> {
    if (session.provider === this.provider.name) await this.provider.stop(session.externalId, session.endpoint);
    await this.markStopped(session.id);
  }

  private async markStopped(id: string): Promise<void> {
    await this.prisma.browserSession.update({ where: { id }, data: { status: 'stopped', stoppedAt: new Date() } });
  }
}
