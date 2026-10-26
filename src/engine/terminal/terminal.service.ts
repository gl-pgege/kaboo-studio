import type { ChangeResult } from '../../contract';
import { Injectable, Logger } from '@nestjs/common';
import type { TerminalCaller } from '../ports';
import { BrowserSessions } from '../browser/browser-sessions.service';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { DraftService } from '../drafts/draft.service';
import { formatResult, splitArgs, summarize } from './output';
import { ownerOf } from './owner';
import { metrics } from '../scaling/metrics';
import { type LinePart, splitStudioLine } from './split';
import { StudioCommands, UsageError } from './studio-commands';

export interface TerminalAnswer {
  text: string;
  summary: string;
  result: ChangeResult | null;
  images: Buffer[];
}

const MAX_COMMAND_MS = 15 * 60_000;

@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);
  private readonly previews = new Set<string>();

  constructor(
    private readonly drafts: DraftService,
    private readonly studio: StudioCommands,
    private readonly designs: DesignService,
    private readonly browsers: BrowserSessions,
  ) {}

  async run(caller: TerminalCaller, command: string): Promise<TerminalAnswer> {
    const line = command.trim();
    const parts = splitStudioLine(line);
    return parts ? this.runParts(caller, parts) : this.runOne(caller, line);
  }

  private async runParts(caller: TerminalCaller, parts: LinePart[]): Promise<TerminalAnswer> {
    const texts: string[] = [];
    const images: Buffer[] = [];
    let result: ChangeResult | null = null;
    for (const part of parts) {
      let failed = false;
      let text: string;
      try {
        const answer = await this.runOne(caller, part.text);
        text = answer.text;
        images.push(...answer.images);
        if (answer.result) result = answer.result;
        failed = part.kind === 'shell' && (answer.result?.command?.exitCode ?? 0) !== 0;
      } catch (error) {
        if (!(error instanceof UsageError)) throw error;
        text = error.message;
        failed = true;
      }
      texts.push(`$ ${part.text.split('\n')[0].slice(0, 200)}\n${text}`);
      if (failed && part.then === '&&') {
        texts.push('(stopped here: the command before && failed)');
        break;
      }
    }
    return { text: texts.join('\n\n'), summary: summarize(parts.map(part => part.text).join('; '), result), result, images };
  }

  private async runOne(caller: TerminalCaller, line: string): Promise<TerminalAnswer> {
    if (/^studio(\s|$)/.test(line)) {
      const answer = await metrics.time('studio-command', () => this.studio.run(caller, splitArgs(line).slice(1)));
      return { images: [], ...answer, summary: summarize(line, answer.result) };
    }
    void this.openAgentPreview(caller);
    const outcome = await metrics.time('command', () =>
      this.drafts.change(caller.designId, caller.store, caller.actor, { kind: 'command', command: line, timeoutMs: MAX_COMMAND_MS }, { owner: ownerOf(caller), ownerTtlMs: 20 * 60_000, diagnose: config.diagnoseOnChange, releaseAfter: !caller.actor.runId }),
    );
    return { text: formatResult(outcome.result), summary: summarize(line, outcome.result), result: outcome.result, images: [] };
  }

  private async openAgentPreview(caller: TerminalCaller): Promise<void> {
    if (this.previews.has(caller.designId)) return;
    this.previews.add(caller.designId);
    try {
      const { design, draft } = await this.designs.get(caller.designId, caller.store);
      await this.browsers.openAgentPreview(design, draft);
    } catch (error) {
      this.previews.delete(caller.designId);
      this.logger.warn(`The agent's preview of ${caller.designId} didn't open: ${String(error)}`);
    }
  }
}
