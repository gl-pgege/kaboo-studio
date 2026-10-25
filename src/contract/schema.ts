import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const studioSchemaSdl = readFileSync(join(__dirname, 'schema', 'studio.graphql'), 'utf8');
