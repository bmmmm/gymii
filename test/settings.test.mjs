// Logic-level test for the Settings "Sync" card (M1, docs/sync-plan.md):
// the demo gym never gets one, turning sync on shows the sync code exactly
// once, a malformed code becomes a readable line instead of an uncaught
// rejection, and turning sync off drops the credentials but not the data.
// The network is stubbed at `fetch` (the real js/sync.js runs, WebCrypto
// included) — stubbing the module would only pin the test against itself.
// Run with: node test/settings.test.mjs
import { strict as assert } from 'node:assert';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

// --- the fake blob server (docs/sync-protocol.md): 404 until the first PUT ---

const server = { blob: null, revision: 0, mode: null };
const response = (status, body, revision) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: {
    get: (n) => (n.toLowerCase() === 'etag' && revision != null ? `"${revision}"` : null),
  },
  json: async () => JSON.parse(JSON.stringify(body)),
});
globalThis.fetch = async (url, opts = {}) => {
  if (server.mode === 'offline') throw new TypeError('fetch failed');
  const method = opts.method ?? 'GET';
  if (method === 'GET') {
    return server.blob ? response(200, server.blob, server.revision) : response(404);
  }
  if (method === 'PUT') {
    server.blob = JSON.parse(opts.body);
    server.revision += 1;
    return response(200, null, server.revision);
  }
  return response(405);
};

// The clipboard is a permission, not a given — both outcomes are UI states.
let clipboard = { text: null, fail: false };
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: {
    writeText: async (t) => {
      if (clipboard.fail) throw new Error('blocked');
      clipboard.text = t;
    },
  },
});

const store = await import(new URL('../js/store.js', import.meta.url).href);
const { renderSettings } = await import(new URL('../js/settings.js', import.meta.url).href);

// --- DOM stubs: stable per selector, stateful classList for the two-tap ---
// The stub answers EVERY selector, rendered or not (AGENTS.md), so every
// assertion below is against the rendered HTML or an element's own state.

const classListStub = () => {
  const set = new Set();
  return {
    add: (c) => set.add(c), remove: (c) => set.delete(c),
    toggle: () => {}, contains: (c) => set.has(c),
  };
};
const stubEl = () => ({
  innerHTML: '', value: '', textContent: '', disabled: false, dataset: {}, listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  classList: classListStub(),
});
const byId = new Map();
const root = {
  innerHTML: '',
  querySelector(sel) {
    if (!byId.has(sel)) byId.set(sel, stubEl());
    return byId.get(sel);
  },
  querySelectorAll: () => [],
};

// --- fixture: one real gym with a machine and a workout worth keeping ---

const layout = store.newLayout('Home gym');
layout.machines.push({
  id: 'm1', num: 1, label: 'Chest press', x: 0, y: 0, w: 4, h: 3, settingsFields: [], muscles: ['Chest'],
});
store.saveLayout(layout);
store.saveWorkouts([{
  id: 'w1',
  startedAt: 1000,
  finishedAt: 2000,
  entries: [{
    machineId: 'm1', num: 1, label: 'Chest press', settings: {}, sets: [{ reps: 10, weight: 40 }],
  }],
}]);
const realId = store.getGyms().activeId;

// --- the demo gym never syncs (sync-plan decision 10) ---

const demoId = store.createGym('Demo', { demo: true }); // createGym also activates it
renderSettings(root);
assert.ok(!root.innerHTML.includes('<h2>Sync</h2>'),
  'the demo gym gets no Sync card at all');
assert.ok(root.innerHTML.includes('<h2>Templates &amp; data</h2>'),
  'the rest of Settings still renders for the demo gym');
assert.equal(store.getSyncConfig(demoId), null);

store.setActiveGym(realId);
renderSettings(root);
assert.ok(root.innerHTML.includes('<h2>Sync</h2>'), 'a real gym gets the card');
assert.ok(root.innerHTML.includes('Turn on sync'), 'and it starts in the unconfigured state');
assert.ok(!root.innerHTML.includes('class="synccode"'),
  'no key on screen before there is one');
assert.match(root.innerHTML, /there is no recovery/,
  'the intro says plainly that a lost code cannot be recovered');
assert.ok(!root.innerHTML.includes('only key to this gym'),
  'the warning that belongs beside the code is not on an empty form');

// --- the footnote stays true now that sync exists ---

assert.ok(root.innerHTML.includes('unless you turn on sync'),
  'the footnote qualifies the local-only claim');
assert.ok(!root.innerHTML.includes('in this browser only'),
  'the unconditional "browser only" claim is gone');

// --- pairing: a malformed code is a message, never an uncaught rejection ---

