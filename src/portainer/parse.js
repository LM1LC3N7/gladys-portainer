// -----------------------------------------------------------------------------
// The answers of Portainer and of the Docker API it proxies, read into small
// plain objects (pure functions). Anything unexpected is left out or unknown
// (null), never guessed.
//
// The fields read follow the Portainer API (GET /api/endpoints: Id, Name,
// Type, Status) and the Docker Engine API it proxies (containers/json, json,
// stats), like tomaae/homeassistant-portainer (Apache-2.0): see
// THIRD_PARTY_NOTICES.md. The CPU and memory figures are those of the
// `docker stats` command.
// -----------------------------------------------------------------------------

import {
  DOCKER_ENVIRONMENT_TYPES,
  ENVIRONMENT_UP,
  GLADYS_LABEL_PREFIX,
  STOPPED_STATES,
} from '../constants.js';

/** A Docker container name, as Docker accepts it (no `:`, no `/`). */
export const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' ? value : null);
const integer = (value) => (Number.isSafeInteger(value) ? value : null);

/**
 * GET /api/endpoints -> { environments: [{ id, name, type, up }], skipped }
 * (Docker environments only; `skipped`: the others, Edge or Kubernetes).
 */
export function parseEnvironments(json) {
  if (!Array.isArray(json)) return null;
  const environments = [];
  let skipped = 0;
  for (const raw of json) {
    if (!isObject(raw)) continue;
    const id = integer(raw.Id);
    if (id === null || id < 0) continue;
    if (!DOCKER_ENVIRONMENT_TYPES.includes(raw.Type)) {
      skipped += 1;
      continue;
    }
    environments.push({
      id,
      name: text(raw.Name)?.trim() || `Environment ${id}`,
      type: raw.Type,
      up: raw.Status === ENVIRONMENT_UP,
    });
  }
  environments.sort((a, b) => a.id - b.id);
  return { environments, skipped };
}

/** healthy | unhealthy | starting | null (no healthcheck, or unknown). */
export function healthOf(raw) {
  const status = text(raw?.Health?.Status) ?? text(raw?.State?.Health?.Status);
  if (status === 'healthy' || status === 'unhealthy' || status === 'starting') return status;
  // The list of Docker gives the health in its text: "Up 2 hours (healthy)".
  const summary = text(raw?.Status) ?? '';
  if (/\(unhealthy\)/.test(summary)) return 'unhealthy';
  if (/\(health: starting\)/.test(summary)) return 'starting';
  if (/\(healthy\)/.test(summary)) return 'healthy';
  return null;
}

/** Does the container carry a label of the Gladys core (`io.gladysassistant.*`)? */
function hasGladysLabel(labels) {
  if (!isObject(labels)) return false;
  return Object.keys(labels).some((key) => key.toLowerCase().startsWith(GLADYS_LABEL_PREFIX));
}

const DOCKER_SOCKET = /(^|\/)docker\.sock$/;

/**
 * Does the container reach the Docker socket (a bind of `docker.sock`, or a
 * socket proxy)? Such a container manages the others: Portainer, its agent,
 * the Gladys core, a socket proxy, Watchtower...
 */
function mountsDockerSocket(mounts, binds) {
  const paths = [];
  for (const mount of Array.isArray(mounts) ? mounts : []) {
    if (!isObject(mount)) continue;
    paths.push(text(mount.Source), text(mount.Destination));
  }
  for (const bind of Array.isArray(binds) ? binds : []) {
    paths.push(
      ...String(bind ?? '')
        .split(':')
        .slice(0, 2),
    );
  }
  return paths.some((path) => typeof path === 'string' && DOCKER_SOCKET.test(path.trim()));
}

/** A Docker state, lower case, or null. */
const stateOf = (value) =>
  typeof value === 'string' && /^[a-z]{1,16}$/.test(value) ? value : null;

/**
 * GET /docker/containers/json?all=1 -> [{ id, name, image, state, running,
 * stopped, health }]. A container without a usable name is left out.
 */
