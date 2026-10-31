#!/usr/bin/env node
import { isUtf8 } from 'node:buffer';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const SEARCH = '<<<<<<< SEARCH';
const DIVIDER = '=======';
const REPLACE = '>>>>>>> REPLACE';
const MAX_SHOWN = 12;
const USAGE = `Usage: edit <file> <<'EOF'
${SEARCH}
the text to replace, exactly as it is now
${DIVIDER}
what it becomes
${REPLACE}
EOF
Each search must match exactly once. Several blocks may follow one another: they all apply, or none does.`;

class EditError extends Error {}

const words = text => new Set(text.match(/[A-Za-z0-9_]+/g) ?? []);
const lineOf = (content, offset) => content.slice(0, offset).split('\n').length;
const lineCount = content => content.split('\n').length - (content.endsWith('\n') ? 1 : 0);

function numbered(lines, first, last) {
  const shown = [];
  for (let line = first; line <= last; line++) shown.push(`${String(line).padStart(4)}| ${lines[line - 1]}`);
  return shown.length > MAX_SHOWN ? [...shown.slice(0, 5), '    …', ...shown.slice(-5)] : shown;
}

function parseBlocks(input) {
  const lines = input.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const blocks = [];
  let state = 'outside';
  let search = [];
  let replace = [];
  lines.forEach((raw, index) => {
    const marker = raw.replace(/\s+$/, '');
    if (state === 'outside') {
      if (marker === SEARCH) {
        state = 'search';
        search = [];
      } else if (marker !== '') {
        throw new EditError(`line ${index + 1} of the input is outside a block: start each block with ${SEARCH}.`);
      }
    } else if (state === 'search') {
      if (marker === DIVIDER) {
        state = 'replace';
        replace = [];
      } else if (marker === SEARCH || marker === REPLACE) {
        throw new EditError(`block ${blocks.length + 1} needs a ${DIVIDER} line between the text to find and what it becomes.`);
      } else {
        search.push(raw);
      }
    } else if (marker === REPLACE) {
      blocks.push([search, replace]);
      state = 'outside';
    } else if (marker === SEARCH || marker === DIVIDER) {
      throw new EditError(`block ${blocks.length + 1} needs a ${REPLACE} line to close it.`);
    } else {
      replace.push(raw);
    }
  });
  if (state !== 'outside') throw new EditError(`block ${blocks.length + 1} needs a ${REPLACE} line to close it.`);
  if (!blocks.length) throw new EditError(`no blocks to apply.\n${USAGE}`);
  blocks.forEach(([search], index) => {
    if (!search.some(line => line.trim())) throw new EditError(`block ${index + 1} has nothing to find: put the current text between ${SEARCH} and ${DIVIDER}.`);
  });
  return blocks.map(([search, replace]) => [search.join('\n'), replace.join('\n')]);
}

function occurrences(content, search) {
  const found = [];
  for (let at = content.indexOf(search); at >= 0; at = content.indexOf(search, at + 1)) found.push(at);
  return found;
}

function missed(content, search, block, blocks, name) {
  const head = `block ${block} of ${blocks} matches nothing in ${name}, so nothing was changed.`;
  const lines = content.split('\n');
  const count = lineCount(content);
  const target = search.split('\n').find(line => line.trim()).trim();
  const wanted = words(target);
  let best = 0;
  let bestScore = 0;
  for (let index = 0; index < count; index++) {
    const text = lines[index].trim();
    if (text === target) {
      best = index + 1;
      break;
    }
    const score = [...words(text)].filter(word => wanted.has(word)).length;
    if (score > bestScore) {
      best = index + 1;
      bestScore = score;
    }
  }
  if (!best) return `${head} Nothing in it resembles the block's first line: read the file before editing it.`;
  const last = Math.min(count, best + search.split('\n').length);
  return `${head} The closest lines, as they are now:\n${numbered(lines, Math.max(1, best - 1), last).join('\n')}`;
}

function applyBlocks(content, blocks, name) {
  const placed = [];
  blocks.forEach(([search, replace], index) => {
    const found = occurrences(content, search);
    if (!found.length) throw new EditError(missed(content, search, index + 1, blocks.length, name));
    if (found.length > 1) {
      const where = found.map(at => lineOf(content, at)).join(', ');
      throw new EditError(`block ${index + 1} of ${blocks.length} matches ${found.length} places in ${name} (lines ${where}), so nothing was changed. Include more of the lines around it so it matches once.`);
    }
    const at = found[0];
    for (const place of placed) if (place[0] >= at + search.length) place[0] += replace.length - search.length;
    content = content.slice(0, at) + replace + content.slice(at + search.length);
    placed.push([at, replace.length]);
  });
  return { content, placed };
}

function report(content, placed, name) {
  const lines = content.split('\n');
  const count = lineCount(content);
  const out = [`Changed ${name}: ${placed.length} ${placed.length === 1 ? 'block' : 'blocks'}.`];
  for (const [at, length] of placed) {
    const start = lineOf(content, at);
    const end = length ? start + content.slice(at, at + length).split('\n').length - 1 : start - 1;
    out.push(end <= start ? `${name}:${start}` : `${name}:${start}-${end}`);
    out.push(...numbered(lines, Math.max(1, start - 1), Math.min(count, Math.max(start, end) + 1)));
  }
  return out.join('\n');
}

function read(name) {
  if (!existsSync(name) || !statSync(name).isFile()) throw new EditError(`${name} does not exist. Create a file with: cat > ${name} <<'EOF' … EOF`);
  const buffer = readFileSync(name);
  if (!isUtf8(buffer)) throw new EditError(`${name} isn't UTF-8 text.`);
  return buffer.toString('utf8');
}

function main(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (args.length !== 1) {
    console.error(`edit: give one file to change.\n${USAGE}`);
    return 1;
  }
  const [name] = args;
  try {
    const before = read(name);
    if (process.stdin.isTTY) throw new EditError(`give the blocks on standard input.\n${USAGE}`);
    const { content, placed } = applyBlocks(before, parseBlocks(readFileSync(0, 'utf8')), name);
    if (content === before) {
      console.log(`${name} is unchanged: each block already reads as its replacement.`);
      return 0;
    }
    writeFileSync(name, content);
    console.log(report(content, placed, name));
    return 0;
  } catch (error) {
    if (!(error instanceof EditError)) throw error;
    console.error(`edit: ${error.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
