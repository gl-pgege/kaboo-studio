import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export { studioSchemaSdl } from './schema';

export const actorSchema = z.object({
  kind: z.enum(['person', 'assistant', 'platform']),
  name: z.string().min(1),
  personId: z.string().nullish(),
  actingFor: z.string().nullish(),
  chatId: z.string().nullish(),
  runId: z.string().nullish(),
  recipe: z.string().nullish(),
});
export type Actor = z.infer<typeof actorSchema>;

export const designFlagSchema = z.object({ kind: z.enum(['kit-upgrade-failed', 'checks-failed']), message: z.string(), details: z.array(z.string()), at: z.string() });
export type DesignFlag = z.infer<typeof designFlagSchema>;

export const designSchema = z.object({
  id: z.string(),
  store: z.string(),
  name: z.string(),
  status: z.enum(['active', 'archived', 'scratch']),
  parentId: z.string().nullable(),
  draftTree: z.string(),
  headVersion: z.number().int().nullable(),
  templateVersion: z.string(),
  kitVersion: z.string(),
  flags: z.array(designFlagSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Design = z.infer<typeof designSchema>;

export const FONT_NAMES = ['Inter', 'System UI', 'Georgia', 'Rounded', 'Monospace'] as const;
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour such as #EA580C');
export const brandSchema = z.object({
  primary: hex.optional(),
  accent: hex.optional(),
  headingFont: z.enum(FONT_NAMES).optional(),
  bodyFont: z.enum(FONT_NAMES).optional(),
  radius: z.string().regex(/^\d{1,2}px$/).optional(),
});
export type Brand = z.infer<typeof brandSchema>;

const semver = z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
export const kitUpgradeResultSchema = z.object({
  designId: z.string(),
  store: z.string(),
  outcome: z.enum(['upgraded', 'current', 'skipped', 'failed']),
  message: z.string(),
  version: z.number().int().nullable(),
});
export type KitUpgradeResult = z.infer<typeof kitUpgradeResultSchema>;

export const templateReleaseSchema = z.object({ template: z.string(), version: semver, kitVersion: semver, lockfileHash: z.string(), publishedAt: z.string() });
export type TemplateRelease = z.infer<typeof templateReleaseSchema>;

export const versionSchema = z.object({
  id: z.string(),
  designId: z.string(),
  number: z.number().int(),
  parent: z.number().int().nullable(),
  tree: z.string(),
  message: z.string(),
  author: actorSchema,
  checks: z.object({ status: z.enum(['pending', 'passed', 'failed']), summary: z.string().nullish() }).nullable(),
  createdAt: z.string(),
});
export type Version = z.infer<typeof versionSchema>;

export const treeEntrySchema = z.object({ path: z.string(), hash: z.string() });
export const fileTreeSchema = z.object({ tree: z.string(), files: z.array(treeEntrySchema) });
export type FileTree = z.infer<typeof fileTreeSchema>;

export const diagnosticSchema = z.object({ file: z.string(), line: z.number().int().nullable(), column: z.number().int().nullable(), message: z.string(), rule: z.string().nullish() });
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export const previewAckSchema = z.object({ tree: z.string().nullable(), route: z.string().nullish(), ms: z.number().nullish(), errors: z.array(z.string()), faults: z.array(z.string()).default([]) });
export type PreviewAck = z.infer<typeof previewAckSchema>;

export const previewResultSchema = previewAckSchema.extend({ status: z.enum(['rendered', 'errors', 'compile-errors', 'no-preview', 'timeout']) });
export type PreviewResult = z.infer<typeof previewResultSchema>;

export const changeResultSchema = z.object({
  changed: z.array(z.string()),
  deleted: z.array(z.string()),
  draft: z.string().nullable(),
  previousDraft: z.string().nullable(),
  refused: z.array(z.object({ path: z.string(), reason: z.string() })),
  compileErrors: z.array(diagnosticSchema),
  types: z.array(diagnosticSchema),
  lint: z.array(diagnosticSchema),
  preview: previewResultSchema.nullable(),
  command: z.object({ output: z.string(), exitCode: z.number().int(), durationMs: z.number().int() }).nullable(),
});
export type ChangeResult = z.infer<typeof changeResultSchema>;

export const editedFileSchema = z.object({
  path: z.string().min(1).max(300).regex(/^(?!\/)(?!.*\.\.)/),
  contents: z.string().max(1024 * 1024).nullable(),
  baseHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export type EditedFile = z.infer<typeof editedFileSchema>;

export const saveFilesResponseSchema = z.object({ result: changeResultSchema, version: versionSchema.nullable(), conflicts: z.array(z.string()) });
export type SaveFilesResponse = z.infer<typeof saveFilesResponseSchema>;

export const rerenderRequestSchema = z.object({
  paths: z.array(z.string().max(300).regex(/^\//)).max(500).default([]),
  removed: z.array(z.string().max(300).regex(/^\//)).max(500).default([]),
  all: z.boolean().default(false),
  design: z.string().nullish(),
  urgency: z.enum(['soon', 'hourly']).default('soon'),
});

export const deploymentStatusSchema = z.enum(['queued', 'building', 'ready', 'failed', 'removed']);
export const deploymentFindingSchema = z.object({ path: z.string(), problem: z.string() });
export const deploymentSchema = z.object({
  id: z.string(),
  store: z.string(),
  designId: z.string(),
  designName: z.string(),
  version: z.number().int(),
  tree: z.string(),
  status: deploymentStatusSchema,
  summary: z.string().nullable(),
  pages: z.number().int(),
  checks: z.object({ status: z.string(), summary: z.string().nullable() }).nullable(),
  problems: z.array(deploymentFindingSchema),
  warnings: z.array(deploymentFindingSchema),
  live: z.boolean(),
  actor: actorSchema,
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  renderedAt: z.string().nullable(),
});
export type Deployment = z.infer<typeof deploymentSchema>;
export const routingSchema = z.object({
  revision: z.number().int(),
  live: deploymentSchema.nullable(),
  canRollBack: z.boolean(),
  previous: deploymentSchema.nullable(),
  url: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type Routing = z.infer<typeof routingSchema>;

export const studioActivitySchema = z.object({
  store: z.string(),
  design: z.string(),
  designName: z.string(),
  version: z.object({ number: z.number().int(), message: z.string() }),
  actor: actorSchema,
});
export type StudioActivity = z.infer<typeof studioActivitySchema>;

export const STUDIO_INTERNAL_HEADER = 'x-internal-key';
export const STUDIO_PREVIEW_HEADER = 'x-endofszn-preview';

export interface PreviewGrant {
  design: string;
  store: string;
  tree: string | null;
  agent: boolean;
  exp: number;
}

export function previewSecret(internalKey: string, explicit?: string | null): string {
  return explicit || createHash('sha256').update(`studio-preview:${internalKey}`).digest('hex');
}

function previewSignature(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signPreviewToken(secret: string, grant: Omit<PreviewGrant, 'exp'>, ttlSeconds: number): { token: string; exp: number } {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = Buffer.from(JSON.stringify({ d: grant.design, s: grant.store, t: grant.tree, a: grant.agent ? 1 : 0, e: exp })).toString('base64url');
  return { token: `${payload}.${previewSignature(secret, payload)}`, exp };
}

export function verifyPreviewToken(secret: string, token: string): PreviewGrant | 'invalid' | 'expired' {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return 'invalid';
  const expected = Buffer.from(previewSignature(secret, payload));
  const presented = Buffer.from(signature);
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) return 'invalid';
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { d: string; s: string; t: string | null; a?: number; e: number };
    if (parsed.e * 1000 < Date.now()) return 'expired';
    return { design: parsed.d, store: parsed.s, tree: parsed.t ?? null, agent: parsed.a === 1, exp: parsed.e };
  } catch {
    return 'invalid';
  }
}
