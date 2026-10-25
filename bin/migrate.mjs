#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.DATABASE_URL) {
  console.error('kaboo-studio-migrate: set DATABASE_URL to the Postgres database the studio uses.');
  process.exit(1);
}
const prisma = createRequire(import.meta.url).resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [prisma, 'migrate', 'deploy', '--config', path.join(root, 'prisma.config.mjs')], { stdio: 'inherit' });
process.exit(result.status ?? 1);
