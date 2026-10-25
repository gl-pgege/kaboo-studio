import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintErrors, typeErrors } from '../toolchain/sync.mjs';
import { formatResult, splitArgs, summarize, trimOutput } from '../dist/engine/terminal/output.js';
import { splitStudioLine } from '../dist/engine/terminal/split.js';

test('shell lines that also run studio commands are split into their parts, in order', () => {
  assert.deepEqual(splitStudioLine('cat STOREFRONT.md DESIGN.md; studio status'), [
    { kind: 'shell', text: 'cat STOREFRONT.md DESIGN.md', then: ';' },
    { kind: 'studio', text: 'studio status', then: null },
  ]);
  assert.deepEqual(splitStudioLine('studio versions; studio diff --version 1'), [
    { kind: 'studio', text: 'studio versions', then: ';' },
    { kind: 'studio', text: 'studio diff --version 1', then: null },
  ]);
  assert.deepEqual(splitStudioLine("npm run build && sed -i 's/a;b/c/' x.ts && studio check"), [
    { kind: 'shell', text: "npm run build && sed -i 's/a;b/c/' x.ts", then: '&&' },
    { kind: 'studio', text: 'studio check', then: null },
  ]);
  assert.equal(splitStudioLine('cat app/root.tsx; ls'), null);
  assert.equal(splitStudioLine('studio status'), null);
  assert.equal(splitStudioLine("cat > DESIGN.md <<'EOF'\nstudio status; done\nEOF"), null);
  assert.equal(splitStudioLine('echo "studio; studio status"'), null);
  assert.equal(splitStudioLine('ls; studio diff | head -5'), null);
});

const empty = { changed: [], deleted: [], draft: null, previousDraft: 'aaaaaaaa11', refused: [], compileErrors: [], types: [], lint: [], preview: null, command: null };

test('long output keeps the head, the tail and every error line, without colour codes', () => {
  const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`);
  lines[250] = '\u001b[31merror\u001b[0m TS2322: nope';
  const out = trimOutput(lines.join('\n'), { head: 5, tail: 5 });
  assert.match(out, /^line 0\n/);
  assert.match(out, /line 499$/);
  assert.match(out, /… 489 lines left out, keeping 1 that mention errors:\nerror TS2322: nope/);
  assert.equal(trimOutput('short'), 'short');
});

test('a result names the files, the draft, the preview and the checks', () => {
  const text = formatResult({
    ...empty,
    changed: ['app/blocks/Hero.tsx'],
    draft: 'bbbbbbbb22',
    command: { output: 'ok\n', exitCode: 0, durationMs: 210 },
    preview: { status: 'rendered', tree: 'bbbbbbbb22', route: '/', ms: 96, errors: [] },
    types: [{ file: 'app/x.ts', line: 3, column: 7, rule: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }],
  });
  assert.equal(
    text,
    [
      'ok',
      '— exit 0 in 0.2 s',
      'Changed: app/blocks/Hero.tsx',
      'Draft: bbbbbbbb (was aaaaaaaa)',
      'Preview: rendered bbbbbbbb on / in 96 ms, no errors',
      'Types: 1 error',
      "  app/x.ts:3:7 TS2322 Type 'string' is not assignable to type 'number'.",
      'Lint (changed files): no errors',
    ].join('\n'),
  );
});

test('a preview that never answered, or kept the last good render, says so', () => {
  const changed = { ...empty, changed: ['app/a.tsx'], draft: 'c' };
  assert.match(formatResult({ ...changed, preview: { status: 'timeout', tree: null, route: null, ms: null, errors: [] } }), /didn't confirm within 5 s/);
  assert.match(formatResult({ ...changed, preview: { status: 'no-preview', tree: null, route: null, ms: null, errors: [] } }), /none is open/);
  assert.match(
    formatResult({ ...changed, preview: { status: 'errors', tree: 'c', route: '/cart', ms: 30, errors: ['TypeError: x is undefined'] } }),
    /with runtime errors \(the last good render stays on screen\):\n {2}TypeError: x is undefined/,
  );
  assert.match(formatResult({ ...empty, command: { output: '', exitCode: 1, durationMs: 5 } }), /\(no output\)\n— exit 1 in 0\.0 s\nNo files changed\./);
});

test('studio subcommands split like a shell, and steps get short labels', () => {
  assert.deepEqual(splitArgs(`save "Bigger hero, finally" --x 'a b' c\\ d`), ['save', 'Bigger hero, finally', '--x', 'a b', 'c d']);
  assert.deepEqual(splitArgs('bg ""'), ['bg', '']);
  assert.throws(() => splitArgs('save "open'), /quote/);
  assert.equal(summarize('sed -i x app/blocks/Hero.tsx', { ...empty, changed: ['app/blocks/Hero.tsx'] }), 'Edited Hero.tsx');
  assert.equal(summarize('rm a b', { ...empty, deleted: ['app/a.ts', 'app/b.ts'] }), 'Edited 2 files');
  assert.equal(summarize('rg Hero app', empty), 'Looked at the code');
  assert.equal(summarize('npm install zod', empty), 'Ran npm');
  assert.equal(summarize('studio diff', null), 'Studio: diff');
});

test('type and lint output is read into diagnostics with paths inside the design', () => {
  const watchCycle = "[10:01:02 AM] File change detected. Starting incremental compilation...\n\napp/lib/price.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\n\n";
  assert.deepEqual(typeErrors(watchCycle), [{ file: 'app/lib/price.ts', line: 1, column: 14, rule: 'TS2322', message: "Type 'string' is not assignable to type 'number'." }]);
  const lint = lintErrors([
    {
      filePath: `${process.cwd()}/app/blocks/Hero.tsx`,
      messages: [
        { ruleId: 'jsx-a11y/alt-text', severity: 2, message: 'img elements must have an alt prop', line: 4, column: 9 },
        { ruleId: 'x', severity: 1, message: 'warn', line: 1, column: 1 },
      ],
    },
  ]);
  assert.deepEqual(lint, [{ file: 'app/blocks/Hero.tsx', line: 4, column: 9, rule: 'jsx-a11y/alt-text', message: 'img elements must have an alt prop' }]);
});
