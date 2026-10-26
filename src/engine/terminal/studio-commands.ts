import type { ChangeResult, DesignFlag } from '../../contract';
import { Injectable } from '@nestjs/common';
import { createTwoFilesPatch } from 'diff';
import { randomBytes } from 'node:crypto';
import type { TerminalCaller } from '../ports';
import { BrowserCommands } from '../browser/browser-commands';
import { BrowserSessions } from '../browser/browser-sessions.service';
import { VersionChecks } from '../checks/version-checks.service';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { DraftService } from '../drafts/draft.service';
import { isAssistantWriter } from '../drafts/writers.service';
import { EditorService } from '../editor/editor.service';
import { TemplateService } from '../templates/template.service';
import { diffTrees, isBinary } from '../versions/tree';
import { VersionStore } from '../versions/version-store.service';
import { shellQuote } from '../workspaces/workspace';
import { WorkspaceService } from '../workspaces/workspace.service';
import { trimOutput } from './output';
import { ownerOf } from './owner';

export interface CommandAnswer {
  text: string;
  result: ChangeResult | null;
  images?: Buffer[];
}

export class UsageError extends Error {}

const BROWSER = new Set(['screenshot', 'inspect', 'audit', 'compare', 'check', 'open', 'click', 'fill', 'select', 'press', 'hover', 'swipe', 'scroll', 'scroll-to', 'back', 'wait', 'eval', 'flow']);

