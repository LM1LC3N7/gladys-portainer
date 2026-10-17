// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys, the trigger keys and the
// external id shapes are stored in user scenes and devices: never rename them
// (test/manifest.test.js ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
  TRUST_CERTIFICATE: 'trust_new_certificate',
});

export const SCENE_TRIGGERS = Object.freeze({
  CONTAINER_PROBLEM: 'container_problem',
});

/** The `problem` of the `container_problem` event (and its filter). */
export const PROBLEMS = Object.freeze({ STOPPED: 'stopped', UNHEALTHY: 'unhealthy' });

/** Device external ids: `ext:<selector>:container:<environment id>-<container name>`. */
export const CONTAINER_TYPE = 'container';
/** `ext:<selector>:environment:<environment id>`. */
export const ENVIRONMENT_TYPE = 'environment';

export const FEATURES = Object.freeze({
  RUNNING: 'running',
  HEALTHY: 'healthy',
  CPU: 'cpu',
  MEMORY: 'memory',
  RESTART: 'restart',
  RUNNING_COUNT: 'running_count',
  STOPPED_COUNT: 'stopped_count',
});

/** Seconds between two rounds of statistics (CPU, memory); '0' reads none. */
export const STATS_INTERVALS = Object.freeze(['0', '60', '120', '300', '600']);

/**
 * Portainer environment types whose Docker API is reached through
 * /api/endpoints/{id}/docker: 1 Docker (socket or API), 2 Portainer agent.
 * Edge agents (4) answer through a tunnel opened on demand and Kubernetes
 * (5, 6, 7) has no Docker API: both are left out (TODO.md, "Decisions").
 */
export const DOCKER_ENVIRONMENT_TYPES = Object.freeze([1, 2]);
/** Portainer environment status: 1 up, 2 down. */
export const ENVIRONMENT_UP = 1;

/** Docker container states counted as stopped (`exited`, `dead`, `created`). */
export const STOPPED_STATES = Object.freeze(['exited', 'dead', 'created']);

/** Caps: what is published, read and remembered. */
export const LIMITS = Object.freeze({
  ENVIRONMENTS: 20,
  CONTAINERS: 500,
  /** Containers whose statistics are read in one round (rotation beyond). */
  STATS_PER_ROUND: 25,
  /** Statistics requests in flight at once (each one takes about 1 s in Docker). */
  STATS_CONCURRENCY: 3,
  /** Scene events sent in one round (a whole host stopping sends no flood). */
  EVENTS_PER_ROUND: 30,
  /**
   * POST /state admits 300 states per minute per integration: this
   * integration keeps under 250, the statistics being dropped first.
   */
  STATES_PER_MINUTE: 250,
});

export const TIMEOUTS = Object.freeze({
  API: 10_000,
  STATS: 10_000,
  /**
   * A stop or restart answers once Docker stopped the container (10 s of
   * grace by default, more when the container says so): the request is
   * kept open this long, the answer to Gladys does not wait (see the commands).
   */
  COMMAND: 120_000,
});

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent to Portainer
 * (an action must never run after Gladys showed a failure).
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Room kept after the fresh read for the command request itself. */
export const COMMAND_MIN_SEND_MS = 1_000;
/** Room needed to start the fresh read at all. */
export const COMMAND_MIN_READ_MS = 1_500;
/**
 * Once the command is sent, Gladys gets its answer at the latest this long
 * after the command arrived: a stop still running in Docker then is
 * acknowledged as "sent", and the state follows when Docker is done.
 */
export const COMMAND_ACK_MS = 4_300;

export const INTERVALS = Object.freeze({
  STATUS_MS: 30_000, // containers (state, health) of every environment
  RETRY_MIN_MS: 30_000, // Portainer unreachable: first retry
  RETRY_MAX_MS: 10 * 60_000,
  /** HTTP 429: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /** After a command without an answer in time: the state is read again. */
  AFTER_COMMAND_MS: 2_000,
});

/** Size caps of the answers read from Portainer. */
export const MAX_BYTES = Object.freeze({
  ENDPOINTS: 8 * 1024 * 1024,
  CONTAINERS: 8 * 1024 * 1024,
  INSPECT: 2 * 1024 * 1024,
  STATS: 512 * 1024,
  COMMAND: 64 * 1024,
});

/** The persistent store (TLS pin, refusals, pause: see src/store.js). */
export const STORE_FILE = 'portainer.json';
