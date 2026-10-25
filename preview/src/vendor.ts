import type { Exports } from './registry.ts';

export class Vendor {
  private readonly loaded = new Map<string, Promise<Exports>>();

  private constructor(
    private readonly base: string,
    private readonly entries: Record<string, string>,
  ) {}

  static async open(base: string): Promise<Vendor> {
    const response = await fetch(`${base}vendor.json`);
    if (!response.ok) throw new Error(`The package bundle for this preview is missing (${response.status})`);
    const manifest = (await response.json()) as { entries: Record<string, string> };
    return new Vendor(base, manifest.entries);
  }

  asset(path: string): string {
    return `${this.base}assets/${path}`;
  }

  load(specifier: string): Promise<Exports> {
    let pending = this.loaded.get(specifier);
    if (!pending) {
      const file = this.entries[specifier];
      if (!file) return Promise.reject(new Error(`The package "${specifier}" is not in this preview's bundle. Install it with npm, then run the command again.`));
      pending = import(/* @vite-ignore */ `${this.base}${file}`).then((namespace: Exports) => {
        const keys = Object.keys(namespace);
        const fallback = namespace.default;
        if (keys.length === 1 && keys[0] === 'default' && fallback && (typeof fallback === 'object' || typeof fallback === 'function')) {
          return Object.assign(Object.create(null), fallback as Exports, { default: fallback }) as Exports;
        }
        return namespace;
      });
      this.loaded.set(specifier, pending);
    }
    return pending;
  }
}
