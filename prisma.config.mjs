import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'prisma/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = process.env.STUDIO_DATABASE_SCHEMA ?? 'studio';

function withSchema(url) {
  if (!url) return undefined;
  const parsed = new URL(url);
  parsed.searchParams.set('schema', schema);
  return parsed.toString();
}

const url = withSchema(process.env.DATABASE_URL);

export default defineConfig({
  schema: path.join(here, 'prisma', 'schema.prisma'),
  migrations: { path: path.join(here, 'prisma', 'migrations') },
  ...(url ? { datasource: { url } } : {}),
});
