// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   container    `ext:<selector>:container:<environment id>-<container name>`
//                one per Docker container: running (switch: start / stop),
//                healthy, CPU, memory, restart (button)
//   environment  `ext:<selector>:environment:<environment id>`
//                one per Portainer environment: containers running / stopped
//
// The Docker id of a container changes every time it is recreated (an image
// update, `docker compose up`): the external id uses its NAME, stable across
// recreations, and the id Portainer gives the environment.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { CONTAINER_TYPE, ENVIRONMENT_TYPE, FEATURES } from './constants.js';
import { NAME_PATTERN } from './portainer/parse.js';

export const containerIds = (gladys, environmentId, name) =>
  gladys.externalIds(CONTAINER_TYPE, `${environmentId}-${name}`);
export const environmentIds = (gladys, environmentId) =>
  gladys.externalIds(ENVIRONMENT_TYPE, String(environmentId));

const readOnly = (extra) => ({ read_only: true, has_feedback: false, ...extra });

/**
 * @param {object} gladys
 * @param {{ id: number, name: string }} environment
 * @param {{ name: string, image: string }} container
 * @param {{ withEnvironment?: boolean }} [options] add the environment to the name
 */
export function buildContainerDevice(gladys, environment, container, { withEnvironment } = {}) {
  const ids = containerIds(gladys, environment.id, container.name);
  return {
    name: withEnvironment ? `${container.name} (${environment.name})` : container.name,
    external_id: ids.device,
    model: (container.image || 'Docker container').slice(0, 200),
    should_poll: false,
    features: [
      {
        name: 'Running',
        external_id: ids.feature(FEATURES.RUNNING),
        // On: start, off: stop (both refused unless allowed in the configuration).
        category: C.SWITCH,
        type: T.SWITCH.BINARY,
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: true,
        keep_history: true,
      },
      {
        name: 'Healthy',
        external_id: ids.feature(FEATURES.HEALTHY),
        // No core category for the health of a service: `unknown`, binary
        // (1 healthy, 0 unhealthy; nothing without a healthcheck).
        ...readOnly({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
        keep_history: true,
      },
      {
        name: 'CPU (%)',
        external_id: ids.feature(FEATURES.CPU),
        // No core category lists a percent for a processor load: no unit
        // (TODO.md, "Decisions"); 100 = one CPU busy, like `docker stats`.
        ...readOnly({ category: C.UNKNOWN, type: T.SENSOR.DECIMAL, min: 0, max: 25_600 }),
        keep_history: true,
      },
      {
        name: 'Memory',
        external_id: ids.feature(FEATURES.MEMORY),
        ...readOnly({
          category: C.DATA,
          type: T.DATA.SIZE,
          unit: U.MEGABYTE,
          min: 0,
          max: 10_000_000,
        }),
        keep_history: true,
      },
      {
        name: 'Restart',
        external_id: ids.feature(FEATURES.RESTART),
        category: C.BUTTON,
        type: T.BUTTON.PUSH,
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

export function buildEnvironmentDevice(gladys, environment) {
  const ids = environmentIds(gladys, environment.id);
  const counter = (key, name) => ({
    name,
    external_id: ids.feature(key),
    ...readOnly({ category: C.COUNTER_SENSOR, type: T.SENSOR.INTEGER, min: 0, max: 100_000 }),
    keep_history: true,
  });
  return {
    name: `Portainer: ${environment.name}`,
    external_id: ids.device,
    model: 'Portainer environment',
    should_poll: false,
    features: [
      counter(FEATURES.RUNNING_COUNT, 'Containers running'),
      counter(FEATURES.STOPPED_COUNT, 'Containers stopped'),
    ],
  };
}

/**
 * What a device or feature external id of this integration designates:
 * { kind: 'container', environmentId, name, feature } |
 * { kind: 'environment', environmentId, feature } | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const containerPrefix = gladys.externalId(`${CONTAINER_TYPE}:`);
  if (externalId.startsWith(containerPrefix)) {
    const [platformId, feature, ...rest] = externalId.slice(containerPrefix.length).split(':');
    const match = /^(\d+)-(.+)$/.exec(platformId ?? '');
    if (rest.length > 0 || !match || !NAME_PATTERN.test(match[2])) return null;
    return {
      kind: 'container',
      environmentId: Number(match[1]),
      name: match[2],
      feature: feature ?? null,
    };
  }
  const environmentPrefix = gladys.externalId(`${ENVIRONMENT_TYPE}:`);
  if (externalId.startsWith(environmentPrefix)) {
    const [id, feature, ...rest] = externalId.slice(environmentPrefix.length).split(':');
    if (rest.length > 0 || !/^\d+$/.test(id ?? '')) return null;
    return { kind: 'environment', environmentId: Number(id), feature: feature ?? null };
  }
  return null;
}

/** The created devices of this integration: { containers: [...], environments: [...] }. */
export function createdDevices(gladys, devices = gladys.devices) {
  const containers = [];
  const environments = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    const entry = { ...parsed, externalId: device.external_id };
    if (parsed.kind === 'container') containers.push(entry);
    else environments.push(entry);
  }
  return { containers, environments };
}
