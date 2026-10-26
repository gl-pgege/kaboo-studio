import type { Actor, EditedFile, FileTree, SaveFilesResponse, Version } from '../../contract';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import { config } from '../config';
import { DesignService } from '../designs/design.service';
import { DraftService } from '../drafts/draft.service';
import { runWriter } from '../drafts/writers.service';
import { isBinary } from '../versions/tree';
import { VersionStore } from '../versions/version-store.service';
import { editImage, editText, InlineEditError, placeOf } from './inline-edits';

const MAX_BLOB_TEXT = 1024 * 1024;
const RUN_HOLD_MS = 20 * 60_000;

const short = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
};

function ownerOf(actor: Actor): string {
  return runWriter(actor) ?? `${actor.kind}:${actor.personId ?? actor.name}:${randomUUID()}`;
}

@Injectable()
export class EditorService {
  constructor(
    private readonly designs: DesignService,
    private readonly drafts: DraftService,
    private readonly versions: VersionStore,
  ) {}

  async tree(designId: string, store: string, version?: number): Promise<FileTree> {
    const tree = await this.treeOf(designId, store, version);
    const files = await this.versions.tree(store, tree);
    return { tree, files: Object.entries(files).map(([file, hash]) => ({ path: file, hash })).sort((a, b) => a.path.localeCompare(b.path)) };
  }

  async blobs(designId: string, store: string, hashes: string[]): Promise<Record<string, { text: string | null; base64: string | null }>> {
    await this.designs.get(designId, store);
    const out: Record<string, { text: string | null; base64: string | null }> = {};
    await Promise.all(
      hashes.map(async hash => {
        const bytes = await this.versions.blob(store, hash).catch(() => null);
        if (!bytes) return;
        out[hash] = isBinary(bytes) ? { text: null, base64: bytes.length > MAX_BLOB_TEXT ? null : bytes.toString('base64') } : { text: bytes.toString('utf8'), base64: null };
      }),
    );
    return out;
  }

  async save(designId: string, store: string, actor: Actor, files: EditedFile[], message?: string | null): Promise<SaveFilesResponse> {
    const { draft } = await this.designs.get(designId, store);
    const current = await this.versions.tree(store, draft.tree);
    const conflicts = files.filter(file => (current[file.path] ?? null) !== file.baseHash).map(file => file.path);
    const accepted = files.filter(file => !conflicts.includes(file.path));
    const write = new Map(accepted.filter(file => file.contents !== null).map(file => [file.path, Buffer.from(file.contents!, 'utf8')]));
    const remove = accepted.filter(file => file.contents === null).map(file => file.path);
    if (!write.size && !remove.length) {
      return { result: { changed: [], deleted: [], draft: null, previousDraft: draft.tree, refused: [], compileErrors: [], types: [], lint: [], preview: null, command: null }, version: null, conflicts };
    }
    const owner = ownerOf(actor);
    const run = runWriter(actor) !== null;
    const outcome = await this.drafts.change(
      designId,
      store,
      actor,
      { kind: 'files', write, delete: remove },
      run ? { owner, ownerTtlMs: RUN_HOLD_MS, diagnose: config.diagnoseOnChange } : { owner, releaseAfter: true, diagnose: config.diagnoseOnChange },
    );
    const names = [...outcome.result.changed, ...outcome.result.deleted];
    const version =
      outcome.result.draft && !run ? await this.drafts.commit(designId, store, actor, message?.trim() || `Edited ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`) : null;
    return { result: outcome.result, version, conflicts };
  }

  editText(designId: string, store: string, actor: Actor, at: string, before: string, after: string): Promise<SaveFilesResponse> {
    return this.inline(designId, store, actor, at, source => editText(placeOf(at), source, before, after), `Changed “${short(before)}” to “${short(after)}”`);
  }

  editImage(designId: string, store: string, actor: Actor, at: string, before: string, after: string): Promise<SaveFilesResponse> {
    return this.inline(designId, store, actor, at, source => editImage(placeOf(at), source, before, after), `Changed a picture in ${placeOf(at).file.split('/').pop()}`);
  }

  private async inline(designId: string, store: string, actor: Actor, at: string, change: (source: string) => string, message: string): Promise<SaveFilesResponse> {
    const place = placeOf(at);
    const { draft } = await this.designs.get(designId, store);
    const hash = (await this.versions.tree(store, draft.tree))[place.file];
    if (!hash) throw new InlineEditError(`${place.file} isn't in the design any more.`);
    const source = (await this.versions.blob(store, hash)).toString('utf8');
    return this.save(designId, store, actor, [{ path: place.file, contents: change(source), baseHash: hash }], message);
  }

  async restore(designId: string, store: string, actor: Actor, number: number): Promise<Version | null> {
    const target = await this.versions.version(designId, number);
    if (!target) throw new NotFoundException(`There is no version ${number} of this design.`);
    await this.drafts.change(designId, store, actor, { kind: 'tree', tree: target.tree }, { owner: ownerOf(actor), releaseAfter: true });
    return this.drafts.commit(designId, store, actor, `Restored version ${number}`);
  }

  async archive(designId: string, store: string, version?: number): Promise<{ name: string; zip: Buffer }> {
    const { design } = await this.designs.get(designId, store);
    const tree = await this.treeOf(designId, store, version);
    const files = await this.versions.files(store, tree);
    const folder = design.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || config.templateName;
    const zip = zipSync(Object.fromEntries([...files].map(([file, bytes]) => [`${folder}/${file}`, new Uint8Array(bytes)])), { level: 6 });
    return { name: `${folder}${version ? `-v${version}` : ''}.zip`, zip: Buffer.from(zip) };
  }

  private async treeOf(designId: string, store: string, version?: number): Promise<string> {
    const { draft } = await this.designs.get(designId, store);
    if (!version) return draft.tree;
    const found = await this.versions.version(designId, version);
    if (!found) throw new BadRequestException(`There is no version ${version} of this design.`);
    return found.tree;
  }
}
