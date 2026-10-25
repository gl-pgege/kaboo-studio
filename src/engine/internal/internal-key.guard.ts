import { BadRequestException, type CanActivate, createParamDecorator, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { STUDIO_INTERNAL_HEADER } from '../../contract';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { z } from 'zod';
import { config } from '../config';

export function sameSecret(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isInternal(request: Request): boolean {
  return Boolean(config.internalKey) && sameSecret(request.header(STUDIO_INTERNAL_HEADER) ?? '', config.internalKey);
}

@Injectable()
export class InternalKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!config.internalKey || !sameSecret(request.header(STUDIO_INTERNAL_HEADER) ?? '', config.internalKey)) throw new UnauthorizedException();
    return true;
  }
}

export const StoreCode = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const store = context.switchToHttp().getRequest<Request>().header('x-studio-store') ?? '';
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(store)) throw new BadRequestException('x-studio-store names the store');
  return store;
});

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new BadRequestException({ message: 'Invalid request', issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  }
  return parsed.data;
}
