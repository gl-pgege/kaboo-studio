import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { loadRouter, deploymentFile } = await import('../dist/engine/deployments/edge.js');
const { seoReview, sitemapXml, pageFilesOf } = await import('../dist/engine/deployments/seo.js');
const { securityScan } = await import('../dist/engine/checks/security-scan.js');
const { LocalRoutingStore } = await import('../dist/engine/deployments/routing-store.js');
const { LocalStorage } = await import('../dist/engine/storage/storage.js');
const { rollBackTarget } = await import('../dist/engine/deployments/routing.service.js');
const { withConfigInShell } = await import('../dist/engine/deployments/build.js');

const DEPLOYMENT = '0f9c2a52-7a3e-4b8e-9d55-3c8f0e2b1a11';
const source = await readFile(path.join(here, '../edge/router.js'), 'utf8');
const values = new Map([['live:northside', `northside/${DEPLOYMENT}`]]);
const router = loadRouter({ get: async key => values.get(key) ?? null }, source);
const route = (uri, host = 'northside.endofszn.com', extra = {}) => router({ request: { uri, headers: { host: { value: host }, ...extra } } });

test('a host with a live deployment is rewritten to its files', async () => {
  assert.equal((await route('/')).uri, `/d/northside/${DEPLOYMENT}/index.html`);
  assert.equal((await route('/products/tee')).uri, `/d/northside/${DEPLOYMENT}/products/tee/index.html`);
  assert.equal((await route('/products/tee/')).uri, `/d/northside/${DEPLOYMENT}/products/tee/index.html`);
  assert.equal((await route('/assets/root-abc.js')).uri, `/d/northside/${DEPLOYMENT}/assets/root-abc.js`);
  assert.equal((await route('/products/tee.data')).uri, `/d/northside/${DEPLOYMENT}/products/tee.data`);
  assert.equal((await route('/sitemap.xml', 'northside.localhost:4400')).uri, `/d/northside/${DEPLOYMENT}/sitemap.xml`);
});

test('hosts without a deployment keep the web app', async () => {
  assert.equal((await route('/products/tee', 'other.endofszn.com')).uri, '/index.html');
  assert.equal((await route('/assets/index-1.js', 'checkout.endofszn.com')).uri, '/assets/index-1.js');
});

test("deployment files can't be fetched directly from any host", async () => {
  assert.equal((await route(`/d/northside/${DEPLOYMENT}/index.html`, 'checkout.endofszn.com')).statusCode, 404);
  assert.equal((await route('/d/northside', 'northside.endofszn.com')).statusCode, 404);
  assert.equal((await route('/_preview/index.html', 'northside.endofszn.com')).statusCode, 404);
});

test('the preview host serves the preview runtime and design files', async () => {
  assert.equal((await route('/d/design/token/products/tee', 'preview.endofszn.com')).uri, '/_preview/index.html');
  assert.equal((await route('/_preview/_runtime/main.js', 'preview.endofszn.com')).uri, '/_preview/_runtime/main.js');
  const referer = { referer: { value: 'https://preview.endofszn.com/d/design/tok123/products/tee' } };
  assert.equal((await route('/logo.svg', 'preview.endofszn.com', referer)).uri, '/_studio/preview/tok123/files/public/logo.svg');
});

const html = ({ title = 'Tee', description = 'Soft', canonical = 'https://northside.endofszn.com/products/tee', jsonLd = true, noindex = false } = {}) =>
  `<html><head><title>${title}</title>${description ? `<meta name="description" content="${description}"/>` : ''}${canonical ? `<link rel="canonical" href="${canonical}"/>` : ''}${noindex ? '<meta name="robots" content="noindex"/>' : ''}</head><body>${jsonLd ? '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script>' : ''}</body></html>`;

