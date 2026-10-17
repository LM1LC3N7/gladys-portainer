// -----------------------------------------------------------------------------
// The only network access of the integration: one request to Portainer on
// node:http / node:https. A deadline for the whole exchange, a size cap on
// the body, no redirect followed. Resolves { status, headers, body } for any
// status; rejects a PortainerError for the transport failures.
//
// TLS: by default the certificate must be valid for the host name (a public
// or system authority). Two ways to accept the self-signed certificate
// Portainer generates:
//   - `tls.fingerprint`: the SHA-256 fingerprint typed by the user; the
//     certificate must have exactly this one, valid or not;
//   - `tls.trustOnFirstUse`: a certificate that does not validate is accepted
//     the first time and its fingerprint pinned (`onPin`); a different one
//     later is refused until the user trusts it again.
// The handshake is checked BEFORE the request is written, so the access token
// (an HTTP header) never reaches an unverified peer.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { CODES, PortainerError } from './errors.js';

const TLS_ERRORS = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE',
]);

function transportError(err) {
  const code = String(err?.code ?? '');
  if (TLS_ERRORS.has(code)) {
    return new PortainerError(CODES.TLS_UNTRUSTED, `Certificate refused (${code})`);
  }
  // Something answered, but not in HTTP / TLS (a wrong port or scheme).
  if (code.startsWith('HPE_') || code === 'EPROTO' || code.startsWith('ERR_SSL_')) {
    return new PortainerError(CODES.BAD_ANSWER, `Not the expected protocol (${code})`);
  }
  return new PortainerError(CODES.UNREACHABLE, code || err?.message || 'Connection failed');
}

/** `AA:BB:...` upper case, from any spelling (colons, spaces or none). */
export function normalizeFingerprint(value) {
  const hex = String(value ?? '')
    .replace(/^sha-?256\s*(fingerprint)?\s*[:=]?\s*/i, '')
    .replace(/[\s:]/g, '')
    .toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g).join(':');
}

/**
 * @param {string} url absolute http(s) URL
 * @param {object} options
 * @param {'GET'|'POST'} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.onSent] called once the request is written
 * @param {{ fingerprint?: string | null, trustOnFirstUse?: boolean, pin?: string | null, onPin?: (fingerprint: string) => void }} [options.tls]
 */
export function httpRequest(
  url,
  { method = 'GET', headers = {}, timeout, sendWithin, maxBytes, onSent, tls: trust = {} } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const host = target.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const servername = net.isIP(host) ? undefined : host;
    let settled = false;
    let req = null;
    let socket = null;
    // Until the connection (TLS included) is up, nothing of the request has
    // left: a failure then is "not sent" for sure (see the commands).
    let connected = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        if (!connected) error.notSent = true;
        req?.destroy();
        socket?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(
          new PortainerError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`),
        ),
      timeout,
    );
    // A command must leave before its deadline, or not at all.
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(() => {
            if (!connected) {
              finish(new PortainerError(CODES.TIMEOUT, 'Not connected in time: request not sent'));
            }
          }, sendWithin);

    const markSent = () => {
      if (connected) return;
      connected = true;
      clearTimeout(sendTimer);
      onSent?.();
    };

    const send = (createConnection) => {
      const options = {
        method,
        host,
        port,
        path: `${target.pathname}${target.search}`,
        headers: { accept: 'application/json', host: target.host, ...headers },
      };
      let lib = http;
      if (createConnection) {
        options.createConnection = createConnection;
      } else if (target.protocol === 'https:') {
        lib = https;
        options.servername = servername;
        options.rejectUnauthorized = true;
        options.agent = false;
      }
      req = lib.request(options, (res) => {
        markSent();
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            finish(new PortainerError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          finish(null, {
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on('error', (err) => finish(transportError(err)));
      });
      req.on('socket', (s) => {
        if (createConnection || !s.connecting) {
          markSent();
          return;
        }
        s.once(lib === https ? 'secureConnect' : 'connect', markSent);
      });
      req.on('error', (err) => finish(transportError(err)));
      req.end();
    };

    // lib.request throws synchronously on a header it refuses (an invisible
    // character in the token: ERR_INVALID_CHAR): a failure, never a crash.
    const safeSend = (createConnection) => {
      try {
        send(createConnection);
      } catch (err) {
        finish(transportError(err));
      }
    };

    const fixed = trust.fingerprint ? normalizeFingerprint(trust.fingerprint) : null;
    if (target.protocol !== 'https:' || (!fixed && !trust.trustOnFirstUse)) {
      safeSend();
      return;
    }

    // Pinned certificate: handshake first, decide, then write the request.
    socket = tls.connect({ host, port, servername, rejectUnauthorized: false });
    socket.once('error', (err) => finish(transportError(err)));
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const fingerprint = String(cert?.fingerprint256 ?? '').toUpperCase();
      if (!fingerprint) {
        finish(new PortainerError(CODES.TLS_UNTRUSTED, 'No certificate'));
        return;
      }
      if (fixed) {
        // The fingerprint the user typed: nothing else is accepted.
        if (fingerprint !== fixed) {
          finish(new PortainerError(CODES.TLS_CHANGED, 'Not the certificate of the fingerprint'));
          return;
        }
      } else {
        // A certificate that validates for this host needs no pin (renewals keep working).
        const valid = socket.authorized && !tls.checkServerIdentity(servername ?? host, cert);
        if (!valid) {
          const pin = trust.pin ? String(trust.pin).toUpperCase() : null;
          if (pin && pin !== fingerprint) {
            finish(new PortainerError(CODES.TLS_CHANGED, 'The certificate of Portainer changed'));
            return;
          }
          if (!pin) trust.onPin?.(fingerprint);
        }
      }
      safeSend(() => socket);
    });
  });
}
