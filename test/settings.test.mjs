// Logic-level test for the Settings "Sync" card (M1, docs/sync-plan.md):
// the demo gym never gets one, turning sync on shows the sync code exactly
// once, a malformed code becomes a readable line instead of an uncaught
// rejection, and turning sync off drops the credentials but not the data.
// The network is stubbed at `fetch` (the real js/sync.js runs, WebCrypto
// included) — stubbing the module would only pin the test against itself.
// Run with: node test/settings.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';

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
  // M3 token API — armed by setting server.tokens ([{token, hash, ...}])
  if (server.tokens && url.includes('/v1/tokens')) {
    if (method === 'GET') {
      const auth = opts.headers?.Authorization ?? '';
      return response(200, server.tokens.map(({ token, ...rest }) => ({
        ...rest, self: auth === `Bearer ${token}`,
      })));
    }
    if (method === 'POST') {
      const n = server.tokens.length + 1;
      const t = {
        token: `minted-${n}`,
        hash: '0'.repeat(60) + String(n).padStart(4, '0'),
        mintedAt: '2026-08-31T00:00:00Z',
        name: JSON.parse(opts.body || '{}').name ?? '',
      };
      server.tokens.push(t);
      const { token, ...rest } = t;
      return response(201, { token, ...rest });
    }
    if (method === 'DELETE') {
      const hash = url.split('/v1/tokens/')[1];
      const idx = server.tokens.findIndex((t) => t.hash === hash);
      if (idx === -1) return response(404);
      if (server.tokens.length === 1) return response(409);
      server.tokens.splice(idx, 1);
      return response(204);
    }
  }
  if (server.tokens && method === 'GET' && url.endsWith('/v1/gyms')) {
    return response(200, server.blob
      ? [{ gymId: server.blob.gymId, revision: server.revision, updatedAt: 'x' }] : []);
  }
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
const { renderSettings, setPendingPairCode } = await import(new URL('../js/settings.js', import.meta.url).href);

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
const stubEl = () => {
  // memoised like root's, so a handler attached to a nested element is
  // still there when the test looks the element up again
  const kids = new Map();
  return {
    innerHTML: '', value: '', textContent: '', disabled: false, dataset: {}, listeners: {},
    addEventListener(type, fn) { this.listeners[type] = fn; },
    querySelector(sel) {
      if (!kids.has(sel)) kids.set(sel, stubEl());
      return kids.get(sel);
    },
    querySelectorAll: () => [],
    classList: classListStub(),
  };
};
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

// --- and it says which build is installed ---
// The date is matched by shape, not by value: pinning the literal would turn
// every deploy's bump into a failing test instead of a passing one.
assert.match(root.innerHTML, /Version \d{4}-\d{2}-\d{2}/,
  'Settings names the installed version');

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

// --- the unencrypted variant renders only where the browser cannot encrypt ---
// (plain-http docker-net setups: crypto.subtle is missing there, and the
// card must name the trade instead of hiding it — sync-plan decision 15)

server.blob = null;
server.revision = 0;
store.setActiveGym(realId);
const realCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { getRandomValues: realCrypto.getRandomValues.bind(realCrypto) },
});
try {
  renderSettings(root);
  assert.ok(root.innerHTML.includes('Turn on unencrypted sync'),
    'the insecure page names the trade on the button itself');
  assert.match(root.innerHTML, /refuses to\s+encrypt/, 'and says why encryption is off the table');

  root.querySelector('#sync-server').value = 'http://box:8639';
  root.querySelector('#sync-token').value = 'tok-plain';
  await root.querySelector('#sync-enable').listeners.click();
  assert.ok(server.blob && !server.blob.ciphertext && server.blob.plain,
    'the pushed envelope is the readable payload, not ciphertext');
  assert.match(root.innerHTML, /Unencrypted — the server stores this gym readably/,
    'the configured card states the mode');
  assert.match(root.innerHTML, /read and change/,
    'the code warning warns about access — there is no key to warn about');
} finally {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: realCrypto });
}

// --- M3: pair-another-device (QR), devices list, discovery, #pair handoff ---

// fresh E2E setup with the token API armed
store.setActiveGym(realId);
store.saveSyncConfig(realId, null);
store.saveSyncKey(realId, null);
server.blob = null;
server.revision = 0;
server.tokens = [{
  token: 'tok-m3', hash: 'b'.repeat(64), mintedAt: '2026-08-30T00:00:00Z', name: 'first',
}];
renderSettings(root);
root.querySelector('#sync-server').value = 'sync.example.org';
root.querySelector('#sync-token').value = 'tok-m3';
await root.querySelector('#sync-enable').listeners.click();
assert.ok(root.innerHTML.includes('Pair another device'), 'm3: configured card offers pairing');
assert.ok(root.innerHTML.includes('Other gyms on this server'), 'm3: and discovery');

