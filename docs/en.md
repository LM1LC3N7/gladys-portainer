# Portainer

Your Docker containers in Gladys, through the REST API of Portainer (CE or
BE 2.x) on your network:

- each container becomes a Gladys device: **running** (a switch: start /
  stop), **healthy** (its Docker healthcheck), **CPU (%)**, **memory** (MB)
  and a **restart** button;
- each Portainer environment becomes a device with its **containers running**
  and **containers stopped**;
- the **Container stopped or unhealthy** scene trigger.

> **This integration has never been tested against a real Portainer.** This
> first version was written from the Portainer API reference, the Docker
> Engine API and tomaae/homeassistant-portainer, and tested against a fake
> Portainer only. Please report what works and what does not on the Gladys
> forum.

Unofficial integration, not affiliated with Portainer.io.

## Before you start: a dedicated user and its token

1. In Portainer, **Administration → User-related → Users**, create a user
   `gladys` (Portainer BE: give it the **Read-only user** role on the
   environments Gladys should only watch, **Operator** where it may start and
   stop containers; Portainer CE: add it to a team that has access to these
   environments).
2. Log in as this user, open **My account → Access tokens → Add access
   token**, name it `gladys` and copy the token (it starts with `ptr_`):
   Portainer shows it only once.
3. An administrator token works too, but gives Gladys much more than it needs.

## Configuration

- **Portainer address**: `https://192.168.1.10:9443`. A bare address is read
  as https on port 9443. A path is kept (Portainer behind a reverse proxy,
  `https://example.org/portainer`). Avoid `http://192.168.1.10:9000`: the
  token would cross your network in clear.
- **Access token**: kept by Gladys in its database, never shown again, sent
  only to Portainer, in the `X-API-Key` header (never in an address, never in
  a log).
- **Certificate**: by default the certificate of Portainer must come from a
  known authority (Let's Encrypt…). Portainer generates a self-signed one on
  port 9443; two ways to accept it:
  - **Accept the self-signed certificate**: the certificate seen at the first
    connection is trusted and remembered (in the `/data` volume of the
    integration); a different one later is refused until you press **Trust
    the new certificate**;
  - **Certificate fingerprint**: safer, nothing else is ever accepted, not
    even at the first connection. In your browser, open Portainer, click the
    padlock, show the certificate and copy its SHA-256 fingerprint; or run
    `openssl s_client -connect 192.168.1.10:9443 </dev/null | openssl x509 -noout -fingerprint -sha256`.
    In both cases, the certificate is checked BEFORE the token is sent: a
    machine impersonating Portainer never gets it.
- **Environments**: names or ids, separated by commas; empty, every Docker
  environment the token sees. Edge and Kubernetes environments are left out.
- **Allow starting, stopping and restarting containers**: off by default (see
  Commands).
- **CPU and memory**: every minute (default) to every 10 minutes, or not read.

Then open the **Discovery** tab and create the containers and environments
you want to follow. Only the created containers get their CPU and memory
read.

## Commands

- Off by default: Gladys only reads. Once **Allow starting, stopping and
  restarting containers** is ticked, the **running** switch starts (on) or
  stops (off) the container, and the **restart** button restarts it.
- **Never** stopped nor restarted from Gladys, even when allowed: Gladys and
  its integrations (an image `gladysassistant/…` or a repository named
  `gladys…`, or a container whose name starts with `gladys`), Portainer and
  its agent (images `portainer/portainer-ce`, `-ee`, `portainer/agent`, or a
  name starting with `portainer`), and the container of this integration
  itself. Starting them stays possible.
- Commands run one at a time. Just before acting, Gladys reads the container
  from Docker: if it cannot, nothing is sent; if the container is already
  running (start) or stopped (stop), nothing is sent either. When Portainer is
  too slow to answer within 3.5 s, nothing is sent and Gladys shows a failure
  (never an action after a failure was shown).
- Docker answers a stop once the container stopped (10 s of grace by
  default). Gladys does not wait that long: it answers "done" at most 4.3 s
  after your command, once the command was sent, and the switch follows the
  real state as soon as Docker is done. Another command on the same container
  is refused while Docker is still at work.
- The containers are recognized by their **name** (and environment), not by
  their Docker id: a container recreated by an image update or by
  `docker compose up` keeps its Gladys device, its history and its scenes.

## Refresh and limits

- The containers (running, health) of every environment are read every 30
  seconds: the switch, the health sensor, the counts and the trigger lag by
  up to 30 seconds.
- The CPU and memory figures cost Docker about a second per container: they
  are read only for the created containers that run, 25 per round at most (3
  at a time; beyond 25, in turn), at the chosen pace. A stopped container
  shows 0. Gladys keeps under 250 states per minute (its limit is 300): when
  that is reached, the CPU and memory figures wait, the running and health
  states always go.
- **CPU (%)** is the figure of `docker stats`: 100 means one CPU fully busy
  (400 on four busy CPUs). Gladys has no CPU category: the feature has no
  unit. **Memory** is in MB (MiB, like `docker stats`), page cache excluded.
- **Healthy** is published only for a container that has a Docker
  healthcheck (1 healthy, 0 unhealthy; nothing while it is starting).
- The trigger fires when a running container stops (exited or dead), or when
  its healthcheck turns unhealthy, once per change, with the container, its
  name, its environment and the problem (`stopped` or `unhealthy`). The first
  reading after a start of the integration fires nothing. A container that is
  removed (not stopped) does not fire.

## Connection problems

- **Token refused** (HTTP 401: wrong, revoked or expired): Gladys does not
  try again by itself, even after a restart. Create a new token, paste it and
  save, or press **Test the connection**.
- **Portainer unreachable**: retried after 30 s, then up to every 10 min; the
  devices show as unreachable meanwhile. An environment that does not answer
  (agent down) only marks its own containers unreachable.
- **Portainer busy** (HTTP 429): every request pauses for 1 minute to 6 hours,
  as long as Portainer asks (Retry-After), even across a restart; saving the
  configuration or pressing **Test the connection** lifts it.
- **Certificate changed**: nothing is sent; if you renewed it, press **Trust
  the new certificate** (or type the new fingerprint).

## Limits

- One Portainer per integration, 20 environments and 500 containers at most.
- Docker environments (socket, API or Portainer agent) only: Edge agents
  (their tunnel opens on demand) and Kubernetes are left out.
- Swarm service tasks get a new name at every update: each one becomes a new
  device.
- Not tested with Portainer BE role rules, nor with Podman.
