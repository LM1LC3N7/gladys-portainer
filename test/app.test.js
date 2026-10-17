// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake Portainer,
// through the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { PortainerApp } from '../src/app.js';
import { ACTIONS, COMMAND_ACK_MS, INTERVALS, LIMITS, SCENE_TRIGGERS } from '../src/constants.js';
import { buildContainerDevice, buildEnvironmentDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { TOKEN, createFakePortainer, dockerContainer } from './helpers/fakePortainer.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-17T08:00:00Z');
const SELECTOR = 'portainer';
const ids = createFakeGladys({ selector: SELECTOR });
const LOCAL = { id: 1, name: 'local' };
const NAS = { id: 2, name: 'nas' };
const device = (environment, name) => buildContainerDevice(ids, environment, { name, image: 'x' });
const feature = (d, key) => d.features.find((f) => f.external_id.endsWith(`:${key}`));
const BASE_CONFIG = { url: 'http://portainer.local:9000', token: TOKEN };

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({
  config = {},
  created = [
    [LOCAL, 'web'],
    [LOCAL, 'db'],
    [LOCAL, 'worker'],
    [LOCAL, 'gladys'],
    [NAS, 'backup'],
  ],
  environments = [LOCAL],
  portainer,
  dataDir,
  selfId = null,
} = {}) {
  const clock = { now: T0 };
  portainer ??= createFakePortainer();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices: [
      ...created.map(([env, name]) => device(env, name)),
      ...environments.map((env) => buildEnvironmentDevice(ids, env)),
    ],
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  const app = new PortainerApp({
    gladys,
    logger,
    request: portainer.request,
    dataDir: dataDir ?? mkdtempSync(join(tmpdir(), 'ptr-app-')),
    now: () => clock.now,
    timers,
    selfId,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, portainer, timers, clock, logs, app };
}

const state = (gladys, environment, name, key) =>
  gladys.fake.lastState(feature(device(environment, name), key).external_id);
const status = (timers) => timers.run((ms) => ms === INTERVALS.STATUS_MS);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('start: Discovery gets every environment and container; states, counts, badges', async () => {
  const { gladys, timers } = await setup();
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: {
      en: 'Portainer answers: 2 environments, 5 containers running, 1 stopped. 2 Edge or Kubernetes environments left out.',
      fr: 'Portainer répond : 2 environnements, 5 conteneurs en marche, 1 arrêté. 2 environnements Edge ou Kubernetes ignorés.',
    },
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [`ext:${SELECTOR}:environment:1`, 'Portainer: local'],
      [`ext:${SELECTOR}:environment:2`, 'Portainer: nas'],
      [`ext:${SELECTOR}:container:1-db`, 'db (local)'],
      [`ext:${SELECTOR}:container:1-gladys`, 'gladys (local)'],
      [`ext:${SELECTOR}:container:1-portainer`, 'portainer (local)'],
      [`ext:${SELECTOR}:container:1-web`, 'web (local)'],
      [`ext:${SELECTOR}:container:1-worker`, 'worker (local)'],
      [`ext:${SELECTOR}:container:2-backup`, 'backup (nas)'],
    ],
  );
  assert.equal(state(gladys, LOCAL, 'web', 'running'), 1);
  assert.equal(state(gladys, LOCAL, 'worker', 'running'), 0);
  assert.equal(state(gladys, LOCAL, 'web', 'healthy'), 1);
  assert.equal(state(gladys, LOCAL, 'db', 'healthy'), undefined, 'no healthcheck: nothing');
  const env = buildEnvironmentDevice(ids, LOCAL);
  assert.equal(gladys.fake.lastState(env.features[0].external_id), 4);
  assert.equal(gladys.fake.lastState(env.features[1].external_id), 1);
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'local'));
  assert.deepEqual(
    timers.delays().sort((a, b) => a - b),
    [5_000, INTERVALS.STATUS_MS],
  );
});

test('the external id is the name: a recreated container (new Docker id) keeps its device', async () => {
  const { gladys, portainer, timers } = await setup();
  const before = gladys.fake.discoveredDevices.map((d) => d.external_id);
  portainer.containers[1][0] = dockerContainer('web', { health: 'healthy', id: 'f'.repeat(64) });
  await status(timers);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    before,
  );
  assert.equal(state(gladys, LOCAL, 'web', 'running'), 1);
});

