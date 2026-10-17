# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.2] - 2026-10-17

### Fixed

- Status and Discovery republished after Gladys restarts.
- A reconnection to Gladys no longer skips the wait after a failed reading
  (Portainer down, 5xx, 403, TLS): the same deadline and the growing delay
  are kept for the same address and token; saving the configuration or the
  test button still reads at once.

## [0.1.1] - 2026-10-17

### Added

- First version, never tested against a real Portainer: Docker containers of
  Portainer CE / BE 2.x through its REST API and an access token (`X-API-Key`
  header).
- One device per container (running, healthy, CPU, memory, start / stop /
  restart buttons), named by environment and container name so that a
  recreated container keeps its device; one device per environment
  (containers running and stopped).
- Scene trigger "Container stopped or unhealthy" (never for a stop asked
  from Gladys).
- Start, stop and restart buttons, off by default (`allow_container_control`;
  running is never a switch, so no voice assistant can stop a container);
  Gladys (labels of the core, image, name), Portainer, its agent, any
  container on the Docker socket and the container of the integration are
  never stopped nor restarted; commands chained per container; nothing is
  sent past 3.5 s after the command.
- Strict TLS by default; a self-signed certificate accepted by trust on first
  use or by a typed SHA-256 fingerprint, checked before the token is sent.
- CPU and memory read only for the created containers that run, 25 per round,
  at most every minute; under 250 states per minute.
- Environment filter (names or ids); Edge and Kubernetes environments left out.
- Buttons "Test the connection" and "Trust the new certificate".

[Unreleased]: https://github.com/LM1LC3N7/gladys-portainer/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LM1LC3N7/gladys-portainer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/LM1LC3N7/gladys-portainer/releases/tag/v0.1.1
