import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestFields {
  requestId: string;
}

const requests = new AsyncLocalStorage<RequestFields>();
const QUIET = /^\/api\/studio\/health\b/;

export const STRUCTURED_LOGS = process.env.NODE_ENV === 'production';

export function logLine(level: string, fields: Record<string, unknown>): void {
  if (!STRUCTURED_LOGS) {
    const { message, ...rest } = fields;
    const detail = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    (level === 'error' ? console.error : console.log)(`[${level}] ${String(message ?? '')}${detail}`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, service: 'studio', ...requests.getStore(), ...fields })}\n`);
}

export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const requestId = (req.header('x-request-id') ?? '').slice(0, 100) || randomUUID();
  res.setHeader('x-request-id', requestId);
  const fields: RequestFields = { requestId };
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    if (!STRUCTURED_LOGS || QUIET.test(req.path)) return;
    requests.run(fields, () =>
      logLine(res.statusCode >= 500 ? 'error' : 'info', {
        context: 'http',
        message: `${req.method} ${req.path} ${res.statusCode}`,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
      }),
    );
  });
  requests.run(fields, next);
}

function fieldsOf(message: unknown, params: unknown[], withTrace: boolean): Record<string, unknown> {
  const context = typeof params[params.length - 1] === 'string' ? (params[params.length - 1] as string) : undefined;
  const trace = withTrace && params.length > 1 && typeof params[0] === 'string' ? params[0] : undefined;
  return { context, message: typeof message === 'string' ? message : JSON.stringify(message), ...(trace ? { trace } : {}) };
}

export class JsonLogger implements LoggerService {
  log(message: unknown, ...params: unknown[]) {
    logLine('info', fieldsOf(message, params, false));
  }

  error(message: unknown, ...params: unknown[]) {
    logLine('error', fieldsOf(message, params, true));
  }

  warn(message: unknown, ...params: unknown[]) {
    logLine('warn', fieldsOf(message, params, false));
  }

  debug(message: unknown, ...params: unknown[]) {
    logLine('debug', fieldsOf(message, params, false));
  }

  verbose(message: unknown, ...params: unknown[]) {
    logLine('verbose', fieldsOf(message, params, false));
  }

  fatal(message: unknown, ...params: unknown[]) {
    logLine('fatal', fieldsOf(message, params, true));
  }
}
