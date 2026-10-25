import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { BusyError } from '../drafts/writers.service';
import { OutOfSyncError } from '../drafts/draft.service';
import { SandboxError } from '../drafts/sync-result';
import { logLine } from '../logging';
import { CapacityError } from '../scaling/admission';
import { TemplateMissingError } from '../templates/template.service';
import { UsageError } from '../terminal/studio-commands';
import { StaleDraftError } from '../versions/version-store.service';
import { ToolchainError } from '../workspaces/toolchain.service';

const HTTP_CODES: Record<number, string> = { 400: 'BAD_USER_INPUT', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT' };

function httpMessage(error: HttpException): string {
  const body = error.getResponse();
  if (typeof body === 'string') return body;
  const { message, issues } = body as { message?: string | string[]; issues?: Array<{ path: string; message: string }> };
  if (issues?.length) return issues.map(issue => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join('; ');
  return Array.isArray(message) ? message.join('; ') : (message ?? error.message);
}

export function studioErrorOf(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof HttpException) return { status: error.getStatus(), code: HTTP_CODES[error.getStatus()] ?? 'INTERNAL', message: httpMessage(error) };
  if (error instanceof ZodError) return { status: 400, code: 'BAD_USER_INPUT', message: error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ') };
  const [status, code] =
    error instanceof UsageError
      ? [400, 'BAD_USER_INPUT']
      : error instanceof BusyError || error instanceof CapacityError
        ? [409, 'BUSY']
        : error instanceof StaleDraftError
          ? [409, 'STALE']
          : error instanceof OutOfSyncError || error instanceof SandboxError
            ? [503, 'WORKSPACE']
            : error instanceof ToolchainError
              ? [502, 'TOOLCHAIN']
              : error instanceof TemplateMissingError
                ? [503, 'TEMPLATE']
                : [500, 'INTERNAL'];
  if (status === 500) logLine('error', { context: 'studio', message: `Unhandled error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}` });
  return { status, code, message: status === 500 ? 'The studio hit an unexpected error.' : (error as Error).message };
}

@Catch()
export class StudioErrorsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    if (error instanceof HttpException) {
      const body = error.getResponse();
      response.status(error.getStatus()).json(typeof body === 'string' ? { statusCode: error.getStatus(), message: body } : body);
      return;
    }
    const { status, code, message } = studioErrorOf(error);
    response.status(status).json({ statusCode: status, code, message });
  }
}
