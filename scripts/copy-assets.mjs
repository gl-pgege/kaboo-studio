import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'dist/contract/schema'), { recursive: true });
cpSync(path.join(root, 'src/contract/schema/studio.graphql'), path.join(root, 'dist/contract/schema/studio.graphql'));
