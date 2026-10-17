import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULTS,
  matchesFilter,
  normalizeConfig,
  parseEnvironmentFilter,
  parsePortainerUrl,
} from '../src/config.js';
import { normalizeFingerprint } from '../src/portainer/http.js';

test('the address: scheme, default ports, a path for a reverse proxy', () => {
  assert.deepEqual(parsePortainerUrl('192.168.1.10'), {
    base: 'https://192.168.1.10:9443',
    origin: 'https://192.168.1.10:9443',
    protocol: 'https:',
    hostname: '192.168.1.10',
    port: 9443,
  });
  assert.equal(parsePortainerUrl('http://nas.local').base, 'http://nas.local:9000');
  assert.equal(parsePortainerUrl('https://nas.local:443').port, 443, 'a typed default port stays');
  assert.equal(
    parsePortainerUrl('https://Example.org/portainer/').base,
    'https://example.org:9443/portainer',
  );
  assert.equal(
    parsePortainerUrl('https://example.org/portainer/api').base,
    'https://example.org:9443/portainer',
  );
  assert.equal(parsePortainerUrl('https://[::1]:9443').hostname, '[::1]');
  assert.deepEqual(parsePortainerUrl(''), { error: 'empty' });
  assert.deepEqual(parsePortainerUrl('https://u:p@h'), { error: 'credentials' });
  assert.deepEqual(parsePortainerUrl('https://h/?x=1'), { error: 'invalid' });
  assert.deepEqual(parsePortainerUrl('ftp://h'), { error: 'invalid' });
  assert.deepEqual(parsePortainerUrl('https://h:99999'), { error: 'invalid' });
});

test('the environment filter: ids and names, any case', () => {
  assert.equal(parseEnvironmentFilter(''), null);
  const filter = parseEnvironmentFilter(' Local ; 7, nas ');
  assert.ok(matchesFilter(filter, { id: 1, name: 'local' }));
  assert.ok(matchesFilter(filter, { id: 7, name: 'other' }));
  assert.ok(matchesFilter(filter, { id: 2, name: 'NAS' }));
  assert.ok(!matchesFilter(filter, { id: 3, name: 'edge' }));
  assert.ok(matchesFilter(null, { id: 3, name: 'edge' }));
});

test('fingerprints: any spelling, SHA-256 only', () => {
  const colons = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16) + 'a').join(':');
  const bare = colons.replace(/:/g, '');
  assert.equal(normalizeFingerprint(bare), colons.toUpperCase());
  assert.equal(normalizeFingerprint(`SHA256 Fingerprint=${colons}`), colons.toUpperCase());
  assert.equal(normalizeFingerprint(colons.toLowerCase().replace(/:/g, ' ')), colons.toUpperCase());
  assert.equal(normalizeFingerprint('AB:CD'), null);
  assert.equal(normalizeFingerprint('z'.repeat(64)), null);
});

test('normalizeConfig: defaults, safety off, token trimmed', () => {
  const config = normalizeConfig({ url: 'h', token: '  ptr_x  ' });
  assert.equal(config.token, 'ptr_x');
  assert.equal(config.allowControl, false);
  assert.equal(config.allowSelfSigned, false);
  assert.equal(config.fingerprint, null);
  assert.equal(config.statsSeconds, Number(DEFAULTS.stats_interval));
  assert.equal(normalizeConfig({ stats_interval: '7' }).statsSeconds, 60);
  assert.equal(normalizeConfig({ stats_interval: '0' }).statsSeconds, 0);
  assert.equal(normalizeConfig({ allow_container_control: 'true' }).allowControl, true);
  assert.equal(normalizeConfig({ certificate_fingerprint: 'nope' }).fingerprintInvalid, true);
  assert.equal(normalizeConfig(null).urlError, 'empty');
});
