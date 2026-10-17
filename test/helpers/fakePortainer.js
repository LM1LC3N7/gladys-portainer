// -----------------------------------------------------------------------------
// A fake Portainer (in memory, or on loopback through listen()): the REST API
// the integration uses, with the Docker answers it proxies. The shapes come
// from the Portainer API reference and the Docker Engine API; never checked
// against a real Portainer (TODO.md).
// -----------------------------------------------------------------------------

import http from 'node:http';
import { CODES, PortainerError } from '../../src/portainer/errors.js';

export const TOKEN = 'ptr_fake+token/secret=';

const hex = (seed) => seed.repeat(64).slice(0, 64);

export function dockerContainer(
  name,
  { state = 'running', health, image = 'nginx:1.27', id, labels = {}, mounts = [] } = {},
) {
  const status =
    state === 'running'
      ? `Up 2 hours${health === 'healthy' ? ' (healthy)' : health === 'unhealthy' ? ' (unhealthy)' : health === 'starting' ? ' (health: starting)' : ''}`
      : 'Exited (0) 3 minutes ago';
  return {
    Id: id ?? hex(Buffer.from(name).toString('hex')),
    Names: [`/${name}`],
    Image: image,
    State: state,
    Status: status,
    Labels: { 'com.docker.compose.project': 'home', ...labels },
    Mounts: mounts.map((source) => ({
      Type: 'bind',
      Source: source,
      Destination: source,
      RW: true,
    })),
    healthcheck: health !== undefined,
    health,
  };
}

export const STATS = Object.freeze({
  cpu_stats: {
    cpu_usage: { total_usage: 2_000_000_000 },
    system_cpu_usage: 100_000_000_000,
    online_cpus: 4,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 1_500_000_000 },
    system_cpu_usage: 90_000_000_000,
  },
  memory_stats: { usage: 300 * 1024 * 1024, stats: { inactive_file: 100 * 1024 * 1024 } },
});

export function createFakePortainer() {
  const fake = {
    requests: [],
    environments: [
      { Id: 1, Name: 'local', Type: 1, Status: 1 },
      { Id: 2, Name: 'nas', Type: 2, Status: 1 },
      { Id: 3, Name: 'edge', Type: 4, Status: 1 },
      { Id: 5, Name: 'k8s', Type: 5, Status: 1 },
    ],
    containers: {
      1: [
        dockerContainer('web', { health: 'healthy' }),
        dockerContainer('db'),
        dockerContainer('worker', { state: 'exited' }),
        dockerContainer('gladys', { image: 'gladysassistant/gladys:v4' }),
        dockerContainer('portainer', { image: 'portainer/portainer-ce:2.21.0' }),
      ],
      2: [dockerContainer('backup', { health: 'healthy', image: 'restic/restic' })],
    },
    stats: STATS,
    /** path (or prefix) -> { status, headers } answered once. */
    failures: [],
    /** A promise the commands wait for before answering (a slow stop). */
    commandGate: null,
    unreachable: false,
    commands: [],
  };

  const find = (envId, nameOrId) =>
    (fake.containers[envId] ?? []).find(
      (c) => c.Names[0] === `/${nameOrId}` || c.Id === nameOrId || c.Id.startsWith(nameOrId),
    );

  const json = (status, value, headers = {}) => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(value)),
  });

  async function answer(method, url, headers) {
    if (headers['x-api-key'] !== TOKEN) return json(401, { message: 'Unauthorized' });
    const path = url.pathname;
    const failure = fake.failures.findIndex(
      (f) => path.startsWith(f.path) && (!f.method || f.method === method),
    );
    if (failure !== -1) {
      const [f] = fake.failures.splice(failure, 1);
      return json(f.status, { message: 'failure' }, f.headers ?? {});
    }
    if (method === 'GET' && path === '/api/endpoints') {
      return json(
        200,
        fake.environments.map((e) => ({ ...e, Snapshots: [] })),
      );
    }
    const match = /^\/api\/endpoints\/(\d+)\/docker(\/.*)$/.exec(path);
    if (!match) return json(404, { message: 'Not found' });
    const envId = Number(match[1]);
    const env = fake.environments.find((e) => e.Id === envId);
    if (!env || env.Status !== 1) return json(502, { message: 'Unable to reach the environment' });
    const docker = match[2];
    if (method === 'GET' && docker === '/containers/json') {
      const all = url.searchParams.get('all') === '1';
      return json(
        200,
        (fake.containers[envId] ?? [])
          .filter((c) => all || c.State === 'running')
          .map(({ healthcheck: _h, health: _x, ...c }) => c),
      );
    }
    const one = /^\/containers\/([^/]+)\/(json|stats|start|stop|restart)$/.exec(docker);
    if (!one) return json(404, { message: 'Not found' });
    const container = find(envId, decodeURIComponent(one[1]));
    if (!container) return json(404, { message: `No such container: ${one[1]}` });
    const verb = one[2];
    if (method === 'GET' && verb === 'json') {
      return json(200, {
        Id: container.Id,
        Name: container.Names[0],
        Config: { Image: container.Image, Labels: container.Labels },
        Mounts: container.Mounts,
        HostConfig: { Binds: container.Mounts.map((m) => `${m.Source}:${m.Destination}`) },
        State: {
          Status: container.State,
          Running: container.State === 'running',
          ...(container.healthcheck ? { Health: { Status: container.health } } : {}),
        },
      });
    }
    if (method === 'GET' && verb === 'stats') return json(200, fake.stats);
    if (method === 'POST') {
      fake.commands.push({ envId, name: container.Names[0].slice(1), verb });
      if (fake.commandGate) await fake.commandGate;
      const running = container.State === 'running';
      if (verb === 'start' && running) return { status: 304, headers: {}, body: Buffer.alloc(0) };
      if (verb === 'stop' && !running) return { status: 304, headers: {}, body: Buffer.alloc(0) };
      container.State = verb === 'stop' ? 'exited' : 'running';
      container.Status = verb === 'stop' ? 'Exited (0) 1 second ago' : 'Up 1 second';
      return { status: 204, headers: {}, body: Buffer.alloc(0) };
    }
    return json(405, { message: 'Method not allowed' });
  }

  /** The transport of src/portainer/http.js, in memory. */
  fake.request = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const method = options.method ?? 'GET';
    const headers = Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    fake.requests.push({ method, url: rawUrl, path: url.pathname, headers });
    if (fake.unreachable) {
      const err = new PortainerError(CODES.UNREACHABLE, 'ECONNREFUSED');
      err.notSent = true;
      throw err;
    }
    options.onSent?.();
    return answer(method, url, headers);
  };

  /** The same API on a loopback HTTP server: { url, close }. */
  fake.listen = async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', async () => {
        const url = new URL(req.url, 'http://127.0.0.1');
        fake.requests.push({
          method: req.method,
          url: req.url,
          path: url.pathname,
          headers: req.headers,
        });
        const result = await answer(req.method, url, req.headers);
        res.writeHead(result.status, result.headers);
        res.end(result.body);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
      url: `http://127.0.0.1:${port}`,
      close: () =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        }),
    };
  };

  return fake;
}
