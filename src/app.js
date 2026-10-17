// -----------------------------------------------------------------------------
// PortainerApp: the integration. One Portainer, its Docker environments.
//
//   start(config)  (re)connects: environments and containers read, Discovery
//                  published, loops started
//   status loop    every 30 s: the environments, then the containers of each
//                  one (state, health) -> running / healthy / counts, and the
//                  trigger `container_problem`; while Portainer fails, the
//                  reconnection, 30 s to 10 min (HTTP 429: a pause of 1 min
//                  to 6 h, Retry-After honoured)
//   stats loop     every `stats_interval` s: CPU and memory of the created
//                  containers that run, 25 per round at most (in turn beyond)
//   setValue       start / stop / restart, see "Commands" below
//
// Each loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch (still in flight when Portainer failed) never schedules itself
// again. A token Portainer refused (HTTP 401) is final: every loop stops and
// the status says what to fix; nothing is sent again until the configuration
// is saved or "Test the connection" is pressed.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { matchesFilter, normalizeConfig } from './config.js';
import {
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  FEATURES,
  INTERVALS,
  LIMITS,
  PROBLEMS,
  SCENE_TRIGGERS,
  STORE_FILE,
} from './constants.js';
import {
  buildContainerDevice,
  buildEnvironmentDevice,
  containerIds,
  createdDevices,
  environmentIds,
  parseExternalId,
} from './devices.js';
import { T } from './i18n.js';
import { Store } from './store.js';
import { PortainerClient } from './portainer/client.js';
import { CODES, isTokenRefused } from './portainer/errors.js';
import { httpRequest } from './portainer/http.js';
import { protectionOf, selfContainerId } from './portainer/parse.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 25_000;
/** Entries per publishTransports call (the SDK refuses more). */
export const TRANSPORTS_PER_CALL = 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const keyOf = (environmentId, name) => `${environmentId}-${name}`;

