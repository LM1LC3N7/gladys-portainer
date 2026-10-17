import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStats,
  healthOf,
  parseContainers,
  parseEnvironments,
  parseInspect,
  protectionOf,
  selfContainerId,
} from '../src/portainer/parse.js';
import { STATS } from './helpers/fakePortainer.js';

const ID = 'a'.repeat(64);

test('environments: Docker and agent only, sorted, a name always', () => {
  const parsed = parseEnvironments([
    { Id: 3, Name: 'edge', Type: 4, Status: 1 },
    { Id: 2, Name: ' nas ', Type: 2, Status: 2 },
    { Id: 1, Name: '', Type: 1, Status: 1 },
    { Id: 'x', Type: 1 },
    { Id: 9, Name: 'k8s', Type: 6, Status: 1 },
    null,
  ]);
  assert.deepEqual(parsed, {
    environments: [
      { id: 1, name: 'Environment 1', type: 1, up: true },
      { id: 2, name: 'nas', type: 2, up: false },
    ],
    skipped: 2,
  });
  assert.equal(parseEnvironments({}), null);
});

test('health: the Health object first, else the text of the list', () => {
  assert.equal(healthOf({ Health: { Status: 'unhealthy' }, Status: 'Up (healthy)' }), 'unhealthy');
  assert.equal(healthOf({ Status: 'Up 2 hours (healthy)' }), 'healthy');
  assert.equal(healthOf({ Status: 'Up 3 seconds (health: starting)' }), 'starting');
  assert.equal(healthOf({ Status: 'Up 2 days (unhealthy)' }), 'unhealthy');
  assert.equal(healthOf({ Status: 'Up 2 days' }), null);
  assert.equal(healthOf({ State: { Health: { Status: 'healthy' } } }), 'healthy');
  assert.equal(healthOf({ Health: { Status: 'none' } }), null);
});

test('containers: the first valid name, duplicates and bad ids left out', () => {
  const list = parseContainers([
    { Id: ID, Names: ['/web'], Image: 'nginx', State: 'running', Status: 'Up (healthy)' },
    { Id: 'b'.repeat(64), Names: ['/other/link', '/db'], Image: 'pg', State: 'exited' },
    { Id: 'c'.repeat(64), Names: ['/web'], State: 'running' },
    { Id: 'not-hex', Names: ['/x'], State: 'running' },
    { Id: 'd'.repeat(64), Names: ['/bad:name'], State: 'running' },
    { Id: 'e'.repeat(64), Names: ['/paused'], State: 'paused' },
  ]);
  assert.deepEqual(
    list.map((c) => [c.name, c.state, c.running, c.stopped, c.health]),
    [
      ['db', 'exited', false, true, null],
      ['paused', 'paused', false, false, null],
      ['web', 'running', true, false, 'healthy'],
    ],
  );
  assert.equal(parseContainers('nope'), null);
});

test('inspect: the image reference of the container, the running flag', () => {
  assert.deepEqual(
    parseInspect({
      Id: ID,
      Name: '/web',
      Config: { Image: 'nginx:1.27' },
      State: { Status: 'running', Running: true, Health: { Status: 'healthy' } },
    }),
    {
      id: ID,
      name: 'web',
      image: 'nginx:1.27',
      state: 'running',
      running: true,
      health: 'healthy',
    },
  );
  assert.equal(parseInspect({ Id: ID, Name: '/web', State: {} }), null, 'no running flag');
  assert.equal(parseInspect(null), null);
});

test('stats: like docker stats (CPU of all cores, memory without the page cache)', () => {
  assert.deepEqual(computeStats(STATS), { cpu: 20, memory: 200 });
  // cgroup v1: total_inactive_file, percpu_usage for the CPU count.
  const v1 = {
    cpu_stats: { cpu_usage: { total_usage: 300, percpu_usage: [1, 2] }, system_cpu_usage: 2000 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    memory_stats: { usage: 10 * 1048576, stats: { total_inactive_file: 4 * 1048576 } },
  };
  assert.deepEqual(computeStats(v1), { cpu: 40, memory: 6 });
  // The first sample of a container (no precpu): no CPU figure.
  assert.deepEqual(computeStats({ cpu_stats: STATS.cpu_stats, precpu_stats: {} }), {
    cpu: null,
    memory: null,
  });
  assert.deepEqual(computeStats('x'), { cpu: null, memory: null });
});

test('protection: Gladys, Portainer, its agent and our own container, by image or name', () => {
  const p = (name, image, id = ID) => protectionOf({ id, name, image }, 'abcdef012345');
  assert.equal(p('home', 'gladysassistant/gladys:v4'), 'gladys');
  assert.equal(p('x', 'docker.io/gladysassistant/gladys@sha256:00'), 'gladys');
  assert.equal(p('x', 'ghcr.io/lm1lc3n7/gladys-portainer:0.1.0'), 'gladys');
  assert.equal(p('mgmt', 'portainer/portainer-ce:2.21.0'), 'portainer');
  assert.equal(p('mgmt', 'portainer/portainer-ee'), 'portainer');
  assert.equal(p('a', 'portainer/agent:2.21'), 'portainer');
  assert.equal(p('Gladys', 'sha256:1234'), 'gladys', 'by name when the image is lost');
  assert.equal(p('portainer_agent', ''), 'portainer');
  assert.equal(p('mine', 'whatever', 'abcdef012345' + '0'.repeat(52)), 'self');
  assert.equal(p('web', 'nginx:1.27'), null);
  assert.equal(p('web', 'myregistry/notgladys:1'), null);
  assert.equal(p('web', 'portainer/helper-reset-password'), null);
});

test('our own container id comes from HOSTNAME when Docker set it', () => {
  assert.equal(selfContainerId({ HOSTNAME: 'abcdef012345' }), 'abcdef012345');
  assert.equal(selfContainerId({ HOSTNAME: 'gladys-portainer' }), null);
  assert.equal(selfContainerId({}), null);
});
