import { BadRequestException, Injectable } from '@nestjs/common';
import { DesignService } from '../designs/design.service';
import { imageOf, type StudioImage } from '../graph/images';
import { PreviewTokens } from '../preview/preview-tokens';
import { withoutTokens } from '../terminal/output';
import { VersionStore } from '../versions/version-store.service';
import { BrowserSessions } from './browser-sessions.service';
import { type AuditDevice, loadForAudit, type PageAudit, prepare } from './page-audit';
import { PageInspector } from './page-inspector';
import { captureOutline, formatOutline } from './page-outline';

export type PreviewDevice = 'phone' | 'desktop';

const AUDIT_DEVICE: Record<PreviewDevice, AuditDevice> = { phone: 'mobile', desktop: 'desktop' };
const MAX_OUTLINE_LINES = 400;

@Injectable()
export class PreviewViews {
  constructor(
    private readonly designs: DesignService,
    private readonly versions: VersionStore,
    private readonly tokens: PreviewTokens,
    private readonly browsers: BrowserSessions,
    private readonly inspector: PageInspector,
  ) {}

  async shot(store: string, design: string, version: number | null, path: string | null, device: PreviewDevice, fullPage: boolean): Promise<StudioImage> {
    const { url } = await this.link(store, design, version, path);
    const { jpeg, notes } = await this.browsers.withFreshContext(store, null, device, async context => {
      const page = await prepare(context, AUDIT_DEVICE[device], false);
      const { unsettled } = await loadForAudit(page, new URL(url));
      const { jpeg, stable } = await this.inspector.stableScreenshot(page, fullPage);
      return { jpeg, notes: [...unsettled, ...(stable ? [] : ['The page kept changing, so the picture may catch it mid-change.'])] };
    });
    return imageOf(jpeg, notes.map(withoutTokens));
  }

  async outline(store: string, design: string, version: number | null, path: string | null, device: PreviewDevice): Promise<string> {
    const { url, basename } = await this.link(store, design, version, path);
    const { outline, unsettled } = await this.browsers.withFreshContext(store, null, device, async context => {
      const page = await prepare(context, AUDIT_DEVICE[device], false);
      const { unsettled } = await loadForAudit(page, new URL(url));
      return { outline: await captureOutline(page, basename), unsettled };
    });
    const lines = [...unsettled.map(withoutTokens), ...formatOutline(outline, device).split('\n')];
    return lines.length > MAX_OUTLINE_LINES ? `${lines.slice(0, MAX_OUTLINE_LINES).join('\n')}\n… ${lines.length - MAX_OUTLINE_LINES} more lines` : lines.join('\n');
  }

  async audit(store: string, design: string, version: number | null, path: string | null, devices: PreviewDevice[]): Promise<PageAudit> {
    const { url } = await this.link(store, design, version, path);
    return this.inspector.audit(url, devices.map(device => AUDIT_DEVICE[device]), store, null);
  }

  async health(store: string, design: string): Promise<{ errors: string[]; faults: string[] }> {
    const { url } = await this.link(store, design, null, '/');
    return this.browsers.withFreshContext(store, null, 'phone', async context => {
      const page = await prepare(context, AUDIT_DEVICE.phone, false);
      const thrown = new Set<string>();
      page.on('pageerror', error => thrown.add(error.message.slice(0, 500)));
      const { unsettled } = await loadForAudit(page, new URL(url));
      const log = await page.evaluate(() => {
        const studio = (window as unknown as { __studio?: { last?: { errors: string[]; faults: string[] } | null; take?: () => { errors: string[]; failed: string[]; thrown?: string[] } } }).__studio;
        return { last: studio?.last ?? null, later: studio?.take?.() ?? { errors: [], failed: [], thrown: [] } };
      });
      const errors = [...new Set([...(log.last?.errors ?? []), ...(log.later.thrown ?? []), ...thrown].map(withoutTokens))];
      const logged = log.later.errors.filter(message => !errors.some(error => error.includes(message) || message.includes(error)));
      const faults = [...new Set([...unsettled, ...(log.last?.faults ?? []), ...log.later.failed, ...logged.map(message => `Console error: ${message}`)].map(withoutTokens))];
      return { errors: errors.slice(0, 10), faults: faults.slice(0, 12) };
    });
  }

  private async link(store: string, design: string, version: number | null, path: string | null): Promise<{ url: string; basename: string }> {
    await this.designs.get(design, store);
    if (path && !path.startsWith('/')) throw new BadRequestException('A preview path starts with /');
    const row = version ? await this.versions.version(design, version) : null;
    if (version && !row) throw new BadRequestException(`There is no version ${version} of this design.`);
    const { token } = this.tokens.sign({ design, store, tree: row?.tree ?? null, agent: true }, 600);
    return { url: this.tokens.url(design, token, path ?? '/'), basename: new URL(this.tokens.url(design, token, '/')).pathname.replace(/\/$/, '') };
  }
}
