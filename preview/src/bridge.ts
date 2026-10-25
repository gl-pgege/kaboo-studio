export type ParentMessage =
  | { type: 'select-mode'; on: boolean }
  | { type: 'edit-mode'; on: boolean }
  | { type: 'navigate'; path: string }
  | { type: 'reload' };

export class Bridge {
  private readonly handlers = new Set<(message: ParentMessage) => void>();

  private readonly source: string;

  constructor(
    private readonly origins: string[],
    private readonly brand = 'studio',
  ) {
    this.source = `${brand}-preview`;
    window.addEventListener('message', event => {
      if (!this.origins.includes(event.origin) || event.source !== window.parent) return;
      const data = event.data as { source?: string } & ParentMessage;
      if (data?.source !== `${this.brand}-studio`) return;
      for (const handler of this.handlers) handler(data);
    });
  }

  embedded(): boolean {
    return window.parent !== window;
  }

  onMessage(handler: (message: ParentMessage) => void) {
    this.handlers.add(handler);
  }

  post(type: string, data: Record<string, unknown> = {}) {
    if (!this.embedded()) return;
    for (const origin of this.origins) window.parent.postMessage({ source: this.source, type, ...data }, origin);
  }
}
