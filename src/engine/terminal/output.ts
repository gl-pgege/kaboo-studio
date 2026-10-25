import type { ChangeResult, Diagnostic } from '../../contract';

const PREVIEW_TOKEN = /\/(d|_studio\/(?:preview|check))\/([^/\s"']+\/)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g;

export function withoutTokens(value: string): string {
  return value.replace(PREVIEW_TOKEN, (_match, kind: string, design?: string) => (kind === 'd' ? `/d/${design ?? ''}<preview>` : `/${kind}/<preview>`));
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ERROR_LINE = /\b(error|Error|ERR!|failed|Failed|FAIL|✘|×|warning|Warning|Cannot|Unexpected)\b/;

export function trimOutput(output: string, { head = 60, tail = 60, maxErrors = 50, maxChars = 14_000 } = {}): string {
  const clean = output.replace(ANSI, '').replace(/\r/g, '');
  const lines = clean.replace(/\n+$/, '').split('\n');
  let text = clean.replace(/\n+$/, '');
  if (lines.length > head + tail) {
    const middle = lines.slice(head, lines.length - tail);
    const errors = middle.filter(line => ERROR_LINE.test(line)).slice(0, maxErrors);
    const omitted = middle.length - errors.length;
    text = [...lines.slice(0, head), `… ${omitted} lines left out${errors.length ? `, keeping ${errors.length} that mention errors:` : ''}`, ...errors, ...lines.slice(-tail)].join('\n');
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars / 2)}\n… ${text.length - maxChars} characters left out …\n${text.slice(-maxChars / 2)}`;
  return text;
}

const short = (tree: string | null | undefined) => (tree ? tree.slice(0, 8) : 'none');

function list(title: string, items: Diagnostic[], limit = 20): string[] {
  if (!items.length) return [`${title}: no errors`];
  const lines = items.slice(0, limit).map(item => `  ${item.file}${item.line ? `:${item.line}${item.column ? `:${item.column}` : ''}` : ''} ${item.rule ? `${item.rule} ` : ''}${item.message}`);
  return [`${title}: ${items.length} error${items.length === 1 ? '' : 's'}`, ...lines, ...(items.length > limit ? [`  … and ${items.length - limit} more`] : [])];
}

function preview(result: ChangeResult): string {
  const faults = result.preview?.faults ?? [];
  const status = previewStatus(result);
  return faults.length ? [status, `Faults: ${faults.length}`, ...faults.slice(0, 12).map(fault => `  ${fault}`)].join('\n') : status;
}

function previewStatus(result: ChangeResult): string {
  const view = result.preview;
  if (!view) return 'Preview: nothing to update';
  if (view.status === 'no-preview') return 'Preview: none is open, so nothing was rendered';
  if (view.status === 'timeout') return "Preview: didn't confirm within 5 s, which usually means an infinite loop or a crash";
  if (view.status === 'compile-errors') return 'Preview: kept the last good render because of the compile errors below';
  const where = `${short(view.tree)} on ${view.route ?? '/'} in ${view.ms ?? '?'} ms`;
  if (view.status === 'errors') return [`Preview: rendered ${where}, with runtime errors (the last good render stays on screen):`, ...view.errors.slice(0, 10).map(error => `  ${error}`)].join('\n');
  return `Preview: rendered ${where}, no errors`;
}

export function formatResult(result: ChangeResult): string {
  const lines: string[] = [];
  if (result.command) {
    lines.push(result.command.output.trim() ? trimOutput(result.command.output) : '(no output)');
    lines.push(`— exit ${result.command.exitCode} in ${(result.command.durationMs / 1000).toFixed(1)} s`);
  }
  const touched = [...result.changed, ...result.deleted.map(file => `${file} (deleted)`)];
  if (!touched.length) {
    lines.push('No files changed.');
  } else {
    lines.push(`Changed: ${touched.slice(0, 15).join(', ')}${touched.length > 15 ? ` and ${touched.length - 15} more` : ''}`);
    lines.push(`Draft: ${short(result.draft)} (was ${short(result.previousDraft)})`);
    lines.push(preview(result));
  }
  for (const refused of result.refused) lines.push(`Refused: ${refused.path} — ${refused.reason}`);
  if (result.compileErrors.length) lines.push(...list('Compile', result.compileErrors));
  if (touched.length) {
    lines.push(...list('Types', result.types));
    lines.push(...list('Lint (changed files)', result.lint));
  }
  return lines.join('\n');
}

export function summarize(command: string, result: ChangeResult | null): string {
  const name = (file: string) => file.split('/').pop() ?? file;
  if (result && (result.changed.length || result.deleted.length)) {
    if (result.changed.length === 1 && !result.deleted.length) return `Edited ${name(result.changed[0])}`;
    if (!result.changed.length && result.deleted.length === 1) return `Deleted ${name(result.deleted[0])}`;
    return `Edited ${result.changed.length + result.deleted.length} files`;
  }
  const first = command.trim().split(/\s+/);
  if (first[0] === 'studio') return `Studio: ${first[1] ?? 'help'}`;
  if (['cat', 'rg', 'grep', 'ls', 'head', 'tail', 'find', 'tree', 'wc', 'git'].includes(first[0])) return 'Looked at the code';
  return `Ran ${first[0]}`;
}

export function splitArgs(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === '\\' && quote === '"' && index + 1 < line.length) current += line[++index];
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) args.push(current);
      current = '';
      started = false;
    } else if (char === '\\' && index + 1 < line.length) {
      current += line[++index];
      started = true;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error('A quote was left open');
  if (started || current) args.push(current);
  return args;
}