test('the environment filter, and an environment that fails alone', async () => {
  const { gladys, portainer, timers } = await setup({ config: { environments: 'nas' } });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.name),
    ['Portainer: nas', 'backup'],
  );
  assert.equal(
    portainer.requests.filter((r) => r.path.startsWith('/api/endpoints/1/')).length,
    0,
    'an environment left out is never read',
  );
  const badge = () =>
    gladys.fake.transports
      .filter((t) => t.device_external_id === `ext:${SELECTOR}:container:2-backup`)
      .at(-1)?.transport;
  assert.equal(badge(), 'local');
  portainer.failures.push({ path: '/api/endpoints/2/docker', status: 502 });
  await status(timers);
  assert.equal(gladys.fake.connectionStatus.connected, true, 'the integration stays connected');
  assert.match(gladys.fake.connectionStatus.message.en, /1 environment does not answer/);
  assert.equal(badge(), 'unreachable');
  await status(timers);
  assert.equal(badge(), 'local', 'back at the next reading');
});

test('trigger: a running container that stops, a healthcheck that turns unhealthy, once', async () => {
  const { gladys, portainer, timers } = await setup();
  assert.equal(gladys.fake.sceneEvents.length, 0, 'the first reading fires nothing');
  const [web, db] = portainer.containers[1];
  db.State = 'exited';
  db.Status = 'Exited (137) 2 seconds ago';
  web.Status = 'Up 2 hours (unhealthy)';
  await status(timers);
  assert.deepEqual(
    gladys.fake.sceneEvents.map((e) => [e.key, e.data]),
    [
      [
        SCENE_TRIGGERS.CONTAINER_PROBLEM,
        {
          container: `ext:${SELECTOR}:container:1-db`,
          container_name: 'db',
          environment_name: 'local',
          problem: 'stopped',
        },
      ],
      [
        SCENE_TRIGGERS.CONTAINER_PROBLEM,
        {
          container: `ext:${SELECTOR}:container:1-web`,
          container_name: 'web',
          environment_name: 'local',
          problem: 'unhealthy',
        },
      ],
    ],
  );
  assert.equal(state(gladys, LOCAL, 'web', 'healthy'), 0);
  assert.equal(state(gladys, LOCAL, 'db', 'running'), 0);
  await status(timers);
  assert.equal(gladys.fake.sceneEvents.length, 2, 'no repeat while it stays so');
});

const press = (gladys, d, key, value = 1) => gladys.fake.setValue(d, feature(d, key), value);

test('running is a reading, never a switch: no voice assistant can stop a container', () => {
  const running = feature(device(LOCAL, 'web'), 'running');
  assert.equal(running.read_only, true);
  assert.notEqual(running.category, 'switch');
  const buttons = device(LOCAL, 'web').features.filter((f) => !f.read_only);
  assert.deepEqual(
    buttons.map((f) => [f.external_id.split(':').at(-1), f.category, f.type]),
    [
      ['start', 'button', 'push'],
      ['stop', 'button', 'push'],
      ['restart', 'button', 'push'],
    ],
  );
});

test('commands are refused by default, nothing reaches Portainer', async () => {
  const { gladys, portainer } = await setup();
  const db = device(LOCAL, 'db');
  for (const key of ['stop', 'start', 'restart']) {
    const ack = await press(gladys, db, key);
    assert.equal(ack.success, false, key);
    assert.match(ack.error, /off: allow it first/);
  }
  assert.equal(portainer.commands.length, 0);
});

test('commands when allowed: stop, start, restart; the state read first', async () => {
  const { gladys, portainer } = await setup({ config: { allow_container_control: true } });
  const db = device(LOCAL, 'db');
  const off = await press(gladys, db, 'running', 0);
  assert.equal(off.success, false, 'the running state takes no command');
  let ack = await press(gladys, db, 'stop');
  assert.equal(ack.success, true, ack.error);
  assert.equal(state(gladys, LOCAL, 'db', 'running'), 0);
  ack = await press(gladys, db, 'stop');
  assert.equal(ack.success, true, 'already stopped: nothing sent');
  ack = await press(gladys, db, 'start');
  assert.equal(ack.success, true, ack.error);
  ack = await press(gladys, db, 'restart');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    portainer.commands.map((c) => c.verb),
    ['stop', 'start', 'restart'],
  );
  // Each command was preceded by a fresh reading of the container, by its name.
  const inspects = portainer.requests.filter(
    (r) => r.path === '/api/endpoints/1/docker/containers/db/json',
  );
  assert.equal(inspects.length, 4);
  // The command targets the current Docker id, read just before.
  assert.ok(
    portainer.requests.some((r) =>
      r.path.endsWith(`/containers/${portainer.containers[1][1].Id}/stop`),
    ),
  );
  ack = await press(gladys, db, 'stop', 0);
  assert.equal(ack.success, false, 'a button takes 1 only');
});