const pairBtn = root.querySelector('#sync-pair');
root.querySelector('#sync-code').value = '   ';
await pairBtn.listeners.click();
assert.match(root.querySelector('#sync-msg').textContent, /Paste the sync code/,
  'an empty field asks for the code instead of calling the module');

root.querySelector('#sync-code').value = 'gymii-sync:v0:nope';
await pairBtn.listeners.click();
assert.match(root.querySelector('#sync-msg').textContent, /not a gymii sync code/,
  'bad-code surfaces as readable copy');
assert.equal(pairBtn.disabled, false, 'the button is usable again after the failure');
assert.equal(store.getSyncConfig(realId), null, 'a bad code configures nothing');
assert.ok(!root.innerHTML.includes('class="synccode"'), 'and mints no key');

// --- turning sync on: the code is shown, exactly once ---

root.querySelector('#sync-server').value = 'https://sync.example.org';
root.querySelector('#sync-token').value = 'account-token';
await root.querySelector('#sync-enable').listeners.click();

assert.ok(store.getSyncConfig(realId), 'sync is configured');
assert.equal(server.revision, 1, 'the first blob was pushed');
const codeMatch = /class="synccode">(gymii-sync:v1:[A-Za-z0-9_-]+)</.exec(root.innerHTML);
assert.ok(codeMatch, 'the sync code is rendered verbatim in the monospace block');
assert.ok(root.innerHTML.includes('Copy sync code'), 'with a Copy button');
assert.ok(root.innerHTML.includes('only key to this gym'),
  'and the no-recovery warning right next to it');
assert.equal(root.querySelector('#sync-msg').textContent, 'Sync is on. Synced.');
assert.ok(root.innerHTML.includes('https://sync.example.org'), 'the card names the server');
assert.ok(root.innerHTML.includes('Last sync'), 'and when it last ran');
assert.ok(!root.innerHTML.includes('>never<'), 'which is not "never" after a successful push');

// --- the copy button, both outcomes ---

const copyBtn = root.querySelector('#sync-copy');
await copyBtn.listeners.click();
assert.equal(clipboard.text, codeMatch[1], 'Copy puts the whole code on the clipboard');
assert.equal(root.querySelector('#sync-msg').textContent, 'Sync code copied.');
clipboard = { text: null, fail: true };
await copyBtn.listeners.click();
assert.match(root.querySelector('#sync-msg').textContent, /Clipboard blocked/,
  'a blocked clipboard says so instead of failing silently');

// --- exactly once: any later render takes the key back off the screen ---

renderSettings(root);
assert.ok(!root.innerHTML.includes('class="synccode"'),
  'a plain render never reads the key back out of storage');
assert.ok(root.innerHTML.includes('Show sync code'), 'it is reachable behind one extra tap');

root.querySelector('#sync-show-code').listeners.click();
const revealed = /class="synccode">(gymii-sync:v1:[A-Za-z0-9_-]+)</.exec(root.innerHTML);
assert.ok(revealed, 'the extra tap reveals it again');
assert.equal(revealed[1], codeMatch[1], 'and it is the same code');

// --- "Sync now": disabled while running, result into the status line ---

server.mode = 'offline';
const nowBtn = root.querySelector('#sync-now');
nowBtn.disabled = false;
const running = nowBtn.listeners.click();
assert.equal(nowBtn.disabled, true, 'the button is disabled while the round trip runs');
await running;
assert.match(root.querySelector('#sync-msg').textContent, /^Offline/,
  'a dead network reads as offline, not as an error');
assert.ok(root.innerHTML.includes('Last error'), 'the failure is on the card, not only in the line');
server.mode = null;

// --- turning sync off: two taps, credentials only ---

const offBtn = root.querySelector('#sync-off');
offBtn.listeners.click();
assert.match(offBtn.textContent, /your data stays here/,
  'the confirm label says what is NOT deleted');
assert.ok(store.getSyncConfig(realId), 'the first tap only arms');

offBtn.listeners.click();
assert.equal(store.getSyncConfig(realId), null, 'the sync config is gone');
assert.equal(store.getSyncKey(realId), null, 'and so is the key');
assert.equal(store.getWorkouts().length, 1, 'the workout stayed');
assert.equal(store.getLayout().machines.length, 1, 'and so did the floor plan');
assert.ok(root.innerHTML.includes('Turn on sync'), 'the card is back in its unconfigured state');
assert.ok(!root.innerHTML.includes('Sync now'), 'with nothing left to sync');
assert.ok(!root.innerHTML.includes('class="synccode"'), 'and no key on screen');

console.log('settings sync card: all assertions passed');
