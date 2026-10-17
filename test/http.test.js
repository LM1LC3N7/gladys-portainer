// -----------------------------------------------------------------------------
// The real transport (node:http / node:https) against loopback servers only.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { parsePortainerUrl } from '../src/config.js';
import { PortainerClient } from '../src/portainer/client.js';
import { CODES } from '../src/portainer/errors.js';
import { httpRequest } from '../src/portainer/http.js';
import { Store } from '../src/store.js';
import { TOKEN, createFakePortainer } from './helpers/fakePortainer.js';

const tlsFile = (name) => readFileSync(new URL(`./fixtures/tls/${name}`, import.meta.url));
const certFingerprint = new X509Certificate(tlsFile('server.pem')).fingerprint256;

async function serve(handler, { secure = false } = {}) {
  const requests = [];
  const listener = (req, res) => {
    req.resume();
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers });
      handler(req, res);
    });
  };
  const server = secure
    ? https.createServer({ key: tlsFile('server.key'), cert: tlsFile('server.pem') }, listener)
    : http.createServer(listener);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

const okJson = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('[]');
};

test('GET, POST without a body, the size cap', async () => {
  const server = await serve((req, res) => {
    if (req.url.startsWith('/big')) {
      res.writeHead(200);
      res.end(Buffer.alloc(5000));
      return;
    }
    okJson(req, res);
  });
  try {
    const get = await httpRequest(`${server.url}/a?b=1`, { timeout: 2000, maxBytes: 1000 });
    assert.equal(get.status, 200);
    assert.equal(get.body.toString(), '[]');
    let sent = 0;
    await httpRequest(`${server.url}/p`, {
      method: 'POST',
      timeout: 2000,
      maxBytes: 1000,
      onSent: () => (sent += 1),
    });
    assert.equal(sent, 1);
    assert.equal(server.requests.at(-1).method, 'POST');
    await assert.rejects(
      httpRequest(`${server.url}/big`, { timeout: 2000, maxBytes: 1000 }),
      (err) => err.code === CODES.TOO_LARGE,
    );
  } finally {
    await server.close();
  }
});

test('no answer in time, nobody listening (not sent)', async () => {
  const server = await serve(() => {}); // never answers
  try {
    await assert.rejects(
      httpRequest(server.url, { timeout: 200, maxBytes: 1000 }),
      (err) => err.code === CODES.TIMEOUT && !err.notSent,
    );
  } finally {
    await server.close();
  }
  await assert.rejects(
    httpRequest(server.url, { timeout: 2000, maxBytes: 1000 }),
    (err) => err.code === CODES.UNREACHABLE && err.notSent === true,
  );
});

test('https: an untrusted certificate is refused by default, before any request', async () => {
  const server = await serve(okJson, { secure: true });
  try {
    await assert.rejects(
      httpRequest(server.url, { timeout: 2000, maxBytes: 1000, headers: { 'x-api-key': 'k' } }),
      (err) => err.code === CODES.TLS_UNTRUSTED && err.notSent === true,
    );
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});

test('https, trust on first use: pinned, then a different certificate refused before the token', async () => {
  const server = await serve(okJson, { secure: true });
  try {
    const pins = [];
    const first = await httpRequest(`${server.url}/x`, {
      timeout: 2000,
      maxBytes: 1000,
      tls: { trustOnFirstUse: true, pin: null, onPin: (fp) => pins.push(fp) },
    });
    assert.equal(first.status, 200);
    assert.deepEqual(pins, [certFingerprint]);
    await httpRequest(`${server.url}/y`, {
      timeout: 2000,
      maxBytes: 1000,
      headers: { 'x-api-key': 'secret' },
      tls: { trustOnFirstUse: true, pin: pins[0] },
    });
    assert.equal(server.requests.length, 2);
    await assert.rejects(
      httpRequest(`${server.url}/z`, {
        timeout: 2000,
        maxBytes: 1000,
        headers: { 'x-api-key': 'secret' },
        tls: { trustOnFirstUse: true, pin: 'AA:BB' },
      }),
      (err) => err.code === CODES.TLS_CHANGED && err.notSent === true,
    );
    assert.equal(server.requests.length, 2, 'the token never left');
  } finally {
    await server.close();
  }
});

test('https, typed fingerprint: exactly this certificate, nothing else', async () => {
  const server = await serve(okJson, { secure: true });
  try {
    const ok = await httpRequest(`${server.url}/a`, {
      timeout: 2000,
      maxBytes: 1000,
      tls: { fingerprint: certFingerprint.replace(/:/g, '').toLowerCase() },
    });
    assert.equal(ok.status, 200);
    await assert.rejects(
      httpRequest(`${server.url}/b`, {
        timeout: 2000,
        maxBytes: 1000,
        headers: { 'x-api-key': 'secret' },
        tls: { fingerprint: 'AB'.repeat(32) },
      }),
      (err) => err.code === CODES.TLS_CHANGED,
    );
    assert.equal(server.requests.length, 1, 'the token never left');
  } finally {
    await server.close();
  }
});

test('a header Node refuses (invisible character) is a failure, never a crash', async () => {
  const plain = await serve(okJson);
  const secure = await serve(okJson, { secure: true });
  try {
    const headers = { 'x-api-key': 'ptr_a​b' };
    await assert.rejects(
      httpRequest(plain.url, { timeout: 2000, maxBytes: 1000, headers }),
      (err) => err.name === 'PortainerError' && err.notSent === true,
    );
    // After the handshake (secureConnect): the case that crashed.
    await assert.rejects(
      httpRequest(secure.url, {
        timeout: 2000,
        maxBytes: 1000,
        headers,
        tls: { trustOnFirstUse: true },
      }),
      (err) => err.name === 'PortainerError' && err.notSent === true,
    );
    assert.equal(plain.requests.length + secure.requests.length, 0);
  } finally {
    await plain.close();
    await secure.close();
  }
});

test('a command that cannot connect in time is not sent', async () => {
  // A TLS server that never completes the handshake (plain TCP that stays silent).
  const sockets = [];
  const server = net.createServer((s) => sockets.push(s));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      httpRequest(`https://127.0.0.1:${port}/x`, {
        method: 'POST',
        timeout: 5000,
        sendWithin: 150,
        maxBytes: 1000,
        tls: { trustOnFirstUse: true },
      }),
      (err) => err.code === CODES.TIMEOUT && err.notSent === true,
    );
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the client over the real transport: the token in X-API-Key only, never in the URL', async () => {
  const fake = createFakePortainer();
  const server = await fake.listen();
  try {
    const store = new Store({ filePath: join(mkdtempSync(join(tmpdir(), 'ptr-')), 's.json') });
    await store.load();
    const client = new PortainerClient({
      portainer: parsePortainerUrl(server.url),
      token: TOKEN,
      store,
    });
    const { environments } = await client.environments();
    assert.deepEqual(
      environments.map((e) => e.name),
      ['local', 'nas'],
    );
    const containers = await client.containers(1);
    assert.equal(containers.length, 5);
    assert.deepEqual(await client.stats(1, containers[0].id), { cpu: 20, memory: 209.7 });
    await client.command(1, containers.find((c) => c.name === 'db').id, 'stop');
    assert.equal(fake.containers[1][1].State, 'exited');
    for (const request of fake.requests) {
      assert.equal(request.headers['x-api-key'], TOKEN);
      assert.ok(!decodeURIComponent(request.url).includes(TOKEN));
    }
    assert.match(fake.requests[0].url, /^\/api\/endpoints\?excludeSnapshots=true$/);
  } finally {
    await server.close();
  }
});
