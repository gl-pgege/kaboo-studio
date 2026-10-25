import type { Bridge } from './bridge.ts';

const STYLE = `
body[data-studio-select] [data-studio-source]:hover { outline: 2px solid rgba(147, 51, 234, 0.75); outline-offset: 2px; cursor: crosshair; }
body[data-studio-edit] [data-studio-text]:hover, body[data-studio-edit] [data-studio-src]:hover { outline: 2px dashed rgba(147, 51, 234, 0.75); outline-offset: 2px; cursor: text; }
body[data-studio-edit] [data-studio-src]:hover { cursor: pointer; }
body[data-studio-edit] [contenteditable] { outline: 2px solid rgba(147, 51, 234, 0.9); outline-offset: 2px; cursor: text; }
`;

function describe(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, tag: element.tagName.toLowerCase(), text: (element.textContent ?? '').trim().slice(0, 200) };
}

export class EditMode {
  private editing: HTMLElement | null = null;

  constructor(private readonly bridge: Bridge) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    document.addEventListener('click', event => this.onClick(event), true);
  }

  setSelecting(on: boolean) {
    if (on) document.body.dataset.studioSelect = '';
    else delete document.body.dataset.studioSelect;
  }

  setEditing(on: boolean) {
    if (on) document.body.dataset.studioEdit = '';
    else {
      delete document.body.dataset.studioEdit;
      this.finish(false);
    }
  }

  private onClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (document.body.dataset.studioEdit !== undefined) return this.onEditClick(event, target);
    if (document.body.dataset.studioSelect === undefined) return;
    const element = target.closest<HTMLElement>('[data-studio-source]');
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    this.bridge.post('select', { at: element.dataset.studioSource, ...describe(element) });
  }

  private onEditClick(event: MouseEvent, target: Element) {
    if (this.editing?.contains(target)) return;
    const element = target.closest<HTMLElement>('[data-studio-source]');
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    if (element.dataset.studioSrc !== undefined) {
      this.bridge.post('edit-image', { at: element.dataset.studioSource, src: element.dataset.studioSrc, ...describe(element) });
    } else if (element.dataset.studioText !== undefined) {
      this.start(element);
    } else if (element.tagName === 'IMG' || element.getAttribute('role') === 'img') {
      this.bridge.post('edit-hint', { at: element.dataset.studioSource, kind: 'picture', ...describe(element) });
    } else if ((element.textContent ?? '').trim()) {
      this.bridge.post('edit-hint', { at: element.dataset.studioSource, kind: 'text', ...describe(element) });
    }
  }

  private start(element: HTMLElement) {
    this.finish(true);
    const before = element.textContent ?? '';
    const nodes = [...element.childNodes];
    const values = nodes.map(node => node.nodeValue);
    this.restore = text => {
      element.replaceChildren(...nodes);
      nodes.forEach((node, index) => (node.nodeValue = text === undefined ? values[index] : index === 0 ? text : ''));
    };
    this.editing = element;
    element.contentEditable = 'plaintext-only';
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        this.finish(false);
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.finish(true);
      }
    };
    const onBlur = () => this.finish(true);
    element.addEventListener('keydown', onKey);
    element.addEventListener('blur', onBlur, { once: true });
    element.dataset.studioBefore = before;
    this.cleanup = () => element.removeEventListener('keydown', onKey);
  }

  private cleanup: (() => void) | null = null;
  private restore: ((text?: string) => void) | null = null;

  private finish(commit: boolean) {
    const element = this.editing;
    if (!element) return;
    this.editing = null;
    this.cleanup?.();
    this.cleanup = null;
    element.removeAttribute('contenteditable');
    const before = element.dataset.studioBefore ?? '';
    delete element.dataset.studioBefore;
    const after = element.textContent ?? '';
    const restore = this.restore;
    this.restore = null;
    if (!commit || after.trim() === before.trim()) {
      restore?.();
      return;
    }
    restore?.(after);
    this.bridge.post('edit-text', { at: element.dataset.studioSource, before: before.trim(), after: after.trim() });
  }
}