export class PortainerApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Portainer)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   * @param {string | null} [options.selfId] the id of our own container
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'portainer' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    timers = globalThis,
    selfId = selfContainerId(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.selfId = selfId;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now });
    this.rawConfig = {};
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    this.handles = new Set();
    this.queue = Promise.resolve();
    /** One chain of commands per container (key): two containers never wait for each other. */
    this.chains = new Map();
    /**
     * Containers whose command Docker has not answered yet: kept across a
     * restart of the app (reset()), the request still runs.
     * key -> { running } the state expected once Docker is done.
     */
    this.inFlight = new Map();
    this.activeCommands = 0;
    this.stateVersion = 0;
    this.reset();
  }

  reset() {
    // Gladys keeps the status and the Discovery list in memory only: after a
    // restart of the core (a new `connected`), both are published again.
    this.lastStatus = null;
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;
    this.skipped = 0;
    /** id -> { id, name, up, reachable, read } (`read`: its containers were read once). */
    this.environments = new Map();
    /** `<environment id>-<name>` -> { environmentId, id, name, image, state, running, stopped, health } */
    this.containers = new Map();
    this.discoveredKey = null;
    this.transports = new Map();
    this.statsCursor = 0;
    this.statsRunning = false;
    /** Statistics last accepted by Gladys (feature -> value), to budget only changes. */
    this.publishedStats = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * asked (button, saved configuration): a token refused earlier is tried.
   */
  start(rawConfig, { force = false } = {}) {
    return this.enqueue(() => this.run(rawConfig, { force }));
  }

  /** The values a refusal is about (HMAC with the salt of /data: never the token). */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(JSON.stringify([config.portainer.base, config.token]))
      .digest('hex');
  }

  async stop() {
    this.generation += 1;
    this.halt();
    this.dropClient();
  }

  /** Clear every timer; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  async run(rawConfig, { force = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    this.config = config;
    this.reset();
    await this.store.load();

    if (config.urlError) {
      const message = { empty: T.status.urlEmpty, credentials: T.status.urlCredentials }[
        config.urlError
      ];
      await this.setStatus(false, message ?? T.status.urlInvalid);
      return;
    }
    if (!config.token) {
      await this.setStatus(false, T.status.missingToken);
      return;
    }
    if (config.tokenInvalid) {
      await this.setStatus(false, T.status.tokenInvalid);
      return;
    }
    if (config.fingerprintInvalid) {
      await this.setStatus(false, T.status.fingerprintInvalid);
      return;
    }
    if (config.tlsOverHttp) {
      await this.setStatus(false, T.status.tlsOverHttp);
      return;
    }
    // A token Portainer refused with these very values is not tried again alone.
    const base = config.portainer.base;
    const refused = this.store.get('refusals', base);
    if (refused && refused === (await this.refusalKey(config)) && !force) {
      this.blocked = true;
      this.logger.warn('Access token refused earlier: not tried again');
      await this.setStatus(false, T.status.tokenRefused);
      return;
    }
    if (refused) await this.store.set('refusals', base, null);
    this.client = new PortainerClient({
      portainer: config.portainer,
      token: config.token,
      fingerprint: config.fingerprint,
      allowSelfSigned: config.allowSelfSigned,
      store: this.store,
      request: this.request,
      now: this.now,
    });
    this.logger.info(`Using Portainer at ${config.portainer.origin}`);
    // An HTTP 429 pause outlives a restart and a reconnection to Gladys;
    // only the user lifts it (button, saved configuration).
    const pausedUntil = Number(this.store.get('meta', this.pauseKey())) || 0;
    if (force && pausedUntil) await this.store.set('meta', this.pauseKey(), null);
    if (!force && this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      const delay = pausedUntil - this.now();
      await this.setStatus(false, T.status.busy(delay));
      this.schedule(delay, () => this.connect(generation));
      return;
    }
    await this.connect(generation);
  }

  pauseKey() {
    return `pausedUntil|${this.config.portainer?.base}`;
  }

  schedule(delay, task) {
    const handle = this.timers.setTimeout(async () => {
      this.handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error('Loop failed', err);
      }
    }, delay);
    this.handles.add(handle);
    return handle;
  }

  /** Schedule one step of a loop of the current epoch. */
  scheduleLoop(delay, loop, generation) {
    const epoch = this.epoch;
    this.schedule(delay, () => loop.call(this, generation, epoch));
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /** First reading, then the loops. Never throws. */
  async connect(generation) {
    if (!this.client || generation !== this.generation) return;
    try {
      // A reading crossed by a command is dropped: read again (bounded).
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await this.refreshStatus({ publish: true })) break;
      }
      if (generation !== this.generation) return;
      this.logger.info(
        `Portainer answers: ${this.environments.size} environment(s), ${this.containers.size} container(s)`,
      );
    } catch (err) {
      await this.failed(err, generation);
      return;
    }
    this.scheduleLoop(INTERVALS.STATUS_MS, this.statusLoop, generation);
    if (this.config.statsSeconds > 0) this.scheduleLoop(5_000, this.statsLoop, generation);
  }

  /** A reading failed: final refusal, or retry with a growing delay. */
  async failed(err, generation) {
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (isTokenRefused(err)) {
      this.blocked = true;
      await this.store.set(
        'refusals',
        this.config.portainer.base,
        await this.refusalKey(this.config),
      );
      this.logger.warn('Access token refused by Portainer (401): not retried until changed');
      await this.setStatus(false, T.status.tokenRefused);
      return;
    }
    let delay;
    if (err.status === 429) {
      // Too many requests: a bounded pause of every path (loops, commands).
      delay = clamp(
        err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MIN_MS,
        INTERVALS.BUSY_MAX_MS,
      );
      this.pausedUntil = this.now() + delay;
    } else {
      delay = this.retryDelay;
      this.retryDelay = Math.min(this.retryDelay * 2, INTERVALS.RETRY_MAX_MS);
      if (err.status >= 500 && err.retryAfterMs) {
        delay = clamp(err.retryAfterMs, delay, INTERVALS.BUSY_MAX_MS);
        this.pausedUntil = this.now() + delay;
      }
    }
    if (this.pausedUntil > this.now()) {
      await this.store.set('meta', this.pauseKey(), String(this.pausedUntil));
    }
    if (wasOnline || delay === INTERVALS.RETRY_MIN_MS) {
      this.logger.warn(`Portainer fails: ${err.message}`);
    }
    await this.setStatus(false, this.errorMessage(err, delay));
    this.schedule(delay, () => this.connect(generation));
  }

  errorMessage(err, delay) {
    if (err.code === CODES.TLS_UNTRUSTED) return T.status.tlsUntrusted(delay);
    if (err.code === CODES.TLS_CHANGED) return T.status.tlsChanged(delay);
    if (err.status === 429) return T.status.busy(delay);
    if (err.status >= 500) return T.status.serverError(err.status, delay);
    if (err.status === 403) return T.status.forbidden(delay);
    if (err.code === CODES.BAD_ANSWER || err.code === CODES.HTTP) {
      return T.status.notPortainer(delay);
    }
    return T.status.unreachable(err, delay);
  }

  /**
   * An HTTP 429 met by a command or a statistics request: Portainer refused
   * it without doing it. Every path pauses (failed()), and the caller is told so.
   */
  async throwIfBusy(err, generation) {
    if (err?.status !== 429) return;
    await this.failed(err, generation);
    throw new Error(T.errors.busyRefused, { cause: err });
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Status: environments and containers -----------------------------------

  async statusLoop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    try {
      await this.refreshStatus({ publish: false });
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    if (this.current(generation, epoch)) {
      this.scheduleLoop(INTERVALS.STATUS_MS, this.statusLoop, generation);
    }
  }

  /**
   * Read the environments and their containers, publish them. Resolves
   * false when the reading was dropped: a command ran meanwhile (its result
   * is newer). Throws when the list of the environments fails; an
   * environment that fails only marks its own devices unreachable.
   */
  async refreshStatus({ publish }) {
    const client = this.client;
    if (!client) return true;
    const version = this.stateVersion;
    const { environments: all, skipped } = await client.environments();
    const followed = all
      .filter((environment) => matchesFilter(this.config.filter, environment))
      .slice(0, LIMITS.ENVIRONMENTS);
    const readings = new Map();
    for (const environment of followed) {
      if (!environment.up) continue;
      try {
        readings.set(environment.id, await client.containers(environment.id));
      } catch (err) {
        // A 429 pauses everything; any other failure is this environment's.
        if (err.status === 429) throw err;
        if (client !== this.client) return true;
        this.logger.debug(`Environment ${environment.id} not read: ${err.message}`);
      }
    }
    if (client !== this.client) return true;
    if (version !== this.stateVersion || this.activeCommands > 0) return false;

    const previousEnvironments = this.environments;
    const previous = this.containers;
    const environments = new Map();
    const containers = new Map();
    const events = [];
    let total = 0;
    for (const environment of followed) {
      const before = previousEnvironments.get(environment.id);
      const list = readings.get(environment.id);
      environments.set(environment.id, {
        ...environment,
        reachable: Boolean(list),
        read: Boolean(list) || Boolean(before?.read),
      });
      if (!list) {
        // Not read this time: what was known stays, marked unreachable.
        for (const [key, container] of previous) {
          if (container.environmentId === environment.id) containers.set(key, container);
        }
        continue;
      }
      for (const container of list) {
        if (total >= LIMITS.CONTAINERS) break;
        total += 1;
        const key = keyOf(environment.id, container.name);
        const entry = { environmentId: environment.id, ...container };
        const known = previous.get(key);
        if (this.inFlight.has(key)) {
          // A stop / restart sent by Gladys is still at work in Docker: its
          // passing states are not published and fire nothing (the user asked
          // for it); the state follows when Docker answers.
          containers.set(
            key,
            known
              ? { ...entry, running: known.running, stopped: known.stopped, state: known.state }
              : entry,
          );
          continue;
        }
        containers.set(key, entry);
        // The first reading of an environment (start, after an outage) fires nothing.
        const was = before?.reachable ? known : undefined;
        if (!was) continue;
        if (was.running && !container.running && container.stopped) {
          events.push({ environment, container, problem: PROBLEMS.STOPPED });
        }
        if (container.health === 'unhealthy' && was.health !== 'unhealthy') {
          events.push({ environment, container, problem: PROBLEMS.UNHEALTHY });
        }
      }
    }
    this.environments = environments;
    this.containers = containers;
    this.skipped = skipped;
    this.online = true;
    this.retryDelay = INTERVALS.RETRY_MIN_MS;

    const discoveredKey = JSON.stringify([
      [...environments.values()].map((e) => [e.id, e.name]),
      [...containers.keys()],
    ]);
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    this.discoveredKey = discoveredKey;
    await this.publishStatusStates();
    await this.publishTransports();
    for (const event of events.slice(0, LIMITS.EVENTS_PER_ROUND)) await this.fire(event);
    if (events.length > LIMITS.EVENTS_PER_ROUND) {
      this.logger.warn(`${events.length - LIMITS.EVENTS_PER_ROUND} container event(s) not sent`);
    }
    await this.setStatus(true, this.okMessage());
    return true;
  }

  okMessage() {
    if (this.environments.size === 0) return T.status.noEnvironment;
    let running = 0;
    let stopped = 0;
    for (const container of this.containers.values()) {
      if (!this.environments.get(container.environmentId)?.reachable) continue;
      if (container.running) running += 1;
      else if (container.stopped) stopped += 1;
    }
    const down = [...this.environments.values()].filter((e) => !e.reachable).length;
    return T.status.ok({
      environments: this.environments.size,
      running,
      stopped,
      down,
      skipped: this.skipped,
    });
  }

  async fire({ environment, container, problem }) {
    await this.gladys
      .publishSceneEvent(SCENE_TRIGGERS.CONTAINER_PROBLEM, {
        container: containerIds(this.gladys, environment.id, container.name).device,
        container_name: container.name,
        environment_name: environment.name,
        problem,
      })
      .catch((err) => {
        this.logger.warn(`Scene event not sent: ${err.message}`);
      });
  }

  /** Never throws: a refusal of Gladys is not a Portainer failure. */
  async publishDiscovered() {
    const withEnvironment = this.environments.size > 1;
    const devices = [];
    for (const environment of this.environments.values()) {
      devices.push(buildEnvironmentDevice(this.gladys, environment));
    }
    for (const container of this.containers.values()) {
      const environment = this.environments.get(container.environmentId);
      if (environment) {
        devices.push(
          buildContainerDevice(this.gladys, environment, container, { withEnvironment }),
        );
      }
    }
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): read again when connected, else what is known. */
  async publishDiscovery() {
    if (this.online && !this.paused()) {
      const generation = this.generation;
      const applied = await this.refreshStatus({ publish: true }).catch(async (err) => {
        // A 429 pauses every path (the status says so); anything else: what is known.
        if (err?.status === 429) await this.failed(err, generation);
        return false;
      });
      if (applied) return;
    }
    await this.publishDiscovered();
  }

  /** Running, health (created containers) and the counts (created environments). */
  statusStates() {
    const created = createdDevices(this.gladys);
    const states = [];
    for (const { environmentId, name } of created.containers) {
      const environment = this.environments.get(environmentId);
      if (!environment?.reachable) continue; // unknown: nothing published
      const ids = containerIds(this.gladys, environmentId, name);
      const container = this.containers.get(keyOf(environmentId, name));
      // A container gone from a reachable environment does not run.
      states.push({
        device_feature_external_id: ids.feature(FEATURES.RUNNING),
        state: container?.running ? 1 : 0,
      });
      if (container?.health === 'healthy' || container?.health === 'unhealthy') {
        states.push({
          device_feature_external_id: ids.feature(FEATURES.HEALTHY),
          state: container.health === 'healthy' ? 1 : 0,
        });
      }
    }
    for (const { environmentId } of created.environments) {
      const environment = this.environments.get(environmentId);
      if (!environment?.reachable) continue;
      let running = 0;
      let stopped = 0;
      for (const container of this.containers.values()) {
        if (container.environmentId !== environmentId) continue;
        if (container.running) running += 1;
        else if (container.stopped) stopped += 1;
      }
      const ids = environmentIds(this.gladys, environmentId);
      states.push(
        { device_feature_external_id: ids.feature(FEATURES.RUNNING_COUNT), state: running },
        { device_feature_external_id: ids.feature(FEATURES.STOPPED_COUNT), state: stopped },
      );
    }
    return states;
  }

  /**
   * Publish states that changed. `optional`: the statistics, cut to what is
   * left of the minute budget (the others always go).
   */
  async publishStates(states, { optional = false } = {}) {
    let list = states;
    if (optional) {
      // The unchanged values cost nothing: the budget applies to the changes.
      list = list.filter((s) => this.publishedStats.get(s.device_feature_external_id) !== s.state);
      const remaining = this.budget.remaining();
      if (list.length > remaining) {
        this.logger.debug(`${list.length - remaining} statistic(s) held back (state budget)`);
        list = list.slice(0, remaining);
      }
    }
    if (list.length === 0) return;
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.budget.record(result?.count ?? list.length);
      if (optional) {
        for (const s of list) this.publishedStats.set(s.device_feature_external_id, s.state);
      }
    } catch (err) {
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  async publishStatusStates() {
    await this.publishStates(this.statusStates());
  }

  async publishTransports() {
    const entries = [];
    const created = createdDevices(this.gladys);
    for (const { environmentId, name, externalId } of created.containers) {
      const reachable =
        this.online &&
        this.environments.get(environmentId)?.reachable &&
        this.containers.has(keyOf(environmentId, name));
      entries.push({ external_id: externalId, transport: reachable ? 'local' : 'unreachable' });
    }
    for (const { environmentId, externalId } of created.environments) {
      const reachable = this.online && this.environments.get(environmentId)?.reachable;
      entries.push({ external_id: externalId, transport: reachable ? 'local' : 'unreachable' });
    }
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    if (changed.length === 0) return;
    // The SDK takes 100 entries per call (500 containers can change at once).
    for (let start = 0; start < changed.length; start += TRANSPORTS_PER_CALL) {
      const batch = changed.slice(start, start + TRANSPORTS_PER_CALL);
      for (const entry of batch) this.transports.set(entry.external_id, entry.transport);
      await this.gladys.publishTransports(batch).catch((err) => {
        for (const entry of batch) this.transports.delete(entry.external_id);
        this.logger.debug(`Transports not published: ${err.message}`);
      });
    }
  }

  // --- Statistics: CPU and memory ----------------------------------------------
  //
  // Docker computes the statistics of a container on demand, and waits about
  // a second for a second CPU sample: they are read only for the containers
  // created in Gladys that run, 25 per round at most (the next ones at the
  // next round), 3 at a time. A stopped container gets 0 without a request.
  // A failure never touches the status (running, health, counts).

  async statsLoop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    if (this.online && !this.paused() && !this.statsRunning) {
      this.statsRunning = true;
      try {
        await this.readStats(generation, epoch);
      } catch (err) {
        if (!this.current(generation, epoch)) return;
        if (err?.status === 429) {
          await this.failed(err, generation);
          return;
        }
        this.logger.debug(`Statistics not read: ${err.message}`);
      } finally {
        this.statsRunning = false;
      }
    }
    if (this.current(generation, epoch)) {
      this.scheduleLoop(this.config.statsSeconds * 1000, this.statsLoop, generation);
    }
  }

  async readStats(generation, epoch) {
    const client = this.client;
    if (!client) return;
    const states = [];
    const zeros = [];
    const running = [];
    for (const { environmentId, name } of createdDevices(this.gladys).containers) {
      if (!this.environments.get(environmentId)?.reachable) continue;
      const container = this.containers.get(keyOf(environmentId, name));
      if (!container) continue;
      const ids = containerIds(this.gladys, environmentId, name);
      if (container.running) {
        running.push({ container, ids });
      } else {
        zeros.push(
          { device_feature_external_id: ids.feature(FEATURES.CPU), state: 0 },
          { device_feature_external_id: ids.feature(FEATURES.MEMORY), state: 0 },
        );
      }
    }
    // In turn: a round starts where the previous one stopped.
    const count = Math.min(running.length, LIMITS.STATS_PER_ROUND);
    const start = running.length > 0 ? this.statsCursor % running.length : 0;
    const picked = Array.from({ length: count }, (_, i) => running[(start + i) % running.length]);
    this.statsCursor = start + count;
    let busy = null;
    let next = 0;
    const worker = async () => {
      while (next < picked.length && !busy) {
        const { container, ids } = picked[next++];
        if (!this.current(generation, epoch) || client !== this.client) return;
        try {
          const { cpu, memory } = await client.stats(container.environmentId, container.id);
          if (cpu !== null)
            states.push({ device_feature_external_id: ids.feature(FEATURES.CPU), state: cpu });
          if (memory !== null) {
            states.push({
              device_feature_external_id: ids.feature(FEATURES.MEMORY),
              state: memory,
            });
          }
        } catch (err) {
          if (err?.status === 429) busy = err;
          else this.logger.debug(`No statistics for ${container.name}: ${err.message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: LIMITS.STATS_CONCURRENCY }, worker));
    if (busy) throw busy;
    if (!this.current(generation, epoch) || client !== this.client) return;
    // The figures read first, the zeros of the stopped containers after.
    await this.publishStates([...states, ...zeros], { optional: true });
  }

  // --- Commands --------------------------------------------------------------
  //
  // Start, stop and restart are three buttons (never a switch: the core hands
  // every switch to the voice assistants, MCP and the switch scene actions).
  // All three are refused unless the user allowed them
  // (`allow_container_control`, off by default), checked when the command
  // arrives AND just before it is sent. Stop and restart are always refused
  // for Gladys (labels of the core, image, name), Portainer and its agent, any
  // container that reaches the Docker socket, and this integration's own
  // container, on the fresh reading of the container. Commands are chained
  // per container (one at a time on a container, two containers never wait
  // for each other: a scene stopping web then db stops both), use the client
  // of the moment they arrived (a new configuration in between refuses them),
  // and read the container from Docker just before acting: unknown, the
  // command is refused; already in the state asked, nothing is sent. Gladys
  // waits 5 s: past 3.5 s after the command arrived, nothing is sent any
  // more. Docker answers a stop once the container stopped (10 s of grace by
  // default): Gladys gets its answer at most 4.3 s after the command, "sent",
  // and the state follows when Docker is done.

  async setValue(device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (parsed?.kind !== 'container') throw new Error(T.errors.unknownDevice);
    const action = {
      [FEATURES.START]: 'start',
      [FEATURES.STOP]: 'stop',
      [FEATURES.RESTART]: 'restart',
    }[parsed.feature];
    // `running` is a reading, never a command.
    if (!action) throw new Error(T.errors.unknownDevice);
    if (Number(value) !== 1) throw new Error(T.errors.invalidValue);
    if (!this.config.allowControl) throw new Error(T.errors.controlDisabled);
    const client = this.client;
    if (!client || this.blocked) throw new Error(T.errors.notConnected);
    if (this.paused()) throw new Error(T.errors.busy);
    const key = keyOf(parsed.environmentId, parsed.name);
    if (this.inFlight.has(key)) throw new Error(T.errors.stillRunning);
    const generation = this.generation;

    const previous = this.chains.get(key) ?? Promise.resolve();
    const run = previous.then(() =>
      this.command(received, { client, generation, parsed, key, action }),
    );
    const chain = run.catch(() => {});
    this.chains.set(key, chain);
    chain.then(() => {
      if (this.chains.get(key) === chain) this.chains.delete(key);
    });
    return run;
  }

  /** The client, the configuration and the permission are still those of the command. */
  stillValid({ client, generation }) {
    if (client !== this.client || generation !== this.generation || this.blocked) {
      throw new Error(T.errors.configChanged);
    }
    if (!this.config.allowControl) throw new Error(T.errors.controlDisabled);
    if (this.paused()) throw new Error(T.errors.busy);
  }

  async command(received, { client, generation, parsed, key, action }) {
    this.activeCommands += 1;
    this.stateVersion += 1;
    try {
      this.stillValid({ client, generation });
      if (this.inFlight.has(key)) throw new Error(T.errors.stillRunning);
      const deadline = received + COMMAND_BUDGET_MS;
      if (deadline - this.now() < COMMAND_MIN_READ_MS) throw new Error(T.errors.tooSlow);
      let current;
      try {
        current = await client.inspect(parsed.environmentId, parsed.name, {
          deadline: deadline - COMMAND_MIN_SEND_MS,
        });
      } catch (err) {
        await this.throwIfBusy(err, generation);
        throw new Error(T.errors.unknownState(err), { cause: err });
      }
      if (!current || current.name !== parsed.name) throw new Error(T.errors.unknownContainer);
      if (action !== 'start') {
        const listed = this.containers.get(key);
        const why =
          protectionOf(current, this.selfId) ?? (listed ? protectionOf(listed, this.selfId) : null);
        if (why) throw new Error(T.errors.protected(parsed.name, why));
      }
      if ((action === 'start' && current.running) || (action === 'stop' && !current.running)) {
        this.observed(key, current);
        await this.publishStatusStates();
        return;
      }
      if (deadline - this.now() < COMMAND_MIN_SEND_MS) throw new Error(T.errors.tooSlow);
      // The last check before acting: the user may have changed things meanwhile.
      this.stillValid({ client, generation });
      await this.send({ client, generation, parsed, key, action, current, received, deadline });
    } finally {
      this.stateVersion += 1;
      this.activeCommands -= 1;
    }
  }

  /** Send, then answer Gladys on Docker's answer or at COMMAND_ACK_MS, whichever first. */
  async send({ client, generation, parsed, key, action, current, received, deadline }) {
    let sent = false;
    const expected = action === 'stop' ? 'exited' : 'running';
    const settle = () => {
      this.observed(key, {
        ...current,
        running: expected === 'running',
        stopped: expected !== 'running',
        state: expected,
      });
    };
    this.inFlight.set(key, { expected });
    const request = client
      .command(parsed.environmentId, current.id, action, {
        deadline,
        onSent: () => {
          sent = true;
        },
      })
      .then(
        // Done: the state asked becomes the known state BEFORE the key leaves
        // inFlight, so the next reading compares with it (no "stopped" event
        // for a stop the user asked).
        () => settle(),
        (err) => {
          throw err;
        },
      )
      .finally(() => {
        this.inFlight.delete(key);
        this.stateVersion += 1;
      });
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, Math.max(0, received + COMMAND_ACK_MS - this.now()));
    });
    const outcome = await Promise.race([
      request.then(
        () => ({ done: true }),
        (err) => ({ err }),
      ),
      ack.then(() => ({ pending: true })),
    ]);
    this.timers.clearTimeout(handle);
    if (outcome.done) {
      await this.publishStatusStates();
      this.refreshSoon(generation);
      return;
    }
    if (outcome.pending) {
      // Sent, Docker still at work: Gladys is answered now, the state follows.
      this.logger.info(`${action} of ${parsed.name} sent, Docker still at work`);
      request
        .then(
          async () => {
            this.logger.info(`${action} of ${parsed.name} done`);
            if (generation === this.generation) await this.publishStatusStates();
          },
          (err) => this.logger.warn(`${action} of ${parsed.name} failed: ${err.message}`),
        )
        .finally(() => this.refreshSoon(generation));
      return;
    }
    const { err } = outcome;
    await this.throwIfBusy(err, generation);
    if (err.notSent || !sent) throw new Error(T.errors.notSent(err), { cause: err });
    this.refreshSoon(generation);
    throw new Error(T.errors.refused(err), { cause: err });
  }

  /** What a command just read or did, until the next reading. */
  observed(key, container) {
    const known = this.containers.get(key);
    if (!known) return;
    this.containers.set(key, {
      ...known,
      id: container.id ?? known.id,
      running: container.running,
      stopped: container.stopped ?? (container.running ? false : known.stopped),
      state: container.state ?? known.state,
    });
  }

  /** Read the truth again in a moment (after a command). */
  refreshSoon(generation) {
    if (generation !== this.generation) return;
    this.schedule(INTERVALS.AFTER_COMMAND_MS, async () => {
      if (generation !== this.generation || !this.online || this.paused()) return;
      await this.refreshStatus({ publish: false }).catch(async (err) => {
        // A 429 pauses every path; anything else waits for the status loop.
        if (err?.status === 429) await this.failed(err, generation);
        else this.logger.debug(`Reading after a command failed: ${err.message}`);
      });
    });
  }

  // --- Devices created / deleted in Gladys -----------------------------------

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    // The SDK forgot the values of this device: so do the statistics.
    this.publishedStats.clear();
    if (!parsed || !this.online) return;
    await this.publishStatusStates();
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Configuration buttons -------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /** Reconnects (a refused token included: the user asked), then reports, within 25 s. */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig, { force: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      const message = this.lastStatus ? JSON.parse(this.lastStatus)[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok({ environments: this.environments.size, containers: this.containers.size });
  }

  /** Forget the pinned certificate and reconnect (the new one gets pinned), in the start queue. */
  async trustNewCertificate() {
    const { allowSelfSigned, fingerprint, portainer } = this.config;
    if (!allowSelfSigned || fingerprint || !portainer) throw new Error(T.errors.selfSignedOff);
    await this.within(
      this.enqueue(async () => {
        await this.store.load();
        await this.store.set('tlsPins', `${portainer.hostname}:${portainer.port}`, null);
        await this.run(this.rawConfig, { force: true });
      }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    return T.test.trusted;
  }
}
