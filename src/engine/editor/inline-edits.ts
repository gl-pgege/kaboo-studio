import { BadRequestException } from '@nestjs/common';
import ts from 'typescript';

export class InlineEditError extends BadRequestException {}

export interface EditPlace {
  file: string;
  line: number;
  column: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function placeOf(at: string): EditPlace {
  const match = /^(app\/.+\.[jt]sx):(\d+):(\d+)$/.exec(at);
  if (!match) throw new InlineEditError('Pick the element on the preview again.');
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

const decode = (text: string) => text.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (entity, name: string) => (name.startsWith('#x') ? String.fromCodePoint(parseInt(name.slice(2), 16)) : name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : (ENTITIES[name.toLowerCase()] ?? entity)));
const normalize = (text: string) => decode(text).replace(/\s+/g, ' ').trim();

function elementAt(sourceFile: ts.SourceFile, place: EditPlace): ts.JsxElement | ts.JsxSelfClosingElement | null {
  let found: ts.JsxElement | ts.JsxSelfClosingElement | null = null;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const start = sourceFile.getLineAndCharacterOfPosition(opening.getStart(sourceFile));
      if (start.line + 1 === place.line && start.character + 1 === place.column) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function parse(place: EditPlace, source: string) {
  const sourceFile = ts.createSourceFile(place.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const element = elementAt(sourceFile, place);
  if (!element) throw new InlineEditError("That element isn't in the code any more. Pick it again on the preview.");
  return { sourceFile, element };
}

export function editText(place: EditPlace, source: string, before: string, after: string): string {
  const { sourceFile, element } = parse(place, source);
  const children = ts.isJsxElement(element) ? element.children : ts.factory.createNodeArray<ts.JsxChild>();
  const texts = children.filter(ts.isJsxText).filter(child => child.getFullText(sourceFile).trim());
  if (!texts.length || children.some(child => !ts.isJsxText(child))) {
    throw new InlineEditError("This text comes from the store's data or is built from several parts, so it can't be changed here. Ask the assistant to change it.");
  }
  const node = texts[0];
  const raw = source.slice(node.pos, node.end);
  if (normalize(raw) !== normalize(before)) throw new InlineEditError('The text changed since you picked it. Pick it again on the preview.');
  const value = after.replace(/\s+/g, ' ').trim();
  if (!value) throw new InlineEditError('Text can’t be empty. Ask the assistant to remove the element instead.');
  if (value.length > 2000) throw new InlineEditError('That text is too long to edit here. Ask the assistant to change it.');
  const leading = /^\s*/.exec(raw)?.[0] ?? '';
  const trailing = /\s*$/.exec(raw)?.[0] ?? '';
  const literal = /[{}<>]/.test(value) ? `{${JSON.stringify(value)}}` : value;
  return `${source.slice(0, node.pos)}${leading}${literal}${trailing}${source.slice(node.end)}`;
}

export function editImage(place: EditPlace, source: string, before: string, after: string): string {
  const { sourceFile, element } = parse(place, source);
  const opening = ts.isJsxElement(element) ? element.openingElement : element;
  const src = opening.attributes.properties.find((attribute): attribute is ts.JsxAttribute => ts.isJsxAttribute(attribute) && attribute.name.getText(sourceFile) === 'src');
  const initializer = src?.initializer;
  const literal = initializer && ts.isStringLiteral(initializer) ? initializer : initializer && ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression) ? initializer.expression : null;
  if (!literal) throw new InlineEditError("This picture's source isn't written in the code, so change it in the catalog or ask the assistant.");
  if (literal.text !== before) throw new InlineEditError('The picture changed since you picked it. Pick it again on the preview.');
  if (!/^(https?:\/\/|\/)[^\s"'<>]*$/.test(after)) throw new InlineEditError('Choose a picture from the store’s Assets.');
  return `${source.slice(0, literal.getStart(sourceFile))}${JSON.stringify(after)}${source.slice(literal.getEnd())}`;
}
