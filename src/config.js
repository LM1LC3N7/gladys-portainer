// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { STATS_INTERVALS } from './constants.js';
import { normalizeFingerprint } from './portainer/http.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  allow_self_signed: false,
  allow_container_control: false,
  stats_interval: '60',
});

/** Portainer's own default ports. */
export const DEFAULT_PORTS = Object.freeze({ 'http:': 9000, 'https:': 9443 });

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * The address of Portainer: `https://host:port[/path]`, `http://...`, or a
 * bare `host[:port]` read as https (port 9443 when none is typed). A path is
 * kept (Portainer behind a reverse proxy), a trailing `/api` dropped.
 * Credentials, a query and a fragment are refused (an address ends up in logs).
 *   -> { base, origin, protocol, hostname, port } or { error: 'empty' | 'invalid' | 'credentials' }
 */
export function parsePortainerUrl(value) {
  const raw = text(value);
  if (!raw) return { error: 'empty' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { error: 'invalid' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'invalid' };
  if (url.username || url.password) return { error: 'credentials' };
  if (url.search || url.hash || !url.hostname) return { error: 'invalid' };
  const path = url.pathname
    .replace(/\/+$/, '')
    .replace(/\/api$/i, '')
    .replace(/\/+$/, '');
  if (path && !/^(\/[A-Za-z0-9._~%-]+)+$/.test(path)) return { error: 'invalid' };
  // `https://host:443` loses its port in URL (the default of the scheme):
  // read a typed port from the text itself.
  const typedPort = /^[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]]*\]|[^/:?#]*):(\d+)/i.exec(
    hasScheme ? raw : `https://${raw}`,
  );
  const port = typedPort ? Number(typedPort[1]) : DEFAULT_PORTS[url.protocol];
  if (!(port > 0 && port < 65536)) return { error: 'invalid' };
  const hostname = url.hostname.toLowerCase();
  const origin = `${url.protocol}//${hostname}:${port}`;
  return { base: `${origin}${path}`, origin, protocol: url.protocol, hostname, port };
}

/**
 * The environments to follow: ids and names, separated by commas or
 * semicolons (names compared without case). Empty: all of them.
 */
export function parseEnvironmentFilter(value) {
  const tokens = text(value)
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return {
    ids: new Set(tokens.filter((t) => /^\d+$/.test(t)).map(Number)),
    names: new Set(tokens.map((t) => t.toLowerCase())),
  };
}

export const matchesFilter = (filter, environment) =>
  !filter || filter.ids.has(environment.id) || filter.names.has(environment.name.toLowerCase());

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const portainer = parsePortainerUrl(raw.url);
  const pick = (key, list) => (list.includes(String(raw[key])) ? String(raw[key]) : DEFAULTS[key]);
  const typedFingerprint = text(raw.certificate_fingerprint);
  const fingerprint = typedFingerprint ? normalizeFingerprint(typedFingerprint) : null;
  return {
    portainer: portainer.error ? null : portainer,
    urlError: portainer.error ?? null,
    token: typeof raw.token === 'string' ? raw.token.trim() : '',
    allowSelfSigned: bool(raw.allow_self_signed, DEFAULTS.allow_self_signed),
    fingerprint,
    fingerprintInvalid: typedFingerprint !== '' && fingerprint === null,
    filter: parseEnvironmentFilter(raw.environments),
    allowControl: bool(raw.allow_container_control, DEFAULTS.allow_container_control),
    statsSeconds: Number(pick('stats_interval', STATS_INTERVALS)),
  };
}
