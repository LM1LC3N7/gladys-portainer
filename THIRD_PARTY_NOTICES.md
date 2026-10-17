# Third-party notices

This integration follows the approach of the project below for reading
Portainer: the `X-API-Key` header with an access token, the list of the
environments (`/api/endpoints`, only those whose `Status` is 1 are read), the
containers of each environment through the Docker proxy
(`/api/endpoints/{id}/docker/containers/json?all=1`), the container name taken
from `Names[0]` without its slash, and the health status of Docker. Nothing of
it is installed at runtime, and no line of it is copied: it is Python, this
integration is JavaScript (`src/portainer/client.js`, `src/portainer/parse.js`).

## tomaae/homeassistant-portainer

<https://github.com/tomaae/homeassistant-portainer> (read at commit `029f7a7`,
2025-09-06), licensed under the Apache License, Version 2.0. The project ships
no NOTICE file. The full text of the license is the `LICENSE` file of this
repository (the same Apache License 2.0).

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Docker CLI (`docker stats`)

The CPU and memory figures are computed like the `docker stats` command of
the Docker CLI (<https://github.com/docker/cli>, Apache License 2.0): CPU
delta over system delta times the CPUs online, memory used minus the
inactive page cache. Only the formula is reproduced.

## LM1LC3N7/gladys-synology-surveillance and LM1LC3N7/gladys-homey

The structure of the app, the handler wiring, the retry and pause policy and
the certificate pinning follow integrations of the same author, under the
Apache License 2.0 of this repository. The test certificates of
`test/fixtures/tls/` come from gladys-synology-surveillance.
