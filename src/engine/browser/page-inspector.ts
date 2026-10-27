import { Injectable } from '@nestjs/common';
import type { Locator, Page } from 'playwright-core';
import { auditPage, auditableUrl, type AuditDevice, type DeviceAudit, linkTargets, loadForAudit, type PageAudit, prepare, shownPath } from './page-audit';
import { BrowserSessions } from './browser-sessions.service';

export interface Shot {
  label: string;
  jpeg: Buffer;
}

const THROTTLE = process.env.REVIEW_THROTTLE ? process.env.REVIEW_THROTTLE === 'true' : process.env.NODE_ENV === 'production';
const DEVICE_FOR: Record<AuditDevice, 'phone' | 'desktop'> = { mobile: 'phone', desktop: 'desktop' };

@Injectable()
export class PageInspector {
  constructor(private readonly browsers: BrowserSessions) {}

  async screenshot(page: Page, target: Locator | null, full = false): Promise<Buffer> {
    if (target) return target.screenshot({ type: 'jpeg', quality: 70, timeout: 5000 });
    if (!full) return page.screenshot({ type: 'jpeg', quality: 70 });
    const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), 6000);
    const width = await page.evaluate(() => innerWidth);
    return page.screenshot({ type: 'jpeg', quality: 65, fullPage: true, clip: { x: 0, y: 0, width, height } });
  }

  async stableScreenshot(page: Page, full = false, withinMs = 3000): Promise<{ jpeg: Buffer; stable: boolean }> {
    const started = Date.now();
    let previous = await this.screenshot(page, null, full);
    while (Date.now() - started < withinMs) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const next = await this.screenshot(page, null, full);
      if (next.equals(previous)) return { jpeg: next, stable: true };
      previous = next;
    }
    return { jpeg: previous, stable: false };
  }

  async inspect(locator: Locator): Promise<Record<string, unknown>> {
    return locator.evaluate(element => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const paint = canvas.getContext('2d', { willReadFrequently: true })!;
      const parse = (value: string) => {
        if (!value || value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        paint.clearRect(0, 0, 1, 1);
        paint.fillStyle = '#000';
        paint.fillStyle = value;
        paint.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a: a / 255 };
      };
      let background = parse(style.backgroundColor);
      for (let node: Element | null = element; node && (!background || background.a === 0); node = node.parentElement) background = parse(getComputedStyle(node).backgroundColor);
      const color = parse(style.color);
      const channel = (value: number) => {
        const c = value / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (c: { r: number; g: number; b: number }) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
      const bg = background && background.a > 0 ? background : { r: 255, g: 255, b: 255, a: 1 };
      const ratio = color ? (Math.max(luminance(color), luminance(bg)) + 0.05) / (Math.min(luminance(color), luminance(bg)) + 0.05) : null;
      const size = parseFloat(style.fontSize);
      const bold = Number(style.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      return {
        tag: element.tagName.toLowerCase(),
        source: element.closest<HTMLElement>('[data-studio-source]')?.dataset.studioSource ?? null,
        box: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        text: (element.textContent ?? '').trim().slice(0, 120),
        font: `${style.fontWeight} ${style.fontSize}/${style.lineHeight} ${style.fontFamily.split(',')[0]}`,
        color: style.color,
        background: background && background.a > 0 ? `rgb(${bg.r}, ${bg.g}, ${bg.b})` : 'transparent (white page)',
        contrast: ratio ? `${ratio.toFixed(2)}:1 (${ratio >= (large ? 3 : 4.5) ? 'passes' : 'fails'} WCAG AA for ${large ? 'large' : 'normal'} text)` : null,
        spacing: { margin: style.margin, padding: style.padding, gap: style.gap === 'normal' ? null : style.gap },
        layout: { display: style.display, position: style.position, ...(style.display.includes('flex') ? { flex: `${style.flexDirection} ${style.justifyContent} ${style.alignItems}` } : {}), ...(style.display.includes('grid') ? { grid: style.gridTemplateColumns } : {}) },
        radius: style.borderRadius,
        classes: element.getAttribute('class')?.slice(0, 300) ?? null,
      };
    });
  }

  async audit(input: string, devices: AuditDevice[], store: string, draftId: string | null): Promise<PageAudit> {
    const url = auditableUrl(input);
    const results: DeviceAudit[] = [];
    let hrefs: string[] = [];
    for (const device of devices) {
      const { audit, links } = await this.browsers.withFreshContext(store, draftId, DEVICE_FOR[device], async context => auditPage(await prepare(context, device, THROTTLE), url, device));
      results.push(audit);
      if (!hrefs.length) hrefs = links;
    }
    const broken: PageAudit['links']['broken'] = [];
    const targets = linkTargets(url, hrefs);
    if (targets.length) {
      await this.browsers.withFreshContext(store, draftId, 'desktop', async context => {
        const page = await context.newPage();
        for (const target of targets) {
          const status = await loadForAudit(page, new URL(target)).then(
            loaded => loaded.status,
            () => null,
          );
          const problem = status == null ? "didn't load" : status >= 400 ? `answered ${status}` : (await page.locator('[data-not-found]').count()) > 0 ? 'shows a not-found page' : null;
          if (problem) broken.push({ href: shownPath(target), reason: problem });
        }
      });
    }
    return {
      url: url.origin === new URL(input).origin && /^\/d\//.test(url.pathname) ? `${url.origin}${shownPath(url.toString())} (preview)` : url.toString(),
      conditions: THROTTLE ? 'Lab: phone with 4x slower CPU and a slow 4G connection (150 ms, 1.6 Mbps); desktop unthrottled' : 'Lab, unthrottled (local development): the timings are indicative only',
      devices: results,
      links: { checked: targets.length, broken },
    };
  }

  async capture(input: string, devices: AuditDevice[], store: string, draftId: string | null): Promise<Array<{ device: AuditDevice; jpeg: Buffer; height: number }>> {
    const url = auditableUrl(input);
    const shots = [];
    for (const device of devices) {
      shots.push(
        await this.browsers.withFreshContext(store, draftId, DEVICE_FOR[device], async context => {
          const page = await prepare(context, device, THROTTLE);
          await loadForAudit(page, url);
          const width = await page.evaluate(() => innerWidth);
          const height = Math.min(await page.evaluate(() => document.documentElement.scrollHeight), device === 'mobile' ? 2600 : 2400);
          const jpeg = await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', clip: { x: 0, y: 0, width, height } });
          return { device, jpeg, height };
        }),
      );
    }
    return shots;
  }
}