const HELP = `Studio commands (they run in the studio, not the workspace):
  studio status                     the design, its versions, the kit and anything flagged for you
  studio diff [--version N] [path…] what changed since the latest version (or version N), from the studio's store
  studio save "message"             make a version of the draft now
  studio versions [--limit N]       the latest versions
  studio restore N                  make the draft version N again (as a new version)
  studio template-merge [--done]    stage the latest template next to your code for a three-way merge
  studio variation new|use|drop <name>, studio variation list
                                    scratch copies of the design to try directions side by side
  studio bg <command>               run a long command in the background; studio bg-status <id> to follow it
  studio screenshot, inspect, open, click, fill, select, press, hover, swipe, scroll, scroll-to, back, wait, eval, flow, audit, compare, check
                                    look at and use the preview like a shopper`;

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function flagSet(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

@Injectable()
export class StudioCommands {
  constructor(
    private readonly designs: DesignService,
    private readonly drafts: DraftService,
    private readonly editor: EditorService,
    private readonly versions: VersionStore,
    private readonly templates: TemplateService,
    private readonly workspaces: WorkspaceService,
    private readonly browser: BrowserCommands,
    private readonly checks: VersionChecks,
    private readonly browsers: BrowserSessions,
  ) {}

  async run(caller: TerminalCaller, args: string[]): Promise<CommandAnswer> {
    const [name = 'help', ...rest] = args;
    const answer = (text: string): CommandAnswer => ({ text, result: null });
    switch (name) {
      case 'help':
        return answer(HELP);
      case 'status':
        return answer(await this.status(caller));
      case 'diff':
        return answer(await this.diff(caller, rest));
      case 'save': {
        const version = await this.drafts.commit(caller.designId, caller.store, caller.actor, rest.join(' ').trim() || `Saved by ${caller.actor.name}`);
        return answer(version ? `Saved version ${version.number}: ${version.message}` : 'Nothing to save: the draft matches the latest version.');
      }
      case 'versions':
        return answer(await this.list(caller, Number(flagValue(rest, '--limit') ?? 10)));
      case 'restore': {
        const number = Number(rest[0]);
        if (!Number.isInteger(number) || number < 1) throw new UsageError('Say which version: studio restore 12');
        const version = await this.editor.restore(caller.designId, caller.store, caller.actor, number);
        return answer(version ? `Restored version ${number} as version ${version.number}. The workspace's files now match it.` : `The draft already matches version ${number}.`);
      }
      case 'template-merge':
        return answer(flagSet(rest, '--done') ? await this.finishMerge(caller) : await this.stageMerge(caller));
      case 'bg':
        return answer(await this.background(caller, rest));
      case 'bg-status':
        return answer(await this.backgroundStatus(caller, rest[0]));
      case 'check':
        return answer(await this.checks.runForDraft(caller));
      case 'variation':
        return this.variation(caller, rest);
      default:
        if (BROWSER.has(name)) return this.browser.run(caller, name, rest, ownerOf(caller));
        throw new UsageError(`There is no studio ${name} command.\n\n${HELP}`);
    }
  }

  private async variation(caller: TerminalCaller, rest: string[]): Promise<CommandAnswer> {
    const [action, name] = rest;
    const { design } = await this.designs.get(caller.designId, caller.store);
    const main = design.parentId ?? design.id;
    if (action === 'list') {
      const variations = await this.designs.variations(caller.store, main);
      return { text: variations.length ? variations.map(entry => `${entry.name} · design ${entry.design.id} · draft ${entry.draft.tree.slice(0, 8)} · version ${entry.draft.headVersion ?? 1}`).join('\n') : 'No variations yet.', result: null };
    }
    if (!name) throw new UsageError('Name the variation: studio variation new bold-editorial');
    if (action === 'new') {
      const view = await this.designs.createVariation(caller.store, main, name, caller.actor);
      return { text: `Variation ${name} is ready as design ${view.id}: a copy of the draft with its own workspace, preview and versions. Build it with try_variation(design: "${view.id}"), then studio variation use ${name} if the person picks it.`, result: null };
    }
    if (action === 'use') {
      const variation = await this.designs.variation(caller.store, main, name);
      const { draft } = await this.designs.get(variation.id, caller.store);
      const outcome = await this.drafts.change(main, caller.store, caller.actor, { kind: 'tree', tree: draft.tree }, { owner: ownerOf(caller), ownerTtlMs: 20 * 60_000, diagnose: config.diagnoseOnChange });
      const version = await this.drafts.commit(main, caller.store, caller.actor, `Used the ${name} variation`);
      return { text: `The design now matches variation ${name}${version ? ` (version ${version.number})` : ''}.`, result: outcome.result };
    }
    if (action === 'drop') {
      const dropped = await this.designs.dropVariation(caller.store, main, name);
      if (dropped !== caller.designId) {
        const { draft } = await this.designs.get(dropped, caller.store);
        await Promise.all([this.workspaces.discard(draft.id), this.browsers.discard(draft.id)]).catch(() => undefined);
      }
      return { text: `Dropped variation ${name}.`, result: null };
    }
    throw new UsageError('Use studio variation new <name>, list, use <name> or drop <name>');
  }

  private async status(caller: TerminalCaller): Promise<string> {
    const view = await this.designs.view(caller.designId, caller.store);
    const holder = await this.drafts.heldBy(caller.designId, caller.store);
    const lines = [
      `Design "${view.name}" (id ${view.id}) in ${view.store} (${view.status})`,
      `Draft ${view.draftTree.slice(0, 8)}; latest version ${view.headVersion ?? 'none'}`,
      `Template ${view.templateVersion}, kit ${view.kitVersion}`,
      holder ? `Being written by ${isAssistantWriter(holder) ? 'an assistant' : 'someone in the Code tab'}` : 'Nobody is writing to it right now',
    ];
    for (const flag of view.flags as DesignFlag[]) lines.push(`Flagged (${flag.kind}): ${flag.message}`, ...flag.details.slice(0, 10).map(detail => `  ${detail}`));
    return lines.join('\n');
  }

  private async diff(caller: TerminalCaller, rest: string[]): Promise<string> {
    const { draft } = await this.designs.get(caller.designId, caller.store);
    const number = Number(flagValue(rest, '--version') ?? draft.headVersion ?? 0);
    const base = number ? await this.versions.version(caller.designId, number) : null;
    const from = base ? await this.versions.tree(caller.store, base.tree) : {};
    const to = await this.versions.tree(caller.store, draft.tree);
    const { changed, deleted } = diffTrees(from, to);
    const wanted = (file: string) => !rest.length || rest.some(path => file === path || file.startsWith(`${path.replace(/\/$/, '')}/`));
    const files = [...changed, ...deleted].filter(wanted).sort();
    if (!files.length) return base ? `No changes since version ${number}.` : 'No changes.';
    const patches: string[] = [];
    for (const file of files.slice(0, 25)) {
      const before = from[file] ? await this.versions.blob(caller.store, from[file]) : Buffer.alloc(0);
      const after = to[file] ? await this.versions.blob(caller.store, to[file]) : Buffer.alloc(0);
      if (isBinary(before) || isBinary(after)) patches.push(`Binary file ${file} ${to[file] ? 'changed' : 'deleted'}`);
      else patches.push(createTwoFilesPatch(`a/${file}`, `b/${file}`, before.toString('utf8'), after.toString('utf8'), '', '', { context: 3 }).replace(/^=+\n/, ''));
    }
    const header = `${files.length} file${files.length === 1 ? '' : 's'} changed since ${base ? `version ${number}` : 'the start'}${files.length > 25 ? ' (showing 25)' : ''}`;
    return trimOutput(`${header}\n${patches.join('\n')}`, { head: 400, tail: 100, maxChars: 30_000 });
  }

  private async list(caller: TerminalCaller, limit: number): Promise<string> {
    const versions = await this.versions.versions(caller.designId, { take: Math.min(Math.max(limit, 1), 50) });
    if (!versions.length) return 'No versions yet.';
    return versions
      .map(version => {
        const author = version.author.kind === 'assistant' && version.author.actingFor ? `${version.author.name} for ${version.author.actingFor}` : version.author.name;
        const checks = version.checks ? ` · checks ${version.checks.status}` : '';
        return `v${version.number} · ${version.createdAt.slice(0, 16).replace('T', ' ')} · ${author} · ${version.message}${checks}`;
      })
      .join('\n');
  }

  private async stageMerge(caller: TerminalCaller): Promise<string> {
    const staged = await this.templates.stageMerge(caller.designId, caller.store);
    if (staged.from === staged.to) return `This design is on the latest template (${staged.to}); there is nothing to merge.`;
    return [
      `Template ${staged.from} → ${staged.to}.`,
      `Changed in the template: ${staged.changed.join(', ') || 'nothing'}`,
      `New in the template: ${staged.added.join(', ') || 'nothing'}`,
      `Removed from the template: ${staged.removed.join(', ') || 'nothing'}`,
      `Merged copies (your edits plus the template's) are in ${staged.folder}/merged/; the base and latest template files are in ${staged.folder}/base/ and ${staged.folder}/latest/.`,
      staged.conflicts.length ? `Conflicts to resolve (marked <<<<<<< design … >>>>>>> template ${staged.to}): ${staged.conflicts.join(', ')}` : 'No conflicts.',
      'Copy what you want into place, check it, then run studio template-merge --done.',
    ].join('\n');
  }

  private async finishMerge(caller: TerminalCaller): Promise<string> {
    const view = await this.templates.finishMerge(caller.designId, caller.store);
    return `The design now records template ${view.templateVersion}.`;
  }

  private async background(caller: TerminalCaller, rest: string[]): Promise<string> {
    const command = rest.join(' ').trim();
    if (!command) throw new UsageError('Say what to run: studio bg "npm run build"');
    const { design, draft } = await this.designs.get(caller.designId, caller.store);
    const session = await this.workspaces.forDraft(design, draft);
    const id = randomBytes(3).toString('hex');
    await session.workspace.background(`set -a; [ -f .studio/state/env.sh ] && . .studio/state/env.sh; set +a; bash -lc ${shellQuote(command)} > .studio/state/bg-${id}.log 2>&1; echo $? > .studio/state/bg-${id}.exit`);
    await this.workspaces.touch(session);
    return `Started task ${id}. Follow it with studio bg-status ${id}. Files it changes are saved with your next command.`;
  }

  private async backgroundStatus(caller: TerminalCaller, id: string | undefined): Promise<string> {
    if (!id || !/^[0-9a-f]{6}$/.test(id)) throw new UsageError('Say which task: studio bg-status 3fa2c1');
    const { design, draft } = await this.designs.get(caller.designId, caller.store);
    const session = await this.workspaces.forDraft(design, draft);
    const output = await session.workspace.exec(`tail -c 6000 .studio/state/bg-${id}.log 2>/dev/null || echo "There is no task ${id}."; echo; echo "@@EXIT@@$(cat .studio/state/bg-${id}.exit 2>/dev/null)"`);
    const [log, exit] = output.stdout.split('@@EXIT@@');
    const code = exit?.trim();
    return `${trimOutput(log.trim() || '(no output yet)')}\n— ${code ? `finished with exit ${code}` : 'still running'}`;
  }
}
