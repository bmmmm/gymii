// The service worker under test: the REAL sw.js runs inside a vm context
// whose globals are all fakes this file owns — caches, fetch, Response and
// the clock. Owning setTimeout is the point: the worker's timers never
// actually wait, the test fires them, so seconds of behaviour are proven in
// microseconds.
// Run with: node test/sw.test.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://gym.example';

// The one object `Response.error()` ever returns, so a test can assert
// identity instead of guessing at a shape.
const NETWORK_ERROR = { networkError: true };

// ------------------------------------------------------------- harness

// A response the worker can pass around: `ok` gates the caching branch and
// `clone()` hands back one stable copy, so the test can prove the CLONE
// (not the body the page reads) is what lands in the cache.
function makeResponse(label, { ok = true } = {}) {
  const copy = { label: `${label}#copy` };
  return { label, ok, copy, clone: () => copy };
}

// A fresh worker per scenario — no state leaks between the branches.
function loadWorker() {
  const listeners = new Map();
  const timers = [];       // every setTimeout the worker asked for
  const puts = [];         // every cache.put that actually happened
  const hits = new Map();  // url -> the response the fake cache holds
  let onFetch = () => Promise.reject(new Error('the test configured no network'));

  const cache = {
    addAll: () => Promise.resolve(),
    put: (req, res) => { puts.push({ req, res }); return Promise.resolve(); },
  };
  const sandbox = {
    // host intrinsics, so promises and URLs crossing the boundary stay
    // the ones this file can reason about
    Promise, URL,
    self: {
      addEventListener: (type, fn) => { listeners.set(type, fn); },
      skipWaiting: () => {},
      clients: { claim: () => Promise.resolve() },
    },
    location: { origin: ORIGIN },
    caches: {
      open: () => Promise.resolve(cache),
      match: (req) => Promise.resolve(hits.get(req.url)),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    fetch: (req) => onFetch(req),
    Response: { error: () => NETWORK_ERROR },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
  vm.runInContext(SRC, vm.createContext(sandbox), { filename: 'sw.js' });
  assert.ok(listeners.has('fetch'), 'sw.js registers a fetch listener');

  return {
    timers,
    puts,
    hits,
    network: (fn) => { onFetch = fn; },
    dispatch: (e) => { listeners.get('fetch')(e); return e; },
  };
}

// A FetchEvent stand-in that records what the worker did with it.
function fetchEvent(url, method = 'GET') {
  return {
    request: { url, method },
    answers: [],   // respondWith arguments
    waits: [],     // waitUntil arguments
    respondWith(p) { this.answers.push(p); },
    waitUntil(p) { this.waits.push(p); },
  };
}

// Let every pending microtask (and the odd macrotask) run.
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

// ------------------------------------------------- what stays untouched

// A POST is the browser's business — the worker must not answer it.
{
  const w = loadWorker();
  const e = w.dispatch(fetchEvent(`${ORIGIN}/api/log`, 'POST'));
  assert.equal(e.answers.length, 0, 'a non-GET request is left to the browser');
}

// Same for anything off our own origin: a CDN or an API elsewhere must not
// end up in the app shell cache.
{
  const w = loadWorker();
  const e = w.dispatch(fetchEvent('https://cdn.example/lib.js'));
  assert.equal(e.answers.length, 0, 'a cross-origin request is left to the browser');
}

// ------------------------------------------------------------- online

// An ok response is handed to the page as-is and its clone is cached.
{
  const w = loadWorker();
  const res = makeResponse('fresh');
  w.network(() => Promise.resolve(res));
  const e = w.dispatch(fetchEvent(`${ORIGIN}/js/app.js`));

  assert.equal(e.answers.length, 1, 'the worker answers a same-origin GET');
  assert.equal(await e.answers[0], res, 'the page gets the network response itself');
  await flush();
  assert.equal(w.puts.length, 1, 'an ok response is cached');
  assert.equal(w.puts[0].req, e.request, 'cached under the request that was asked for');
  assert.equal(w.puts[0].res, res.copy, 'the CLONE is cached, not the body the page reads');
}

// A 404 still reaches the page, but must never overwrite a good cache entry.
{
  const w = loadWorker();
  const res = makeResponse('missing', { ok: false });
  w.network(() => Promise.resolve(res));
  const e = w.dispatch(fetchEvent(`${ORIGIN}/js/gone.js`));

  assert.equal(await e.answers[0], res, 'a non-ok response reaches the page');
  await flush();
  assert.equal(w.puts.length, 0, 'a non-ok response is not cached');
}

// ------------------------------------------------------------- offline

// Network down, but we have been here before: serve the cached copy.
{
  const w = loadWorker();
  const url = `${ORIGIN}/js/train.js`;
  const hit = makeResponse('cached');
  w.hits.set(url, hit);
  w.network(() => Promise.reject(new Error('offline')));
  const e = w.dispatch(fetchEvent(url));

  assert.equal(await e.answers[0], hit, 'a failed fetch falls back to the cache');
  await flush();
  assert.equal(w.puts.length, 0, 'nothing is written when the network never answered');
}

// Network down and never cached: respondWith(undefined) throws inside the
// worker, so this has to be a real network error.
{
  const w = loadWorker();
  w.network(() => Promise.reject(new Error('offline')));
  const e = w.dispatch(fetchEvent(`${ORIGIN}/never/seen.json`));

  assert.equal(await e.answers[0], NETWORK_ERROR,
    'an uncached miss on a dead network answers with Response.error()');
}

console.log('sw: all assertions passed');