test('Gladys, Portainer, the Docker socket and our own container are never stopped nor restarted', async () => {
  const self = 'abcdef012345';
  const portainer = createFakePortainer();
  const add = (name, options) =>
    portainer.containers[1].push(
      dockerContainer(name, { id: String(portainer.containers[1].length).repeat(64), ...options }),
    );
  portainer.containers[1].push(dockerContainer('integration', { id: self + '0'.repeat(52) }));
  // Renamed, but still the image of Portainer.
  add('mgmt', { image: 'portainer/portainer-ee:lts' });
  // An integration renamed, whose image says nothing: the label of the core.
  add('zigbee', { image: 'koenkk/zigbee2mqtt', labels: { 'io.gladysassistant.container': 'x' } });
  // The core created from an image id and renamed: it mounts the Docker socket.
  add('home', { image: 'sha256:abcd', mounts: ['/var/run/docker.sock'] });
  // A socket proxy.
  add('socket-proxy', { image: 'tecnativa/docker-socket-proxy', mounts: ['/run/docker.sock'] });
  const names = ['gladys', 'portainer', 'integration', 'mgmt', 'zigbee', 'home', 'socket-proxy'];
  const { gladys } = await setup({
    portainer,
    selfId: self,
    config: { allow_container_control: true },
    created: names.map((n) => [LOCAL, n]),
  });
  for (const name of names) {
    const d = device(LOCAL, name);
    const stop = await press(gladys, d, 'stop');
    assert.equal(stop.success, false, name);
    assert.match(stop.error, /never stops nor restarts it/);
    const restart = await press(gladys, d, 'restart');
    assert.equal(restart.success, false, name);
  }
  assert.equal(portainer.commands.length, 0);
  // Starting one stays possible (it is already running: nothing sent).
  assert.equal((await press(gladys, device(LOCAL, 'gladys'), 'start')).success, true);
});

test('two containers never wait for each other (a scene stopping web then db stops both)', async () => {
  const { gladys, portainer, timers } = await setup({ config: { allow_container_control: true } });
  let release;
  portainer.commandGate = new Promise((resolve) => (release = resolve));
  const web = press(gladys, device(LOCAL, 'web'), 'stop');
  const db = press(gladys, device(LOCAL, 'db'), 'stop');
  for (let i = 0; i < 20; i += 1) await tick();
  assert.deepEqual(
    portainer.commands.map((c) => c.name).sort(),
    ['db', 'web'],
    'both sent before any answer',
  );
  await timers.run((ms) => ms === COMMAND_ACK_MS);
  assert.equal((await web).success, true);
  assert.equal((await db).success, true);
  release();
});

test('a slow stop: answered within the ack delay, no "stopped" event, the state follows', async () => {
  const { gladys, portainer, timers } = await setup({ config: { allow_container_control: true } });
  let release;
  portainer.commandGate = new Promise((resolve) => (release = resolve));
  const db = device(LOCAL, 'db');
  const pending = press(gladys, db, 'stop');
  for (let i = 0; i < 10; i += 1) await tick();
  assert.ok(timers.delays().includes(COMMAND_ACK_MS), 'the ack timer waits');
  await timers.run((ms) => ms === COMMAND_ACK_MS);
  const ack = await pending;
  assert.equal(ack.success, true, ack.error);
  // A second command on the same container while Docker is at work: refused.
  const again = await press(gladys, db, 'start');
  assert.equal(again.success, false);
  assert.match(again.error, /still running/);
  // Docker is stopping it: a reading meanwhile neither fires nor publishes it.
  const container = portainer.containers[1][1];
  container.State = 'exited';
  container.Status = 'Exited (0) 1 second ago';
  await status(timers);
  assert.equal(state(gladys, LOCAL, 'db', 'running'), 1);
  release();
  for (let i = 0; i < 10; i += 1) await tick();
  assert.equal(state(gladys, LOCAL, 'db', 'running'), 0, 'published once Docker answered');
  await timers.run((ms) => ms === INTERVALS.AFTER_COMMAND_MS);
  await status(timers);
  assert.equal(state(gladys, LOCAL, 'db', 'running'), 0);
  assert.equal(gladys.fake.sceneEvents.length, 0, 'a stop the user asked is not a problem');
});