export function parseContainers(json) {
  if (!Array.isArray(json)) return null;
  const containers = [];
  const seen = new Set();
  for (const raw of json) {
    if (!isObject(raw)) continue;
    const id = text(raw.Id);
    const names = Array.isArray(raw.Names) ? raw.Names : [];
    // The first name without its leading slash (a link adds `/other/name` entries).
    const name = names
      .map((n) => text(n)?.replace(/^\//, ''))
      .find((n) => n && NAME_PATTERN.test(n));
    if (!id || !/^[0-9a-f]{12,64}$/.test(id) || !name || seen.has(name)) continue;
    seen.add(name);
    const state = stateOf(raw.State);
    containers.push({
      id,
      name,
      image: text(raw.Image) ?? '',
      state,
      running: state === 'running',
      stopped: state !== null && STOPPED_STATES.includes(state),
      health: healthOf(raw),
      gladysLabel: hasGladysLabel(raw.Labels),
      dockerSocket: mountsDockerSocket(raw.Mounts),
    });
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * GET /docker/containers/{name}/json -> { id, name, image, state, running }
 * or null. `image` is the reference the container was created from.
 */
export function parseInspect(json) {
  if (!isObject(json) || !isObject(json.State)) return null;
  const id = text(json.Id);
  const name = text(json.Name)?.replace(/^\//, '');
  if (!id || !/^[0-9a-f]{12,64}$/.test(id) || !name) return null;
  const running = json.State.Running;
  if (typeof running !== 'boolean') return null;
  return {
    id,
    name,
    image: text(json.Config?.Image) ?? '',
    state: stateOf(json.State.Status),
    running,
    health: healthOf(json),
    gladysLabel: hasGladysLabel(json.Config?.Labels),
    dockerSocket: mountsDockerSocket(json.Mounts, json.HostConfig?.Binds),
  };
}

/** Megabytes (10^6 bytes, the `megabyte` unit of Gladys). */
const MB = 1_000_000;
const round1 = (value) => Math.round(value * 10) / 10;
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * GET /docker/containers/{id}/stats?stream=false -> { cpu, memory } (each
 * null when it cannot be computed), like `docker stats`:
 *   cpu    % of one CPU times the CPUs online (400 % = 4 CPUs busy)
 *   memory MB (10^6 bytes) used, the page cache excluded (`inactive_file`
 *          on cgroup v2, `total_inactive_file` on cgroup v1); `docker stats`
 *          shows MiB, Gladys has megabytes
 */
export function computeStats(json) {
  if (!isObject(json)) return { cpu: null, memory: null };
  let cpu = null;
  const total = finite(json.cpu_stats?.cpu_usage?.total_usage);
  const preTotal = finite(json.precpu_stats?.cpu_usage?.total_usage);
  const system = finite(json.cpu_stats?.system_cpu_usage);
  const preSystem = finite(json.precpu_stats?.system_cpu_usage);
  if (total !== null && preTotal !== null && system !== null && preSystem !== null) {
    const cpuDelta = total - preTotal;
    const systemDelta = system - preSystem;
    const online =
      finite(json.cpu_stats.online_cpus) ||
      (Array.isArray(json.cpu_stats.cpu_usage.percpu_usage)
        ? json.cpu_stats.cpu_usage.percpu_usage.length
        : 0) ||
      1;
    if (systemDelta > 0 && cpuDelta >= 0) {
      cpu = round1(Math.min((cpuDelta / systemDelta) * online * 100, online * 100));
    }
  }
  let memory = null;
  const usage = finite(json.memory_stats?.usage);
  if (usage !== null && usage >= 0) {
    const stats = isObject(json.memory_stats.stats) ? json.memory_stats.stats : {};
    const cache =
      finite(stats.inactive_file) ?? finite(stats.total_inactive_file) ?? finite(stats.cache) ?? 0;
    const used = cache >= 0 && cache < usage ? usage - cache : usage;
    memory = round1(used / MB);
  }
  return { cpu, memory };
}

// --- Containers never stopped from Gladys -------------------------------------

/** Images of Portainer itself and of its agent. */
const PORTAINER_IMAGE =
  /(^|\/)portainer\/(portainer|portainer-ce|portainer-ee|portainer-be|agent)(?=[:@]|$)/i;
/** Images of Gladys: `gladysassistant/*`, or any repository named `gladys*`. */
const GLADYS_IMAGE = /(^|\/)(gladysassistant\/[^:@]+|gladys[^/:@]*)(?=[:@]|$)/i;
/** Names: `gladys...`, `portainer...` (`portainer_agent`, `gladys-zigbee2mqtt`...). */
const PROTECTED_NAME = /^(gladys|portainer)/i;

/**
 * Why a container may not be stopped or restarted from Gladys, or null:
 *   'self'       the container this integration runs in
 *   'gladys'     Gladys, its integrations and their sub-containers (labels
 *                of the core, image, name)
 *   'portainer'  Portainer and its agent (the way back to every container)
 *   'docker'     any container that reaches the Docker socket (it manages
 *                the others: the Gladys core, a socket proxy...)
 * Starting such a container stays possible.
 */
export function protectionOf({ id, name, image, gladysLabel, dockerSocket }, selfId = null) {
  if (selfId && typeof id === 'string' && id.startsWith(selfId)) return 'self';
  if (gladysLabel) return 'gladys';
  const ref = String(image ?? '');
  if (PORTAINER_IMAGE.test(ref)) return 'portainer';
  if (GLADYS_IMAGE.test(ref)) return 'gladys';
  const match = PROTECTED_NAME.exec(String(name ?? ''));
  if (match) return match[1].toLowerCase();
  if (dockerSocket) return 'docker';
  return null;
}

/**
 * The id of the container this process runs in: Docker sets HOSTNAME to the
 * first 12 characters of the container id (unless `hostname:` is set).
 */
export function selfContainerId(env = process.env) {
  const hostname = String(env.HOSTNAME ?? '');
  return /^[0-9a-f]{12}$/.test(hostname) ? hostname : null;
}
