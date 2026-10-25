import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AgentCoreBrowserProvider, LocalChromiumProvider } from '../../dist/engine/browser/providers.js';
import { config } from '../../dist/engine/config.js';

const provider = config.browsers === 'agentcore' ? new AgentCoreBrowserProvider() : new LocalChromiumProvider();
const AGENT_TAB = `data:text/html;base64,${Buffer.from('<title>Agent tab</title><h1>Made in small runs</h1>').toString('base64')}`;
const until = async (probe, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await probe()) return true;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return false;
};

let started;
const connect = () => provider.connect(started.id, started.endpoint);

before(async () => {
  started = await provider.start('studio-contract');
});

after(async () => {
  if (started) await provider.stop(started.id, started.endpoint);
});

test('a started browser is alive and renders pages', async () => {
  assert.equal(await provider.alive(started.id, started.endpoint), true);
  const browser = await connect();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main><h1>Made in small runs</h1><button>Add to cart</button></main>');
    assert.equal(await page.locator('h1').textContent(), 'Made in small runs');
    assert.equal(await page.getByRole('button', { name: 'Add to cart' }).count(), 1);
    assert.equal(await page.evaluate(() => window.innerWidth), 390);
    const shot = await page.screenshot();
    assert.equal(shot.subarray(1, 4).toString(), 'PNG');
  } finally {
    await browser.close();
  }
});

test("closing one connection leaves another connection's pages working", async () => {
  const first = await connect();
  const second = await connect();
  try {
    const page = await (await second.newContext()).newPage();
    await page.setContent('<p>Still checking</p>');
    await (await first.newContext()).newPage();
    await first.close();
    assert.equal(await page.locator('p').textContent(), 'Still checking');
    assert.equal(await provider.alive(started.id, started.endpoint), true);
  } finally {
    await second.close();
  }
});

test('a page in the default context is still there after reconnecting', async () => {
  const first = await connect();
  const page = await (first.contexts()[0] ?? (await first.newContext())).newPage();
  await page.goto(AGENT_TAB);
  await first.close();

  const second = await connect();
  try {
    const found = second.contexts()[0]?.pages().find(candidate => candidate.url() === AGENT_TAB);
    assert.ok(found, 'the agent tab should survive the first connection');
    assert.equal(await found.title(), 'Agent tab');
    await found.close();
  } finally {
    await second.close();
  }
});

test('a stopped browser is no longer alive', async () => {
  await provider.stop(started.id, started.endpoint);
  assert.ok(await until(async () => !(await provider.alive(started.id, started.endpoint))));
  started = null;
});