test('a command past the budget is refused before anything is sent', async () => {
  const { gladys, portainer, clock, app } = await setup({
    config: { allow_container_control: true },
  });
  const original = portainer.request;
  // The fresh read takes 3 s: no room is left to send the stop.
  app.request = portainer.request = async (url, options) => {
    clock.now += 3_000;
    return original(url, options);
  };
  app.client.request = portainer.request;
  const db = device(LOCAL, 'db');
  const ack = await press(gladys, db, 'stop');
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be checked in time .*: nothing was sent/);
  assert.equal(portainer.commands.length, 0);
});

test('statistics: only created containers that run, within the state budget', async () => {
  const { gladys, portainer, timers, app } = await setup();
  await timers.run((ms) => ms === 5_000);
  const statsPaths = portainer.requests.filter((r) => r.path.endsWith('/stats')).map((r) => r.path);
  // web, db, gladys on local and backup on nas run and are created; worker is stopped.
  assert.equal(statsPaths.length, 4);
  assert.ok(!statsPaths.some((p) => p.includes(portainer.containers[1][2].Id)), 'worker not read');
  assert.equal(state(gladys, LOCAL, 'web', 'cpu'), 20);
  assert.equal(state(gladys, LOCAL, 'web', 'memory'), 209.7, 'MB, 10^6 bytes');
  assert.equal(state(gladys, LOCAL, 'worker', 'cpu'), 0);
  // The budget: changed statistics are held back once the minute is used.
  app.budget.record(LIMITS.STATES_PER_MINUTE);
  portainer.stats = { ...portainer.stats, memory_stats: { usage: 500 * 1048576 } };
  await timers.run((ms) => ms === 60_000);
  assert.equal(state(gladys, LOCAL, 'web', 'memory'), 209.7, 'held back');
});

test('statistics: the figures read go before the zeros of the stopped containers', async () => {
  const { gladys, timers, app } = await setup();
  // Room for 2 changes only: the figures of web win over the zeros of worker.
  app.budget.record(app.budget.remaining() - 2);
  await timers.run((ms) => ms === 5_000);
  const stats = gladys.fake.states.filter((s) =>
    /:(cpu|memory)$/.test(s.device_feature_external_id),
  );
  assert.equal(stats.length, 2);
  assert.ok(
    stats.every((s) => s.state !== 0),
    'figures, not zeros',
  );
  assert.equal(state(gladys, LOCAL, 'worker', 'cpu'), undefined);
});

test('statistics: 25 per round at most, in turn', async () => {
  const portainer = createFakePortainer();
  const names = Array.from({ length: 30 }, (_, i) => `app${String(i).padStart(2, '0')}`);
  portainer.containers[1] = names.map((n, i) =>
    dockerContainer(n, { id: (i + 10).toString(16).padStart(2, '0').repeat(32) }),
  );
  const { timers } = await setup({ portainer, created: names.map((n) => [LOCAL, n]) });
  const count = () => portainer.requests.filter((r) => r.path.endsWith('/stats')).length;
  await timers.run((ms) => ms === 5_000);
  assert.equal(count(), LIMITS.STATS_PER_ROUND);
  await timers.run((ms) => ms === 60_000);
  assert.equal(count(), 2 * LIMITS.STATS_PER_ROUND);
});

test('a refused token (401) is final, even across a restart; saving tries again', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ptr-app-'));
  const { gladys, portainer, timers, logs } = await setup({
    config: { token: 'ptr_wrong' },
    dataDir,
  });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the access token/);
  assert.equal(timers.pending.size, 0, 'no retry timer');
  await running.stop();
  const second = await setup({ config: { token: 'ptr_wrong' }, dataDir, portainer });
  assert.equal(
    portainer.requests.filter((r) => r.path === '/api/endpoints').length,
    1,
    'the restart sent nothing',
  );
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG, token: TOKEN });
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  assert.ok(![...logs, ...second.logs].some((l) => l.includes('ptr_wrong') || l.includes(TOKEN)));
});

test('disconnection then reconnection (Gladys restarted): status and Discovery published again', async () => {
  const { gladys, app } = await setup();
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  assert.ok(discoveries >= 1);
  await gladys.disconnect();
  await gladys.connect();
  await app.queue;
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
});

test('reconnection with a refused token: the refusal is published again, nothing sent', async () => {
  const { gladys, portainer, app } = await setup({ config: { token: 'ptr_wrong' } });
  const statuses = gladys.fake.connectionStatuses.length;
  const sent = portainer.requests.length;
  await gladys.disconnect();
  await gladys.connect();
  await app.queue;
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.match(gladys.fake.connectionStatus.message.en, /refused the access token/);
  assert.equal(portainer.requests.length, sent);
});

