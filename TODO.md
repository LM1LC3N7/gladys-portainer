# TODO — Portainer v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (post #241).

## Status

- [x] **Milestone 1 — core** (2026-10-17): Portainer REST client (access
      token in `X-API-Key`, environments, containers through the Docker
      proxy, inspect, stats, start / stop / restart), TLS strict by default,
      trust-on-first-use pin or typed SHA-256 fingerprint, checked before the
      token is written; one device per container (running, healthy, CPU,
      memory, restart button) keyed by environment id + container name,
      one per environment (running / stopped counts); trigger
      `container_problem` (stopped, unhealthy); statistics of the created
      running containers only, 25 per round, under 250 states/min; commands
      off by default, Gladys / Portainer / agent / own container never
      stopped nor restarted, serialized, fresh inspect, 3.5 s budget, answer
      at 4.3 s at most; token refusal (401) final and remembered; 429 pause;
      buttons "Test the connection" and "Trust the new certificate"; docs
      en/fr. Tested with unit tests against the SDK's fake Gladys, a fake
      Portainer (in memory and on loopback) and loopback http / https
      servers. **Never tested against a real Portainer.** No Docker on this
      PC: no e2e test in a container.
- [x] **Review corrections** (2026-10-17): running read only
      (`unknown`/`binary`) with start / stop / restart buttons (no switch for
      the voice assistants and "turn everything off"); one command chain per
      container; a stop asked from Gladys never fires `stopped` and its
      passing states are not published; 429 met by Discovery and by the
      reading after a command pauses everything; a token with an invisible
      character refused in the configuration, and a header Node refuses is a
      failure, never a crash; scheme without port: 443 / 80; certificate
      options refused with http://; protection by the labels of the core and
      the Docker socket; badges in calls of 100; memory in MB (10^6); CPU
      `unknown`/`unknown`; statistics budgeted after deduplication, figures
      before zeros; docs on the first-use window and the unprotected vital
      containers.
- [ ] **Milestone 2 — real Portainer** (a tester with Portainer CE and BE):
      record real answers as fixtures (token removed), fix what differs.
      To check first:
  - `GET /api/endpoints?excludeSnapshots=true`: honoured by the version in
    use (2.19+?), else the snapshots make the answer large (8 MB cap); the
    `Type` and `Status` values; pagination (`start` / `limit`) needed above
    some count?;
  - the Docker proxy with a standard (non-admin) user: 403 per environment,
    and what Portainer BE answers for a Read-only user on start / stop;
  - `containers/json` `Status` texts with health (`(healthy)`,
    `(unhealthy)`, `(health: starting)`), and the `Health` object of newer
    Docker APIs;
  - `stats?stream=false`: duration (about 1 s with the precpu sample?),
    `online_cpus` present, cgroup v1 / v2 memory fields; Windows hosts;
  - `stop` / `restart` through the proxy: does Portainer keep the request
    open for the whole grace period (10 s) or answer at once? 304 for "already
    so" passed through?;
  - environments of type 2 (agent) behind a slow link; Edge agents (type 4)
    and whether they should be offered (tunnel opened on demand);
  - Portainer behind a reverse proxy with a path prefix;
  - what Portainer answers to a revoked token (401 everywhere?) and whether
    it ever answers 429;
  - a standard (non-admin) user of Portainer CE: which containers it sees and
    may operate, in particular the containers created outside Portainer
    (`docker compose` on the host: no resource control, admin only?);
  - the CSRF protection of Portainer 2.19+ on the POST of start / stop /
    restart: is a request with `X-API-Key` (no cookie, no CSRF token)
    accepted?;
  - the labels the Gladys core really puts on its containers
    (`io.gladysassistant.*`, from `server/lib/external-integration/constants.js`)
    and whether the core mounts `docker.sock` in every install.
- [ ] **Milestone 3 — more**: stacks (start / stop a whole compose stack),
      image update available (like tomaae), pause / unpause, several
      Portainer instances, Edge environments.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published (at milestone 1
      its only error is the `docker_image` not yet pullable from GHCR).

## Decisions

- **Duplicate check**: done by the main session before the batch (post #241
  of /t/10385); not repeated by the development agent.
