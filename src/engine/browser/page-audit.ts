import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from 'playwright-core';
import { config } from '../config';
import { logLine } from '../logging';

export type AuditDevice = 'desktop' | 'mobile';

export class AuditInputError extends Error {}

export const BUDGETS = { lcpMs: 2500, cls: 0.1, tbtMs: 200 } as const;

export const VITALS = `(() => {
  const v = (window.__studioVitals = { lcp: 0, cls: 0, fcp: 0, longTasks: [] });
  let session = 0, first = 0, last = 0;
  const watch = (type, fn) => { try { new PerformanceObserver(list => list.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {} };
  watch('largest-contentful-paint', e => { v.lcp = Math.max(v.lcp, e.startTime); });
  watch('paint', e => { if (e.name === 'first-contentful-paint') v.fcp = e.startTime; });
  watch('longtask', e => { v.longTasks.push([e.startTime, e.duration]); });
  watch('layout-shift', e => {
    if (e.hadRecentInput) return;
    if (e.startTime - last > 1000 || e.startTime - first > 5000) { session = 0; first = e.startTime; }
    session += e.value; last = e.startTime; v.cls = Math.max(v.cls, session);
  });
})()`;

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export interface AccessibilityIssue {
  rule: string;
  impact: string | null;
  help: string;
  wcag: string[];
  count: number;
  examples: string[];
}

export interface DeviceAudit {
  device: AuditDevice;
  status: number | null;
  notFound: boolean;
  accessibility: AccessibilityIssue[];
  performance: { lcpMs: number; cls: number; tbtMs: number; loadMs: number; requests: number; transferKb: number; withinBudget: Record<keyof typeof BUDGETS, boolean> };
}

export interface PageAudit {
  url: string;
  conditions: string;
  devices: DeviceAudit[];
  links: { checked: number; broken: Array<{ href: string; reason: string }> };
}

const STORE_HOST_PART = '[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?';

function sitePattern(): { protocol: string; host: RegExp } {
  const template = new URL((process.env.STUDIO_SITE_URL_TEMPLATE ?? 'http://{code}.localhost:4200').replace('{code}', 'storecode'));
  const [before, after] = template.host.split('storecode');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { protocol: template.protocol, host: new RegExp(`^${escape(before)}${STORE_HOST_PART}${escape(after)}$`) };
}

export function auditableUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AuditInputError('Use a full address: the live site plus a path, or a studio preview link');
  }
  if (url.username || url.password) throw new AuditInputError('Addresses with credentials are refused');
  const preview = new URL(config.previewOrigin);
  if (url.origin === preview.origin && /^\/d\/[^/]+\/[^/]+\//.test(url.pathname)) {
    url.hash = '';
    return url;
  }
  const pattern = sitePattern();
  if (url.protocol !== pattern.protocol || !pattern.host.test(url.host)) throw new AuditInputError(`Only ${config.brandName} sites and studio previews can be reviewed`);
  url.hash = '';
  return url;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const READY_MS = 15_000;

export async function settle(page: Page): Promise<string[]> {
  const ready = () =>
    Boolean(document.querySelector('#studio-root')?.childElementCount) &&
    (window as unknown as { __studio?: { pending: number } }).__studio?.pending === 0 &&
    !document.querySelector('[aria-busy="true"]');
  const settled = await page
    .waitForFunction(ready, null, { timeout: READY_MS, polling: 100 })
    .then(() => sleep(100))
    .then(() => page.waitForFunction(ready, null, { timeout: READY_MS, polling: 100 }))
    .then(
      () => true,
      () => false,
    );
  if (settled) {
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
    return [];
  }
  const state = await page.evaluate(() => ({
    rendered: Boolean(document.querySelector('#studio-root')?.childElementCount),
    pending: (window as unknown as { __studio?: { pending: number } }).__studio?.pending ?? 0,
    busy: [...document.querySelectorAll('[aria-busy="true"]')]
      .map(element => (element.closest('[aria-label]')?.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 60))
      .filter(Boolean),
  }));
  const parts = [
    ...(state.rendered ? [] : ['nothing rendered']),
    ...(state.pending ? [`${state.pending} request${state.pending === 1 ? '' : 's'} still pending`] : []),
    ...(state.busy.length ? [`still loading: ${[...new Set(state.busy)].slice(0, 8).join(', ')}`] : []),
  ];
  return [`The page was not ready after ${READY_MS / 1000} s: ${parts.join('; ') || 'it kept changing'}.`];
}

