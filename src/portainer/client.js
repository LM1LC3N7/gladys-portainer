// -----------------------------------------------------------------------------
// The REST API of Portainer CE / BE 2.x, with an access token:
//   GET  /api/endpoints?excludeSnapshots=true                  the environments
//   GET  /api/endpoints/{id}/docker/containers/json?all=1      the containers
//   GET  /api/endpoints/{id}/docker/containers/{name}/json     one container
//   GET  /api/endpoints/{id}/docker/containers/{id}/stats?stream=false
//   POST /api/endpoints/{id}/docker/containers/{id}/start|stop|restart
// The token goes in the `X-API-Key` header only (never in a URL, never in a
// log). Everything under /docker/ is the Docker Engine API, proxied.
// -----------------------------------------------------------------------------

import { MAX_BYTES, TIMEOUTS } from '../constants.js';
import { CODES, PortainerError } from './errors.js';
import { httpRequest } from './http.js';
import { computeStats, parseContainers, parseEnvironments, parseInspect } from './parse.js';

/** Room a request needs before its deadline, or it is not sent at all. */
const MIN_SEND_MS = 300;

const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Seconds of a Retry-After header (delta form only), in ms, or null. */
const retryAfterMs = (value) => {
  const seconds = asNumber(Array.isArray(value) ? value[0] : value);
  return seconds !== null && seconds >= 0 ? seconds * 1000 : null;
};

const notSent = (err) => {
  if (err && typeof err === 'object') err.notSent = true;
  return err;
};

export const COMMANDS = Object.freeze(['start', 'stop', 'restart']);

export class PortainerClient {
  /**
   * @param {object} options
   * @param {{ base: string, hostname: string, port: number }} options.portainer
   * @param {string} options.token the access token
   * @param {string | null} [options.fingerprint] SHA-256 fingerprint typed by the user
   * @param {boolean} [options.allowSelfSigned] trust on first use
   * @param {import('../store.js').Store} options.store loaded store
   * @param {Function} [options.request] the HTTP transport (tests inject a fake Portainer)
   * @param {() => number} [options.now]
   */
  constructor({
    portainer,
    token,
    fingerprint = null,
    allowSelfSigned = false,
    store,
    request = httpRequest,
    now = Date.now,
  }) {
    this.portainer = portainer;
    this.token = token;
    this.fingerprint = fingerprint;
    this.allowSelfSigned = allowSelfSigned;
    this.store = store;
    this.request = request;
    this.now = now;
    this.tlsKey = `${portainer.hostname}:${portainer.port}`;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  tlsOptions() {
    if (this.fingerprint) return { fingerprint: this.fingerprint };
    if (!this.allowSelfSigned) return {};
    return {
      trustOnFirstUse: true,
      pin: this.store.get('tlsPins', this.tlsKey),
      onPin: (fingerprint) => {
        this.store.set('tlsPins', this.tlsKey, fingerprint);
      },
    };
  }

  timeoutFor(deadline, fallback) {
    if (deadline === undefined) return fallback;
    const remaining = deadline - this.now();
    if (remaining < MIN_SEND_MS) {
      throw notSent(new PortainerError(CODES.NO_TIME, 'No time left: request not sent'));
    }
    return Math.min(fallback, remaining);
  }

  /**
   * One HTTP exchange. Resolves the parsed JSON (null for 204 and 304);
   * rejects a PortainerError (HTTP with its status for anything else).
   */
  async call(
    path,
    {
      method = 'GET',
      query,
      maxBytes,
      timeout = TIMEOUTS.API,
      deadline,
      sendWithin,
      onSent,
      json = true,
    } = {},
  ) {
    if (this.closed) throw notSent(new PortainerError(CODES.CLOSED, 'Client closed'));
    const url = new URL(`${this.portainer.base}${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const response = await this.request(url.toString(), {
      method,
      headers: { 'x-api-key': this.token },
      timeout: this.timeoutFor(deadline, timeout),
      sendWithin,
      maxBytes,
      onSent,
      tls: this.tlsOptions(),
    });
    if (response.status === 204 || response.status === 304) return null;
    if (response.status < 200 || response.status > 299) {
      throw new PortainerError(CODES.HTTP, `HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
        path,
      });
    }
    if (!json) return null;
    try {
      return JSON.parse(response.body.toString('utf8'));
    } catch {
      throw new PortainerError(CODES.BAD_ANSWER, 'Not JSON', { path });
    }
  }

  async environments() {
    const json = await this.call('/api/endpoints', {
      query: { excludeSnapshots: 'true' },
      maxBytes: MAX_BYTES.ENDPOINTS,
    });
    const parsed = parseEnvironments(json);
    if (!parsed) throw new PortainerError(CODES.BAD_ANSWER, 'Not a list of environments');
    return parsed;
  }

  docker(environmentId, path) {
    return `/api/endpoints/${encodeURIComponent(environmentId)}/docker${path}`;
  }

  async containers(environmentId) {
    const json = await this.call(this.docker(environmentId, '/containers/json'), {
      query: { all: '1' },
      maxBytes: MAX_BYTES.CONTAINERS,
    });
    const parsed = parseContainers(json);
    if (!parsed) throw new PortainerError(CODES.BAD_ANSWER, 'Not a list of containers');
    return parsed;
  }

  /** One container by its name (or id); null when Docker has none (404). */
  async inspect(environmentId, nameOrId, { deadline } = {}) {
    let json;
    try {
      json = await this.call(
        this.docker(environmentId, `/containers/${encodeURIComponent(nameOrId)}/json`),
        { maxBytes: MAX_BYTES.INSPECT, deadline },
      );
    } catch (err) {
      if (err.code === CODES.HTTP && err.status === 404) return null;
      throw err;
    }
    const parsed = parseInspect(json);
    if (!parsed) throw new PortainerError(CODES.BAD_ANSWER, 'Not a container');
    return parsed;
  }

  async stats(environmentId, containerId) {
    const json = await this.call(
      this.docker(environmentId, `/containers/${encodeURIComponent(containerId)}/stats`),
      { query: { stream: 'false' }, maxBytes: MAX_BYTES.STATS, timeout: TIMEOUTS.STATS },
    );
    return computeStats(json);
  }

  /** start | stop | restart. Resolves once Docker answered (204, or 304: already so). */
  async command(environmentId, containerId, action, { deadline, onSent } = {}) {
    if (!COMMANDS.includes(action)) throw new Error(`Unknown command ${action}`);
    // The deadline bounds the moment it is SENT (no room left: not sent);
    // the answer may take longer (a stop waits for the container).
    const sendWithin = this.timeoutFor(deadline, TIMEOUTS.COMMAND);
    await this.call(
      this.docker(environmentId, `/containers/${encodeURIComponent(containerId)}/${action}`),
      {
        method: 'POST',
        maxBytes: MAX_BYTES.COMMAND,
        timeout: TIMEOUTS.COMMAND,
        sendWithin,
        onSent,
        json: false,
      },
    );
  }
}