test('the SEO review needs titles, canonical URLs, product JSON-LD and the app shell', () => {
  const good = new Map([
    ['index.html', Buffer.from(html())],
    ['products/tee/index.html', Buffer.from(html())],
    ['cart/index.html', Buffer.from(html({ canonical: '', noindex: true }))],
    ['__spa-fallback.html', Buffer.from('<html></html>')],
  ]);
  const review = seoReview(good, { canonical: true });
  assert.deepEqual(review.problems, []);
  assert.deepEqual(review.indexable, ['/', '/products/tee']);
  const bad = new Map([['products/tee/index.html', Buffer.from(html({ title: '', canonical: '', jsonLd: false, description: '' }))]]);
  const problems = seoReview(bad, { canonical: true }).problems.map(finding => finding.problem);
  assert.deepEqual(problems.sort(), ['has no app shell for pages that aren\'t rendered yet', 'has no canonical URL', 'has no product JSON-LD', 'has no title'].sort());
  assert.equal(seoReview(bad, { canonical: false }).warnings.some(finding => finding.problem.startsWith('has no canonical URL')), true);
  assert.match(sitemapXml('https://a.example', ['/', '/pages/a&b']), /<loc>https:\/\/a\.example\/pages\/a&amp;b<\/loc>/);
  assert.deepEqual(pageFilesOf('/products/tee'), ['products/tee/index.html', 'products/tee.data']);
});

test('the security scan finds eval, raw HTML, cookies and injected scripts in the design only', () => {
  const files = new Map([
    ['app/blocks/hero.tsx', Buffer.from('const a = 1;\n<div dangerouslySetInnerHTML={{ __html: x }} />\n')],
    ['app/lib/track.ts', Buffer.from('document.cookie = "a=b";\nconst s = document.createElement("script");\neval("1");\n')],
    ['node_modules/x/index.js', Buffer.from('eval("1")')],
    ['STOREFRONT.md', Buffer.from('never use eval()')],
  ]);
  const found = securityScan(files).map(finding => `${finding.file}:${finding.line}:${finding.rule}`);
  assert.deepEqual(found, ['app/blocks/hero.tsx:2:raw-html', 'app/lib/track.ts:1:cookies', 'app/lib/track.ts:2:script-injection', 'app/lib/track.ts:3:eval']);
});

test('missing pages get the app shell and missing files a 404', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'studio-deploy-'));
  try {
    const storage = new LocalStorage(dir);
    await storage.put(`d/northside/${DEPLOYMENT}/__spa-fallback.html`, '<html>shell</html>');
    await storage.put(`d/northside/${DEPLOYMENT}/products/tee/index.html`, '<html>tee</html>');
    assert.equal((await deploymentFile(storage, `/d/northside/${DEPLOYMENT}/products/tee/index.html`)).body.toString(), '<html>tee</html>');
    const shell = await deploymentFile(storage, `/d/northside/${DEPLOYMENT}/products/new/index.html`);
    assert.equal(shell.body.toString(), '<html>shell</html>');
    assert.match(shell.cache, /s-maxage=60/);
    assert.equal(await deploymentFile(storage, `/d/northside/${DEPLOYMENT}/assets/missing.js`), null);
    assert.equal(await deploymentFile(storage, `/d/northside/not-a-deployment/index.html`), null);
    const routes = new LocalRoutingStore(path.join(dir, 'routing.json'));
    await routes.put('live:northside', 'northside/x');
    assert.equal(await routes.get('live:northside'), 'northside/x');
    await routes.delete('live:northside');
    assert.equal(await routes.get('live:northside'), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rolling back returns to what was live before, the standard storefront included', () => {
  assert.equal(rollBackTarget([]), undefined);
  assert.equal(rollBackTarget(['a']), null);
  assert.equal(rollBackTarget(['b', 'a']), 'a');
  assert.equal(rollBackTarget([null, 'a']), 'a');
  assert.equal(rollBackTarget(['a', null, 'a']), null);
  assert.equal(rollBackTarget([null]), undefined);
});

test("the app shell gets the store's config from a rendered page", () => {
  const meta = '<meta name="studio-config" content="{&quot;store&quot;:&quot;north&quot;}"/>';
  const files = new Map([
    ['__spa-fallback.html', Buffer.from('<!DOCTYPE html><html><head><title>x</title></head></html>')],
    ['index.html', Buffer.from(`<html><head>${meta}</head></html>`)],
  ]);
  withConfigInShell(files);
  assert.equal(files.get('__spa-fallback.html').toString(), `<!DOCTYPE html><html><head>${meta}<title>x</title></head></html>`);
});
