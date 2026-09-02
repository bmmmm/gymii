// Validation gate for the community template library: every entry in
// templates/index.json must point at a real, valid, importable gym
// template, and every template file must be listed — a broken PR goes
// red here instead of breaking the library for everyone.
// Run with: node test/templates.test.mjs
import './helpers/localstorage.mjs'; // FIRST: installs the stub
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';

const store = await import(new URL('../js/store.js', import.meta.url).href);

const dir = new URL('../templates/', import.meta.url);
const idx = JSON.parse(readFileSync(new URL('index.json', dir), 'utf8'));
assert.equal(idx.v, 1, 'manifest version is 1');
assert.ok(Array.isArray(idx.templates) && idx.templates.length, 'manifest lists templates');

const ids = new Set();
const listed = new Set();
idx.templates.forEach((t) => {
  assert.ok(typeof t.id === 'string' && t.id.trim(), 'every entry has an id');
  assert.ok(!ids.has(t.id), `id "${t.id}" is unique`);
  ids.add(t.id);
  assert.ok(typeof t.name === 'string' && t.name.trim(), `${t.id} has a name`);
  assert.ok(typeof t.country === 'string' && typeof t.city === 'string',
    `${t.id} carries country and city as strings (empty is fine)`);
  assert.match(t.file, /^templates\/[^/]+\.json$/,
    `${t.id} points at a json file directly under templates/`);
  const basename = t.file.slice('templates/'.length);
  listed.add(basename);

  const raw = readFileSync(new URL(basename, dir), 'utf8');
  assert.ok(raw.length < 100_000, `${t.id} stays under 100 kB`);
  const data = JSON.parse(raw);
  assert.equal(data.kind, 'gym-template', `${t.id} is a gym-template file`);
  // the exact same validation the app runs on import — if this passes,
  // the template loads in gymii
  assert.equal(store.importData(JSON.parse(JSON.stringify(data))), 'gym-template',
    `${t.id} passes gymii's import validation`);
  assert.ok(store.getLayout().machines.length >= 1, `${t.id} has at least one machine`);
});

// no orphan template files the manifest doesn't know about
readdirSync(dir).forEach((f) => {
  if (f === 'index.json' || !f.endsWith('.json')) return;
  assert.ok(listed.has(f), `templates/${f} is listed in index.json`);
});

console.log('template library: all assertions passed');
