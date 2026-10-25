export interface LinePart {
  kind: 'shell' | 'studio';
  text: string;
  then: ';' | '&&' | null;
}

const STUDIO = /^studio(\s|$)/;

function topLevelPieces(line: string): Array<{ text: string; then: ';' | '&&' | null }> | null {
  const pieces: Array<{ text: string; then: ';' | '&&' | null }> = [];
  let quote: string | null = null;
  let depth = 0;
  let current = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote !== "'") {
        current += char + (line[++index] ?? '');
        continue;
      }
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '\\') {
      current += char + (line[++index] ?? '');
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '$' && line[index + 1] === '(') {
      depth++;
      current += '$(';
      index++;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (char === ';' || char === '\n' || (char === '&' && line[index + 1] === '&'))) {
      const then = char === '&' ? '&&' : ';';
      if (char === '&') index++;
      pieces.push({ text: current.trim(), then });
      current = '';
      continue;
    }
    current += char;
  }
  if (quote || depth) return null;
  pieces.push({ text: current.trim(), then: null });
  return pieces.filter(piece => piece.text.length > 0);
}

export function splitStudioLine(line: string): LinePart[] | null {
  if (line.includes('<<')) return null;
  const pieces = topLevelPieces(line);
  if (!pieces || pieces.length < 2 || !pieces.some(piece => STUDIO.test(piece.text))) return null;
  if (pieces.some(piece => STUDIO.test(piece.text) && /(^|[^|])\|([^|]|$)|>/.test(piece.text))) return null;
  const parts: LinePart[] = [];
  for (const piece of pieces) {
    const kind = STUDIO.test(piece.text) ? 'studio' : 'shell';
    const last = parts.at(-1);
    if (kind === 'shell' && last?.kind === 'shell') {
      last.text = `${last.text} ${last.then === '&&' ? '&&' : ';'} ${piece.text}`;
      last.then = piece.then;
    } else parts.push({ kind, text: piece.text, then: piece.then });
  }
  return parts;
}
