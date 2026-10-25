import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../dist/engine/config.js';
import { ToolchainService } from '../dist/engine/workspaces/toolchain.service.js';

const REGISTRY = 'https://endofszn-dev-111122223333.d.codeartifact.us-east-1.amazonaws.com/npm/storefront/';
const HOUR = 3600_000;

function toolchain(expiresIn) {
  const service = new ToolchainService({});
  const issued = [];
  service.cachedScripts = [];
  service.codeArtifact = {
    send: async command => {
      issued.push(command.input);
      return { authorizationToken: `token-${issued.length}`, expiration: new Date(Date.now() + expiresIn) };
    },
  };
  return { service, issued };
}

async function npmrc(service) {
  const files = await service.files();
  return files.find(file => file.path === '.npmrc').bytes.toString();
}

test('sessions install from the local registry without a token when CodeArtifact is not configured', async t => {
  const before = config.codeArtifactDomain;
  t.after(() => (config.codeArtifactDomain = before));
  config.codeArtifactDomain = '';
  const { service, issued } = toolchain(12 * HOUR);
  const contents = await npmrc(service);
  assert.equal(issued.length, 0);
  assert.doesNotMatch(contents, /_authToken/);
});

test('sessions get a CodeArtifact token for the registry, reused while it outlasts a session', async t => {
  const before = { npmRegistry: config.npmRegistry, codeArtifactDomain: config.codeArtifactDomain, codeArtifactOwner: config.codeArtifactOwner, registryScopes: config.registryScopes };
  t.after(() => Object.assign(config, before));
  Object.assign(config, { npmRegistry: REGISTRY, codeArtifactDomain: 'endofszn-dev', codeArtifactOwner: '111122223333', registryScopes: ['@endofszn'] });
  const { service, issued } = toolchain(12 * HOUR);

  const first = await npmrc(service);
  assert.match(first, /^registry=https:\/\/endofszn-dev-111122223333\.d\.codeartifact/m);
  assert.match(first, /^@endofszn:registry=https:\/\/endofszn-dev-111122223333\.d\.codeartifact/m);
  assert.ok(first.includes('//endofszn-dev-111122223333.d.codeartifact.us-east-1.amazonaws.com/npm/storefront/:_authToken=token-1\n'));
  assert.deepEqual(issued[0], { domain: 'endofszn-dev', domainOwner: '111122223333', durationSeconds: 12 * 3600 });

  await npmrc(service);
  assert.equal(issued.length, 1);
});

test('a token with less time left than the longest session is replaced', async t => {
  const before = { npmRegistry: config.npmRegistry, codeArtifactDomain: config.codeArtifactDomain };
  t.after(() => Object.assign(config, before));
  Object.assign(config, { npmRegistry: REGISTRY, codeArtifactDomain: 'endofszn-dev' });
  const { service, issued } = toolchain(7 * HOUR);

  await npmrc(service);
  const second = await npmrc(service);
  assert.equal(issued.length, 2);
  assert.match(second, /:_authToken=token-2$/m);
});
