import { createHash } from 'node:crypto';

export type TreeFiles = Record<string, string>;

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function treeId(files: TreeFiles): string {
  return sha256(
    Object.keys(files)
      .sort()
      .map(file => `${file}\0${files[file]}\n`)
      .join(''),
  );
}

export function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

export function diffTrees(from: TreeFiles, to: TreeFiles): { changed: string[]; deleted: string[] } {
  return {
    changed: Object.keys(to).filter(file => from[file] !== to[file]),
    deleted: Object.keys(from).filter(file => !(file in to)),
  };
}