export async function loadForAudit(page: Page, url: URL): Promise<{ status: number | null; unsettled: string[] }> {
  const response = await page.goto(url.toString(), { waitUntil: 'load', timeout: 45_000 });
  const status = response?.status() ?? null;
  if (/^\/d\//.test(url.pathname)) return { status, unsettled: await settle(page) };
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
  await sleep(1000);
  return { status, unsettled: [] };
}

export async function prepare(context: BrowserContext, device: AuditDevice, throttle: boolean): Promise<Page> {
  await context.addInitScript(VITALS);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (device === 'mobile' && throttle) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  return page;
}

export async function auditPage(page: Page, url: URL, device: AuditDevice): Promise<{ audit: DeviceAudit; links: string[] }> {
  const started = Date.now();
  const { status } = await loadForAudit(page, url);
  const loadMs = Date.now() - started;
  const vitals = await page.evaluate(() => {
    const v = (window as unknown as { __studioVitals?: { lcp: number; cls: number; fcp: number; longTasks: Array<[number, number]> } }).__studioVitals;
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    return {
      lcp: v?.lcp ?? 0,
      cls: v?.cls ?? 0,
      tbt: (v?.longTasks ?? []).filter(([start]) => start >= (v?.fcp ?? 0)).reduce((sum, [, duration]) => sum + Math.max(0, duration - 50), 0),
      requests: resources.length,
      transfer: resources.reduce((sum, resource) => sum + (resource.transferSize || 0), 0),
    };
  });
  const notFound = (await page.locator('[data-not-found]').count()) > 0;
  const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  const links = await page.$$eval('a[href]', anchors => anchors.map(anchor => anchor.getAttribute('href') ?? ''));
  const timings = { lcpMs: Math.round(vitals.lcp), cls: Math.round(vitals.cls * 1000) / 1000, tbtMs: Math.round(vitals.tbt), loadMs, requests: vitals.requests, transferKb: Math.round(vitals.transfer / 1024) };
  logLine('info', { context: 'audit', event: 'page.audited', message: `Audited ${shownPath(url.toString())} (${device})`, device, ...timings });
  return {
    audit: {
      device,
      status,
      notFound,
      accessibility: axe.violations.map(violation => ({
        rule: violation.id,
        impact: violation.impact ?? null,
        help: violation.help,
        wcag: violation.tags.filter(tag => /^wcag\d/.test(tag)),
        count: violation.nodes.length,
        examples: violation.nodes
          .slice(0, 3)
          .map(node => node.target.join(' '))
          .filter(Boolean),
      })),
      performance: { ...timings, withinBudget: { lcpMs: timings.lcpMs <= BUDGETS.lcpMs, cls: timings.cls <= BUDGETS.cls, tbtMs: timings.tbtMs <= BUDGETS.tbtMs } },
    },
    links,
  };
}

export function linkTargets(base: URL, hrefs: string[]): string[] {
  const preview = base.searchParams.get('preview');
  const prefix = base.pathname.match(/^\/d\/[^/]+\/[^/]+/)?.[0] ?? '';
  return [
    ...new Set(
      hrefs
        .filter(href => href.startsWith('/') && !href.startsWith('//'))
        .map(href => {
          const target = new URL(prefix && !href.startsWith(prefix) ? `${prefix}${href}` : href, base);
          if (preview && !target.searchParams.has('preview')) target.searchParams.set('preview', preview);
          return target.toString();
        })
        .filter(target => new URL(target).pathname !== base.pathname),
    ),
  ].slice(0, 15);
}

export function shownPath(target: string): string {
  const url = new URL(target);
  url.searchParams.delete('preview');
  return `${url.pathname.replace(/^\/d\/[^/]+\/[^/]+/, '')}${url.search}` || '/';
}
