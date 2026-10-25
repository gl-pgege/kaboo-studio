import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSchema } from 'graphql';
import { editedFileSchema, studioSchemaSdl } from '../../dist/contract/index.js';

test('edited files refuse paths that climb out of the design', () => {
  assert.equal(editedFileSchema.safeParse({ path: '../etc/passwd', contents: '', baseHash: null }).success, false);
  assert.equal(editedFileSchema.safeParse({ path: '/abs', contents: '', baseHash: null }).success, false);
  assert.equal(editedFileSchema.safeParse({ path: 'app/blocks/Hero.tsx', contents: 'x', baseHash: null }).success, true);
});

test('every studio field is mounted for a level or kept for the host, and follows the naming rule', () => {
  const schema = buildSchema(studioSchemaSdl);
  for (const [kind, type] of [['query', schema.getQueryType()], ['mutation', schema.getMutationType()]]) {
    for (const field of Object.values(type.getFields())) {
      const directives = field.astNode.directives.map(directive => directive.name.value);
      assert.equal(directives.filter(name => name === 'access' || name === 'host').length, 1, `${field.name} needs @access or @host`);
      if (kind === 'query') assert.match(field.name, /^studio[A-Z]/, field.name);
      else assert.match(field.name, /^[a-z]+(?:[A-Z][a-z]+)*?Studio[A-Z]/, field.name);
    }
  }
});
