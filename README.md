# gladys-portainer

[Gladys Assistant](https://gladysassistant.com) external integration for
**Portainer** (CE / BE 2.x): each Docker container becomes a Gladys device
(running switch, health, CPU, memory, restart button), each environment a
device with its counts, and a stopped or unhealthy container a scene trigger.
Commands are off by default; Gladys and Portainer are never stopped.
**Unofficial integration, not affiliated with Portainer.io. Never tested
against a real Portainer yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (PortainerApp)
                 ├─ src/portainer/client.js   REST API of Portainer, Docker proxy
                 ├─ src/portainer/http.js     the only network access (node:http / https, pin)
                 ├─ src/portainer/parse.js    answers -> plain objects, stats, protection
                 ├─ src/portainer/errors.js   error codes, token refusal
                 ├─ src/budget.js             states per minute
                 ├─ src/store.js              /data: certificate pin, refusals, 429 pause
                 └─ src/devices.js            containers and environments (pure)
```

- **Authentication**: an access token in the `X-API-Key` header, nothing
  else. HTTP 401 on `/api/endpoints` is final: a salted HMAC of the address
  and token is kept in `/data`, nothing is sent again until the configuration
  is saved or "Test the connection" is pressed. HTTP 429 pauses everything
  (Retry-After, 1 min to 6 h, kept in `/data`); other failures retry 30 s to
  10 min.
- **TLS**: strict by default; a self-signed certificate is accepted either by
  trust on first use (pin in `/data`) or by a typed SHA-256 fingerprint. The
  handshake is checked before the request (and the token) is written.
- **Status** (every 30 s): `GET /api/endpoints?excludeSnapshots=true`, then
  `GET /api/endpoints/{id}/docker/containers/json?all=1` per Docker
  environment (types 1 and 2, status up). An environment that fails marks
  only its own devices unreachable. External ids:
  `container:<environment id>-<container name>` (stable across
  recreations), `environment:<id>`.
- **Statistics** (every 60 s by default): `containers/{id}/stats?stream=false`
  for the created containers that run, 25 per round, 3 at a time; dropped
  first when the 250 states/min budget is used.
- **Commands** (`allow_container_control`, off by default): one queue, the
  container inspected by name just before acting, stop / restart refused for
  Gladys, Portainer, its agent and our own container (image and name), nothing
  sent past 3.5 s, Gladys answered at most 4.3 s after the command, one
  command at a time per container.

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake Portainer
(`test/helpers/fakePortainer.js`), plus loopback http / https servers for the
transport. No test touches a real Portainer or the Internet.

## Credits

- [tomaae/homeassistant-portainer](https://github.com/tomaae/homeassistant-portainer)
  (Apache-2.0): the endpoints used and how their answers are read (see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- The `docker stats` formulas of the Docker CLI (Apache-2.0).
- [gladys-synology-surveillance](https://github.com/LM1LC3N7/gladys-synology-surveillance)
  and [gladys-homey](https://github.com/LM1LC3N7/gladys-homey): the structure
  of the app, the retry policy and the certificate pinning.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
