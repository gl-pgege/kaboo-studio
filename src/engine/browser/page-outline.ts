import type { Page } from 'playwright-core';

export interface OutlineNode {
  ref: string;
  role: string;
  name: string;
  depth: number;
  box: { x: number; y: number; width: number; height: number } | null;
  text: string | null;
  level: number | null;
  states: string[];
  source: string | null;
  sideways: boolean;
  url: string | null;
  context: string[];
}

export interface Outline {
  nodes: OutlineNode[];
  viewport: { width: number; height: number };
  modal: boolean;
}

const KEEP = new Set([
  'heading',
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'option',
  'checkbox',
  'radio',
  'radiogroup',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'tablist',
  'menuitem',
  'menu',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'navigation',
  'banner',
  'main',
  'contentinfo',
  'form',
  'search',
  'table',
]);
const NAMED_ONLY = new Set(['img', 'region', 'list', 'group', 'article', 'figure']);
const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'option']);
const LINE = /^(\s*)- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?(.*?)(?::\s(.*))?$/;

export function parseSnapshot(snapshot: string, basename: string): OutlineNode[] {
  const nodes: OutlineNode[] = [];
  const stack: Array<{ node: OutlineNode; heading: string | null }> = [];
  let pendingUrl: { node: OutlineNode; depth: number } | null = null;
  for (const raw of snapshot.split('\n')) {
    const urlLine = raw.match(/^(\s*)- \/url: (.*)$/);
    if (urlLine && pendingUrl) {
      const value = urlLine[2].replace(/^"|"$/g, '');
      pendingUrl.node.url = value.startsWith(basename) ? value.slice(basename.length) || '/' : value;
      continue;
    }
    const match = raw.match(LINE);
    if (!match) continue;
    const [, indent, role, quoted, attributes, trailing] = match;
    const ref = attributes.match(/\[ref=(e\d+)\]/)?.[1];
    if (!ref) continue;
    const box = attributes.match(/\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/);
    const node: OutlineNode = {
      ref,
      role,
      name: (quoted ?? '').replace(/\\"/g, '"'),
      depth: indent.length / 2,
      box: box ? { x: Number(box[1]), y: Number(box[2]), width: Number(box[3]), height: Number(box[4]) } : null,
      text: trailing && trailing !== '' ? trailing.replace(/^"|"$/g, '') : null,
      level: Number(attributes.match(/\[level=(\d+)\]/)?.[1]) || null,
      states: [...attributes.matchAll(/\[(checked|disabled|expanded|pressed|selected)(?:=(\w+))?\]/g)].map(state => (state[2] && state[2] !== 'true' ? `${state[1]}=${state[2]}` : state[1])),
      source: null,
      sideways: false,
      url: null,
      context: [],
    };
    while (stack.length && stack[stack.length - 1].node.depth >= node.depth) stack.pop();
    node.context = stack.flatMap(parent => [parent.node.name, parent.heading]).filter((name): name is string => Boolean(name));
    if (role === 'heading' && stack.length) stack[stack.length - 1].heading = node.name;
    stack.push({ node, heading: null });
    nodes.push(node);
    pendingUrl = role === 'link' ? { node, depth: node.depth } : null;
  }
  return nodes;
}

export function keep(node: OutlineNode): boolean {
  if (KEEP.has(node.role)) return true;
  if (NAMED_ONLY.has(node.role)) return Boolean(node.name) || node.sideways;
  return false;
}

export function formatOutline(outline: Outline, deviceLabel: string): string {
  const lines: string[] = [];
  let folded = false;
  const shown = outline.nodes.filter(keep);
  for (const node of shown) {
    if (!folded && node.box && node.box.y >= outline.viewport.height) {
      lines.push(`--- end of the screen on this ${deviceLabel} ---`);
      folded = true;
    }
    lines.push(formatNode(node));
  }
  if (outline.modal) lines.unshift('(a dialog is open: only it is shown, as a screen reader would)');
  return lines.join('\n');
}

export function describe(node: OutlineNode): string {
  const name = node.name ? ` "${node.name.length > 80 ? `${node.name.slice(0, 77)}…` : node.name}"` : INTERACTIVE.has(node.role) ? ' (no name)' : '';
  const level = node.level && node.role === 'heading' ? ` h${node.level}` : '';
  const states = node.states.length ? ` [${node.states.join(', ')}]` : '';
  const extra = node.sideways ? ' (scrolls sideways)' : '';
  const url = node.url && node.role === 'link' ? ` → ${node.url}` : '';
  return `${node.role}${level}${name}${states}${extra}${url}`;
}

function formatNode(node: OutlineNode): string {
  const label = `${node.ref} ${describe(node)}`;
  return node.source ? `${label.padEnd(56)} ${node.source}` : label;
}

export function outlineChanges(before: Outline | null, after: Outline): string[] {
  if (!before) return [];
  if (after.modal && !before.modal) {
    const dialog = after.nodes.find(node => node.role === 'dialog' || node.role === 'alertdialog');
    const actions = after.nodes.filter(node => INTERACTIVE.has(node.role)).slice(0, 8);
    return [`${dialog ? describe(dialog) : 'a dialog'} opened${actions.length ? ` with ${actions.map(node => `${node.ref} ${describe(node)}`).join('; ')}` : ''}`];
  }
  if (before.modal && !after.modal) return ['the dialog closed'];
  const key = (node: OutlineNode) => `${node.role}|${node.name}|${node.states.join(',')}`;
  const previous = new Set(before.nodes.filter(keep).map(key));
  const next = new Set(after.nodes.filter(keep).map(key));
  const added = after.nodes.filter(keep).filter(node => !previous.has(key(node)));
  const removed = before.nodes.filter(keep).filter(node => !next.has(key(node)));
  const changes: string[] = [];
  for (const node of added.filter(node => ['dialog', 'alertdialog', 'alert', 'status'].includes(node.role)).slice(0, 3)) changes.push(`${describe(node)} opened`);
  for (const node of removed.filter(node => ['dialog', 'alertdialog'].includes(node.role)).slice(0, 3)) changes.push(`${describe(node)} closed`);
  const plain = added.filter(node => !['dialog', 'alertdialog', 'alert', 'status'].includes(node.role));
  if (plain.length) changes.push(`new: ${plain.slice(0, 8).map(node => `${node.ref} ${describe(node)}`).join('; ')}${plain.length > 8 ? ` and ${plain.length - 8} more` : ''}`);
  const gone = removed.filter(node => !['dialog', 'alertdialog'].includes(node.role));
  if (gone.length) changes.push(`gone: ${gone.slice(0, 8).map(describe).join('; ')}${gone.length > 8 ? ` and ${gone.length - 8} more` : ''}`);
  return changes;
}

interface Tagged {
  source: string;
  x: number;
  y: number;
  width: number;
  height: number;
  sideways: boolean;
}

function contains(outer: Tagged, inner: NonNullable<OutlineNode['box']>) {
  return inner.x >= outer.x - 1 && inner.y >= outer.y - 1 && inner.x + inner.width <= outer.x + outer.width + 1 && inner.y + inner.height <= outer.y + outer.height + 1;
}

export async function captureOutline(page: Page, basename: string): Promise<Outline> {
  const modal = await page.locator('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]').first();
  const isModal = (await modal.count()) > 0 && (await modal.isVisible().catch(() => false));
  const snapshot = isModal ? await modal.ariaSnapshot({ mode: 'ai', boxes: true }) : await page.ariaSnapshot({ mode: 'ai', boxes: true });
  const nodes = parseSnapshot(snapshot, basename);
  const inDialog = isModal || (nodes.some(node => node.role === 'dialog' || node.role === 'alertdialog') && !nodes.some(node => node.role === 'main'));
  const { tagged, viewport } = await page.evaluate(() => {
    const out: Array<{ source: string; x: number; y: number; width: number; height: number; sideways: boolean }> = [];
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
      const source = element.dataset?.studioSource ?? '';
      const sideways = element.scrollWidth > element.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(element).overflowX);
      if (!source && !sideways) continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      out.push({ source, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), sideways });
    }
    return { tagged: out, viewport: { width: innerWidth, height: innerHeight } };
  });
  for (const node of nodes) {
    if (!node.box) continue;
    let best: Tagged | null = null;
    for (const candidate of tagged) {
      if (!candidate.source || !contains(candidate, node.box)) continue;
      if (!best || candidate.width * candidate.height <= best.width * best.height) best = candidate;
    }
    node.source = best?.source.replace(/:(\d+):\d+$/, ':$1') ?? null;
    node.sideways = tagged.some(candidate => candidate.sideways && Math.abs(candidate.x - node.box!.x) <= 1 && Math.abs(candidate.y - node.box!.y) <= 1 && Math.abs(candidate.width - node.box!.width) <= 1);
  }
  return { nodes, viewport, modal: inDialog };
}
