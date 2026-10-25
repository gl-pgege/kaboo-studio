import { type PreviewGrant, previewSecret, signPreviewToken, verifyPreviewToken } from '../../contract';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config';

export type { PreviewGrant };

@Injectable()
export class PreviewTokens {
  private readonly secret = previewSecret(config.internalKey, config.previewSecret);

  sign(grant: Omit<PreviewGrant, 'exp'>, ttlSeconds: number): { token: string; expiresAt: string } {
    const { token, exp } = signPreviewToken(this.secret, grant, ttlSeconds);
    return { token, expiresAt: new Date(exp * 1000).toISOString() };
  }

  verify(token: string): PreviewGrant {
    const grant = verifyPreviewToken(this.secret, token);
    if (grant === 'expired') throw new UnauthorizedException('This preview link has expired. Open the preview again from the studio.');
    if (grant === 'invalid') throw new UnauthorizedException('This preview link is not valid.');
    return grant;
  }

  checkBase(store: string, tree: string): string {
    return `/_studio/check/${store}/${tree}/${this.checkKey(store, tree)}/`;
  }

  verifyCheck(store: string, tree: string, key: string): boolean {
    const expected = Buffer.from(this.checkKey(store, tree));
    const given = Buffer.from(key);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private checkKey(store: string, tree: string): string {
    return createHmac('sha256', this.secret).update(`check:${store}:${tree}`).digest('base64url').slice(0, 32);
  }

  url(design: string, token: string, path = '/'): string {
    return `${config.previewOrigin}/d/${design}/${token}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