- **Reuse**: tomaae/homeassistant-portainer (Apache-2.0, commit `029f7a7`) is
  the reference for the endpoints and how their answers are read
  (`X-API-Key`, `/api/endpoints` with `Status == 1`, `containers/json?all`,
  `Names[0]` without its slash, the Docker health status); it has no
  container control, so start / stop / restart come from the Docker Engine
  API. CPU / memory follow the `docker stats` formulas of the Docker CLI
  (Apache-2.0). Notices in `THIRD_PARTY_NOTICES.md`, copied into the image.
  No runtime dependency besides the SDK.
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag; the first patch release gives 0.1.1.
- **External ids**: `container:<environment id>-<container name>`: the
  Docker id changes at every recreation (image update, `compose up`), the
  name does not; the environment id is the one Portainer stores (stable,
  unlike its name, which the user may change). `environment:<id>`. Features
  `running`, `healthy`, `cpu`, `memory`, `start`, `stop`, `restart`,
  `running_count`, `stopped_count`. A Swarm task (new name per update)
  becomes a new device: documented.
- **No switch** (review, blocking): the core exposes every `switch`/`binary`
  to Google Home, Alexa, HomeKit, MCP and the `switch.turn-off` / `toggle`
  scene actions, so "turn everything off" would stop the containers. Running
  is a read-only `unknown`/`binary`; start, stop and restart are three
  `button`/`push` features (value 1), all behind `allow_container_control`;
  a set_value on `running` is refused.
- **Feature types and units** (only the units the core lists for the
  category, `DEVICE_FEATURE_UNITS_BY_CATEGORY`): running and health
  `unknown`/`binary`; buttons `button`/`push`; memory `data`/`size` in
  `megabyte` = 10^6 bytes (`docker stats` shows MiB; converted, page cache
  excluded); counts `counter-sensor`/`integer` without unit. The core has no
  CPU nor "service health" category: CPU is `unknown`/`unknown` (the pair the
  front translates; `unknown`/`decimal` has no translation) **without unit**
  (named "CPU (%)", 100 = one CPU), health `unknown`/`binary` (1 healthy, 0
  unhealthy, nothing without a healthcheck or while starting). Prudent
  default: a wrong category would be frozen at creation; these can be
  migrated by a new feature key if the core adds a category.
- **Safety of the commands**: start, stop and restart are all behind
  `allow_container_control` (off by default), checked when the command
  arrives AND just before sending. Stop and restart are always refused for:
  a label of the Gladys core (any `io.gladysassistant.*` key, which covers
  `io.gladysassistant.external-integration` and
  `io.gladysassistant.container`, even for an integration renamed with an
  image that says nothing), an image of Portainer or its agent
  (`portainer/portainer`, `-ce`, `-ee`, `-be`, `portainer/agent`), an image
  of Gladys (`gladysassistant/*`, any repository whose last segment starts
  with `gladys`), a name starting with `gladys` or `portainer`, any
  container that mounts the Docker socket (a `docker.sock` in `Mounts` or
  `HostConfig.Binds`: the core created from an image id and renamed, a
  socket proxy, Portainer's agent, Watchtower), and our own container (the
  12-character HOSTNAME Docker sets). The check runs on the fresh inspect
  (`Config.Image`, `Config.Labels`, `Mounts`, `Binds`, `Name`) and on the
  last listing. Starting them stays allowed (it cannot cut anything).
  **Not protected** (documented): the other vital containers (reverse proxy
  in front of Portainer or Gladys, DNS such as Pi-hole / AdGuard, the MQTT
  broker of Gladys): nothing identifies them reliably; the docs advise to
  keep the commands off or to deny the token user these containers. Commands
  are chained per container (one at a time on a container; two containers
  never wait for each other, so a scene stopping web then db stops both
  within their own 5 s), keep the client of the moment they arrived. Each
  one inspects the container by name just before acting (unknown: refused;
  same state: nothing sent), targets the Docker id read then, and is refused
  before sending once 3.5 s have passed (Gladys waits 5 s); the connection
  of the command itself must be up before that deadline, else it is not
  sent.
