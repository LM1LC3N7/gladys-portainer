// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEVICE_FEATURE_UNITS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DEFAULTS } from '../src/config.js';
import { ACTIONS, PROBLEMS, SCENE_TRIGGERS, STATS_INTERVALS } from '../src/constants.js';
import { buildContainerDevice, buildEnvironmentDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const handlers = read('src/handlers.js');
const app = read('src/app.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const byKey = (list, key) => list.find((item) => item.key === key);
const keys = (list) => (list ?? []).map((item) => item.key);
const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));

test('the store basics; version 0.1.0 set by hand everywhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.gladys_version, /^>=5\.1\.0$/, 'scene triggers need 5.1');
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-portainer:${manifest.version}`);
  assert.equal(pkg.name, 'gladys-portainer');
  assert.equal(lock.name, 'gladys-portainer');
  assert.deepEqual(Object.keys(pkg.dependencies), ['@gladysassistant/integration-sdk']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(fields.intro.description.en, /Unofficial integration, not affiliated/);
  assert.match(fields.intro.description.fr, /non officielle, sans lien/);
  assert.match(read('docs/en.md'), /never been tested against a real Portainer/i);
  assert.match(read('docs/fr.md'), /jamais été testée sur un vrai Portainer/i);
});

test('the license and the notices ship in the image', () => {
  assert.match(read('LICENSE'), /Apache License/);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /homeassistant-portainer[\s\S]*Apache License/);
  assert.match(dockerfile, /COPY[^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('the configuration matches the code; safety off by default', () => {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.equal(fields[key].default, value, key);
  }
  assert.deepEqual(
    fields.stats_interval.options.map((o) => o.value),
    STATS_INTERVALS,
  );
  assert.deepEqual(keys(manifest.config_schema), [
    'intro',
    'url',
    'token',
    'tls_section',
    'allow_self_signed',
    'certificate_fingerprint',
    'environments',
    'security_section',
    'allow_container_control',
    'polling_section',
    'stats_interval',
  ]);
  assert.equal(fields.token.type, 'secret');
  assert.match(
    fields.token.description.en,
    /never shown again, sent only to Portainer, in the X-API-Key header/,
  );
  assert.match(fields.token.description.fr, /jamais réaffiché, envoyé seulement à Portainer/);
  assert.match(fields.url.description.en, /in clear/, 'the risk of http is said');
  assert.match(fields.url.description.fr, /en clair/);
  assert.doesNotMatch(JSON.stringify(manifest), /chiffré|encrypted/i, 'a secret is not encrypted');
  assert.equal(fields.allow_container_control.type, 'boolean');
  assert.equal(fields.allow_container_control.default, false);
  assert.equal(fields.allow_self_signed.default, false);
});

test('sections store nothing; links https', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined, section.key);
    assert.equal(section.default, undefined, section.key);
    assert.equal(section.placeholder, undefined, section.key);
    assert.ok(!(section.key in DEFAULTS), section.key);
    for (const link of section.links ?? []) assert.match(link.url, /^https:\/\//);
    for (const text of Object.values(section.description)) {
      assert.ok(text.length <= 1000, `${section.key}: ${text.length} characters`);
    }
  }
});

test('the keys of the manifest are the keys of the code, all registered', () => {
  assert.deepEqual(keys(manifest.actions).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), name);
  }
  assert.ok(manifest.actions.every((a) => a.timeout_seconds >= 5 && a.timeout_seconds <= 120));
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.deepEqual(keys(manifest.scene_triggers).sort(), Object.values(SCENE_TRIGGERS).sort());
  for (const name of Object.keys(SCENE_TRIGGERS)) {
    assert.ok(app.includes(`SCENE_TRIGGERS.${name}`), `${name} is never fired`);
  }
  for (const handler of ['onScanRequest(', 'onSetValue(', 'onConfigUpdated(']) {
    assert.ok(handlers.includes(handler), handler);
  }
});

test('the trigger: filters and variables are keys of the event', () => {
  const trigger = byKey(manifest.scene_triggers, SCENE_TRIGGERS.CONTAINER_PROBLEM);
  assert.deepEqual(
    byKey(trigger.fields, 'problem').options.map((o) => o.value),
    Object.values(PROBLEMS),
  );
  const data = ['container', 'container_name', 'environment_name', 'problem'];
  for (const key of keys([...trigger.fields, ...trigger.variables])) {
    assert.ok(data.includes(key), `${key} is not in the event`);
  }
  const container = byKey(trigger.fields, 'container');
  assert.equal(container.source, 'devices');
  assert.equal(container.options, undefined);
});

test('placeholders are multi-language objects', () => {
  for (const field of manifest.config_schema.filter((f) => f.placeholder !== undefined)) {
    assert.equal(typeof field.placeholder, 'object', field.key);
    assert.ok(field.placeholder.en && field.placeholder.fr, field.key);
  }
});

test('units: only those the core lists for the category (server/utils/constants.js)', () => {
  // DEVICE_FEATURE_UNITS_BY_CATEGORY of the core, for the categories used here.
  const allowed = {
    data: [
      'bit',
      'kilobit',
      'megabit',
      'gigabit',
      'byte',
      'kilobyte',
      'megabyte',
      'gigabyte',
      'terabyte',
    ],
  };
  const gladys = createFakeGladys({ selector: 'portainer' });
  const features = [
    ...buildContainerDevice(gladys, { id: 1, name: 'l' }, { name: 'web', image: 'x' }).features,
    ...buildEnvironmentDevice(gladys, { id: 1, name: 'l' }).features,
  ];
  for (const feature of features) {
    if (feature.unit === undefined) continue;
    assert.ok(Object.values(DEVICE_FEATURE_UNITS).includes(feature.unit));
    assert.ok(
      allowed[feature.category]?.includes(feature.unit),
      `${feature.name}: ${feature.unit}`,
    );
  }
});