// minting shows QR + code once; the code carries the FRESH token
await root.querySelector('#sync-pair-new').listeners.click();
assert.ok(root.innerHTML.includes('sync-qr') && root.innerHTML.includes('<svg'),
  'm3: the pairing code renders as a QR');
const mintedCode = JSON.parse(Buffer.from(
  root.innerHTML.match(/gymii-sync:v1:([A-Za-z0-9_-]+)/)[1], 'base64url').toString());
assert.equal(mintedCode.token, 'minted-2', 'm3: the QR code carries the fresh token');
renderSettings(root);
assert.ok(!root.innerHTML.includes('sync-qr'), 'm3: shown once — the next render clears it');

// devices list marks this device and loads on open
const devicesEl = root.querySelector('#sync-devices');
devicesEl.open = true;
await devicesEl.listeners.toggle();
const devicesHtml = root.querySelector('#sync-devices-body').innerHTML;
assert.ok(devicesHtml.includes('first · this device'), 'm3: self is marked');
assert.ok(devicesHtml.includes('data-revoke'), 'm3: other devices get a revoke button');

// discovery: nothing foreign on the server → says so honestly
const discoverEl = root.querySelector('#sync-discover');
discoverEl.open = true;
await discoverEl.listeners.toggle();
assert.ok(root.querySelector('#sync-discover-body').innerHTML.includes('already on this device'),
  'm3: an all-known server reads as done, not empty');

// #pair handoff: configured gym says why it cannot pair; unconfigured prefills
setPendingPairCode('gymii-sync:v1:handoff');
renderSettings(root);
assert.ok(root.querySelector('#sync-msg').textContent.includes('already syncs'),
  'm3: a configured gym explains instead of failing');
store.saveSyncConfig(realId, null);
store.saveSyncKey(realId, null);
setPendingPairCode('gymii-sync:v1:handoff');
renderSettings(root);
assert.equal(root.querySelector('#sync-code').value, 'gymii-sync:v1:handoff',
  'm3: an unconfigured gym prefills the pairing field');
assert.ok(root.querySelector('#sync-msg').textContent.includes('tap Pair'),
  'm3: and never auto-pairs');

// --- the Storage card ---
// A microtask flush: the card paints synchronously from the last known
// answer, then repaints once the Storage API has replied.
const settled = () => new Promise((r) => setTimeout(r, 0));
const storageBody = () => root.querySelector('#storage-body').innerHTML;

// 1. a browser without the API at all — Node is one, and so is a locked-down
//    private window. The card still renders, and Settings survives.
renderSettings(root);
await settled();
assert.ok(root.innerHTML.includes('<h2>Storage</h2>'), 'the card is there');
assert.match(storageBody(), /gymii is using <strong>\d+/,
  'and leads with the one number the localStorage limit actually applies to');
assert.ok(storageBody().includes('Home Screen'),
  'with no API to ask, the honest advice is the only thing said');
assert.ok(!storageBody().includes('id="storage-persist"'),
  'and no button that could not do anything');
assert.ok(root.innerHTML.includes('<h2>Templates &amp; data</h2>'),
  'the rest of Settings is untouched by a browser that cannot answer');

const installStorage = (value) => Object.defineProperty(globalThis.navigator, 'storage', {
  configurable: true, value,
});

// 2. already persistent: report it, and do not offer a button for it
installStorage({ persisted: async () => true, persist: async () => true });
renderSettings(root);
await settled();
assert.ok(storageBody().includes('marked the data as persistent'), 'it says so');
assert.ok(!storageBody().includes('id="storage-persist"'), 'and asks for nothing');
assert.ok(storageBody().includes('backup'),
  'persistent is not the same as backed up, and the copy says which');

// 3. not persistent: the ask, the reason, and the whole-origin figure beside
//    gymii's own — neither number alone tells the truth
installStorage({
  persisted: async () => false,
  persist: async () => false,
  estimate: async () => ({ usage: 3 * 1048576, quota: 2 * 1073741824 }),
});
renderSettings(root);
await settled();
assert.ok(storageBody().includes('id="storage-persist"'), 'the ask is offered');
assert.ok(storageBody().includes('seven days'), 'with the concrete reason, once');
assert.ok(storageBody().includes('3.0 MB') && storageBody().includes('2.0 GB'),
  "the browser's own estimate stands beside gymii's count");

// 4. a browser that refuses says so — a button that silently does nothing
//    would be worse than none
await root.querySelector('#storage-body').querySelector('#storage-persist').listeners.click();
assert.ok(storageBody().includes('did not grant it'), 'the refusal is reported');
assert.ok(storageBody().includes('id="storage-persist"'),
  'and the button stays, because a later attempt can still succeed');

console.log('settings sync card: all assertions passed');