- **Slow stops**: Docker answers a stop once the container stopped (10 s
  grace by default). Gladys is answered at the first of Docker's answer or
  4.3 s after the command arrived: "sent" (success) when still pending, the
  real state being published when Docker answers (and read again 2 s later).
  While the request runs, the container is in `inFlight` (kept across a
  restart of the app, outside `reset()`): the readings keep its last known
  state and fire nothing; when Docker answers, the state asked becomes the
  known state before the key leaves `inFlight`, so a stop asked from Gladys
  never fires `container_problem` `stopped`. A failure answered within the
  4.3 s is shown ("refused" or "not sent"); one answered later is only
  logged and corrected by the next reading (which may then fire `stopped`
  if the container did stop). A second command on a container whose stop /
  restart is still running is refused. The request itself stays open up to
  120 s.
- **Token refusal**: HTTP 401 on `/api/endpoints` is final: an
  HMAC-SHA-256 of the address and the token, keyed with a random salt
  generated once in `/data`, is kept there (never the token); a restart or a
  reconnection to Gladys does not send it again; saving the configuration or
  "Test the connection" (25 s) tries once. 403 on the list is a privilege
  problem (retried with the back-off, message says what to fix); a failure of
  one environment (agent down, 502, 403 on its proxy) only marks its devices
  unreachable and never blocks the others (lesson of wave 3).
- **Retries**: transient failures (network, timeout, TLS, HTTP errors) retry
  after 30 s, doubling up to 10 min; 5xx honours a Retry-After (up to 6 h).
  HTTP 429, met by any request (status loop, statistics, commands, the
  Discovery scan, the reading 2 s after a command), pauses every path for
  its Retry-After, bounded 1 min to 6 h, kept in `/data` (a restart or a
  reconnection to Gladys waits too); only the user lifts it (tested for each
  path).
- **TLS**: strict by default (`rejectUnauthorized`). Two opt-ins for the
  self-signed certificate of Portainer: `allow_self_signed`, trust on first
  use like gladys-synology-surveillance (a certificate valid for the host
  needs no pin; otherwise the SHA-256 is pinned the first time, a different
  one refused; "Trust the new certificate" clears the pin), and
  `certificate_fingerprint`, a typed SHA-256 that must match exactly (valid
  or not), the only way to close the first-use window. Both decide on the
  handshake BEFORE the request. With trust on first use, the token goes to
  whoever answers the first connection (and the first one after "Trust the
  new certificate"): said in the docs and the manifest. Both options with
  an `http://` address are refused with a clear status (they would be
  ignored in silence).
- **Address**: no scheme: https on 9443 (Portainer's own port); a scheme
  without a port: 443 / 80 like a browser (Portainer behind a reverse proxy,
  `https://example.org/portainer`); a typed port always wins.
- **Secrets**: the token is a `secret` field (kept in clear in the Gladys
  database, masked in the UI: never "encrypted"), sent only in the
  `X-API-Key` header; never in a URL, a log or `/data` (tested, the file of
  `/data` is read back). A token outside printable ASCII (an invisible
  character pasted with it) is refused in the configuration with its own
  status; a header Node refuses anyway is a failure of the request, never an
  uncaught exception.
- **Rate of states**: POST /state admits 300 states/min; the integration
  keeps a sliding window under 250. Running, health and counts are
  change-only (`publishChangedStates`) and always sent; CPU and memory
  (statistics) are first reduced to the values that changed, then cut to
  what is left of the window, the figures read before the zeros of the
  stopped containers. Transport badges go in calls of 100 (the SDK limit).
  Statistics only for
  the containers created in Gladys that run, 25 per round (rotation beyond),
  3 requests at once, at most every 60 s (default), 0 for a stopped one
  without a request. A statistics failure never touches the status (lesson
  of wave 3). Scene events: at most 30 per round.
- **Environments**: Docker types only (1 local / API, 2 agent); Edge (4,
  tunnel opened on demand, slow and costly) and Kubernetes (5, 6, 7, no
  Docker API) left out and counted in the status. Status 2 (down) is not
  read. Filter by names or ids (comma separated). Caps: 20 environments, 500
  containers.
- **Trigger** `container_problem`: running -> exited / dead fires `stopped`;
  any -> unhealthy fires `unhealthy`; once per change; the first reading of
  an environment (start, back after an outage) fires nothing; a container
  removed (gone from the list) fires nothing (a `compose up` recreation
  would otherwise fire on every update).
- **Status every 30 s** (fixed): one request per environment, cheap
  (`containers/json`), far under any limit.
- `gladys_version >=5.1.0` (scene triggers). Single container, 256 MB is
  plenty.
