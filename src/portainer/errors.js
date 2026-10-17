// -----------------------------------------------------------------------------
// PortainerError: every failure of a request to Portainer, with a code the app
// maps to a status, a retry policy or a message. Messages never carry the
// access token.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no TCP connection
  TIMEOUT: 'timeout', // no answer in time
  TLS_UNTRUSTED: 'tls_untrusted', // certificate refused (self-signed, wrong name...)
  TLS_CHANGED: 'tls_changed', // differs from the pinned fingerprint
  HTTP: 'http', // an HTTP status other than 2xx / 304 (see `status`)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
  NO_TIME: 'no_time', // the deadline of a command left no room: not sent
});

export class PortainerError extends Error {
  constructor(code, message, { status, retryAfterMs, path } = {}) {
    super(message);
    this.name = 'PortainerError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    if (path !== undefined) this.path = path;
  }
}

/**
 * The access token refused: HTTP 401 on the list of the environments (the
 * one request every token may make). Final: never retried without a user
 * action (the configuration saved, "Test the connection").
 */
export const isTokenRefused = (err) =>
  err?.code === CODES.HTTP && err.status === 401 && err.path === '/api/endpoints';

export const isTlsError = (err) =>
  err?.code === CODES.TLS_UNTRUSTED || err?.code === CODES.TLS_CHANGED;
