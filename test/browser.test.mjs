import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserSessions } from '../dist/engine/browser/browser-sessions.service.js';
import { stableTarget } from '../dist/engine/browser/flows.js';
import { formatOutline, outlineChanges, parseSnapshot } from '../dist/engine/browser/page-outline.js';
import { withoutTokens } from '../dist/engine/terminal/output.js';

const base = '/d/3f2a/eyJkIjoiMSJ9.c2lnbmF0dXJl';
const snapshot = `- generic [ref=e3] [box=0,0,390,2694]:
  - banner [ref=e5] [box=0,0,390,65]:
    - button "Open menu" [ref=e7] [box=12,14,36,36]:
      - img [ref=e8] [box=20,22,20,20]
    - button "Cart, 0 items" [ref=e10] [box=334,14,36,36]
  - main [ref=e14] [box=0,65,390,2360]:
    - heading "Made in small runs" [level=1] [ref=e18] [box=20,197,350,120]
    - link "Shop new arrivals" [ref=e20] [cursor=pointer] [box=20,437,165,44]:
      - /url: ${base}/collections/new-arrivals
    - generic [ref=e21] [box=0,877,390,558]:
      - heading "New arrivals" [level=2] [ref=e23] [box=20,941,119,32]
      - list [ref=e25] [box=0,1005,390,366]:
        - listitem [ref=e26] [box=0,1005,245,358]:
          - link "Washed Logo Tee $42.00" [ref=e27] [cursor=pointer] [box=0,1005,245,358]:
            - /url: ${base}/products/washed-logo-tee
        - listitem [ref=e32] [box=261,1005,245,358]:
          - link "Zip Fleece Jacket $110.00" [ref=e33] [cursor=pointer] [box=261,1005,245,358]:
            - /url: ${base}/products/zip-fleece-jacket
      - checkbox "Gift wrap" [checked] [ref=e40] [box=20,1400,20,20]`;

test('the AI snapshot becomes an outline with refs, levels, states, paths and where the screen ends', () => {
  const nodes = parseSnapshot(snapshot, base);
  const text = formatOutline({ nodes, viewport: { width: 390, height: 844 }, modal: false }, 'phone');
  assert.match(text, /^e5 banner\ne7 button "Open menu"/);
  assert.match(text, /e18 heading h1 "Made in small runs"/);
  assert.match(text, /e20 link "Shop new arrivals" → \/collections\/new-arrivals\n--- end of the screen on this phone ---\ne23 heading h2 "New arrivals"/);
  assert.match(text, /e40 checkbox "Gift wrap" \[checked\]/);
  assert.doesNotMatch(text, /eyJ/);
  assert.doesNotMatch(text, /e8 img/);
});

test('each node knows its section, so catalog links save as positions in it', () => {
  const nodes = parseSnapshot(snapshot, base);
  const tee = nodes.find(node => node.ref === 'e27');
  assert.ok(tee.context.includes('New arrivals'));
  assert.deepEqual(stableTarget(tee, nodes), { role: 'link', within: 'New arrivals', nth: 0 });
  const menu = nodes.find(node => node.ref === 'e7');
  assert.deepEqual(stableTarget(menu, nodes), { role: 'button', name: 'Open menu' });
});

test('changes name what opened, appeared or went away, and a dialog is summarised on its own', () => {
  const before = { nodes: parseSnapshot(snapshot, base), viewport: { width: 390, height: 844 }, modal: false };
  const after = { ...before, nodes: parseSnapshot(snapshot.replace('"Cart, 0 items"', '"Cart, 1 item"'), base) };
  assert.deepEqual(outlineChanges(before, after), ['new: e10 button "Cart, 1 item"', 'gone: button "Cart, 0 items"']);
  const dialog = { nodes: parseSnapshot('- dialog "Your cart" [ref=e60] [box=0,0,390,844]:\n  - button "Checkout" [ref=e61] [box=20,700,350,44]', base), viewport: before.viewport, modal: true };
  assert.deepEqual(outlineChanges(before, dialog), ['dialog "Your cart" opened with e61 button "Checkout"']);
  assert.deepEqual(outlineChanges(dialog, before), ['the dialog closed']);
});

test('preview tokens never reach the agent', () => {
  const token = 'eyJkIjoiNDRkNTViZTMtYmYzOS00YTNhLTgwNmEtNzEwNjBmMzQ5NzFhIn0.uL4mo2VwgWoZYEtTJdCmOcH45_l46T_Yj6kxusmPxHo';
  assert.equal(withoutTokens(`net::ERR at http://preview.localhost:4300/d/44d5/${token}/products/x`), 'net::ERR at http://preview.localhost:4300/d/44d5/<preview>/products/x');
  assert.equal(withoutTokens(`GET /_studio/check/${token}/assets/a.js`), 'GET /_studio/check/<preview>/assets/a.js');
  assert.equal(withoutTokens('plain output'), 'plain output');
});

test('a page that fails to open rejects for its caller and leaves nothing unhandled to stop the process', async () => {
  const sessions = Object.create(BrowserSessions.prototype);
  sessions.queues = new Map();
  sessions.agentPage = async () => {
    throw new Error("browserType.launch: Executable doesn't exist");
  };
  const unhandled = [];
  const listen = reason => unhandled.push(reason);
  process.on('unhandledRejection', listen);
  try {
    await assert.rejects(sessions.withAgentPage({}, { id: 'draft-1' }, {}, async () => 'drawn'), /Executable doesn't exist/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.equal(sessions.queues.size, 0);
  } finally {
    process.off('unhandledRejection', listen);
  }
});