test('HTTP 429: every path pauses, kept across a restart', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ptr-app-'));
  const portainer = createFakePortainer();
  const { gladys, timers } = await setup({
    portainer,
    dataDir,
    config: { allow_container_control: true },
  });
  portainer.failures.push({
    path: '/api/endpoints',
    status: 429,
    headers: { 'retry-after': '120' },
  });
  await status(timers);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [120_000]);
  const db = device(LOCAL, 'db');
  const ack = await press(gladys, db, 'stop');
  assert.equal(ack.success, false);
  assert.match(ack.error, /slow down/);
  await running.stop();
  const before = portainer.requests.length;
  await setup({ portainer, dataDir });
  assert.equal(portainer.requests.length, before, 'the restart waits for the end of the pause');
});

test('Portainer down: retried 30 s, then doubling; never a dead integration', async () => {
  const { gladys, portainer, timers } = await setup();
  portainer.unreachable = true;
  await status(timers);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.deepEqual(timers.delays(), [INTERVALS.RETRY_MIN_MS]);
  await timers.run();
  assert.deepEqual(timers.delays(), [2 * INTERVALS.RETRY_MIN_MS]);
  assert.ok(gladys.fake.transports.some((t) => t.transport === 'unreachable'));
  portainer.unreachable = false;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('the buttons: test the connection, trust the new certificate', async () => {
  const { gladys } = await setup();
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /Connected: 2 environments, 6 containers/);
  const trust = await gladys.fake.action(ACTIONS.TRUST_CERTIFICATE);
  assert.equal(trust.success, false, 'not with the strict mode');
});

test('the configuration is checked before anything is sent', async () => {
  for (const [config, pattern] of [
    [{ url: '' }, /Type the address/],
    [{ token: '' }, /access token of Portainer/],
    [{ certificate_fingerprint: 'AB:CD' }, /SHA-256 fingerprint/],
    [{ token: 'ptr_abc​def' }, /invisible character/],
    [{ allow_self_signed: true }, /only apply to https/],
    [{ certificate_fingerprint: 'AB'.repeat(32) }, /only apply to https/],
  ]) {
    const { gladys, portainer } = await setup({ config });
    assert.match(gladys.fake.connectionStatus.message.en, pattern);
    assert.equal(portainer.requests.length, 0);
    await running.stop();
  }
});

test('HTTP 429 met by Discovery or by the reading after a command pauses everything', async () => {
  const { gladys, portainer, timers } = await setup({ config: { allow_container_control: true } });
  portainer.failures.push({ path: '/api/endpoints', status: 429 });
  await gladys.fake.scanRequest();
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [INTERVALS.BUSY_MIN_MS]);

  const second = await setup({ config: { allow_container_control: true } });
  const ack = await press(second.gladys, device(LOCAL, 'db'), 'stop');
  assert.equal(ack.success, true, ack.error);
  second.portainer.failures.push({ path: '/api/endpoints', status: 429 });
  await second.timers.run((ms) => ms === INTERVALS.AFTER_COMMAND_MS);
  assert.match(second.gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(second.timers.delays(), [INTERVALS.BUSY_MIN_MS]);
  await running.stop();
});

test('more than 100 badges go in several calls', async () => {
  const portainer = createFakePortainer();
  const names = Array.from({ length: 130 }, (_, i) => `svc${String(i).padStart(3, '0')}`);
  portainer.containers[1] = names.map((n, i) =>
    dockerContainer(n, { id: (i + 16).toString(16).padStart(4, '0').repeat(16) }),
  );
  const { gladys, logs } = await setup({ portainer, created: names.map((n) => [LOCAL, n]) });
  assert.equal(gladys.fake.transports.length, 131);
  assert.ok(!logs.some((l) => l.includes('Transports not published')));
});

test('the token is never written to /data', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dataDir = mkdtempSync(join(tmpdir(), 'ptr-app-'));
  await setup({ dataDir, config: { token: 'ptr_wrong_secret' } });
  const files = readdirSync(dataDir);
  assert.deepEqual(files, ['portainer.json']);
  const content = readFileSync(join(dataDir, 'portainer.json'), 'utf8');
  assert.match(content, /refusals/);
  assert.ok(!content.includes('ptr_wrong_secret'));
  assert.ok(!content.includes(TOKEN));
});

test('a device created later gets its states at once', async () => {
  const { gladys } = await setup({ created: [] });
  const web = gladys.fake.discoveredDevices.find((d) => d.external_id.endsWith(':1-web'));
  await gladys.fake.deviceCreated(web);
  assert.equal(gladys.fake.lastState(feature(web, 'running').external_id), 1);
});
