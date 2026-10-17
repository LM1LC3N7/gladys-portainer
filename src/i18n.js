// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, buttons, errors).
// Errors thrown to Gladys are English (one language per message, like the
// core's); the statuses and button answers are { en, fr }.
// -----------------------------------------------------------------------------

import { CODES } from './portainer/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** Why Portainer failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
    case CODES.NO_TIME:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.TLS_UNTRUSTED:
      return { en: 'certificate not trusted', fr: 'certificat non reconnu' };
    case CODES.TLS_CHANGED:
      return { en: 'certificate changed', fr: 'certificat changé' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    default:
      return { en: err?.code ?? 'error', fr: err?.code ?? 'erreur' };
  }
}

const RETRY = (delay) => ({
  en: `Retried in ${minutes(delay)} min.`,
  fr: `Nouvel essai dans ${minutes(delay)} min.`,
});

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    ok: ({ environments, running, stopped, down, skipped }) =>
      join(
        {
          en: `Portainer answers: ${environments} ${plural(environments, 'environment', 'environments')}, ${running} ${plural(running, 'container', 'containers')} running, ${stopped} stopped.`,
          fr: `Portainer répond : ${environments} ${plural(environments, 'environnement', 'environnements')}, ${running} ${plural(running, 'conteneur', 'conteneurs')} en marche, ${stopped} ${plural(stopped, 'arrêté', 'arrêtés')}.`,
        },
        down > 0
          ? {
              en: `${down} ${plural(down, 'environment does', 'environments do')} not answer.`,
              fr: `${down} ${plural(down, 'environnement ne répond', 'environnements ne répondent')} pas.`,
            }
          : {},
        skipped > 0
          ? {
              en: `${skipped} Edge or Kubernetes ${plural(skipped, 'environment', 'environments')} left out.`,
              fr: `${skipped} ${plural(skipped, 'environnement', 'environnements')} Edge ou Kubernetes ${plural(skipped, 'ignoré', 'ignorés')}.`,
            }
          : {},
      ),
    noEnvironment: {
      en: 'Portainer answers, but no Docker environment matches: check the environment filter (names or ids), and that the token’s user can see them.',
      fr: 'Portainer répond, mais aucun environnement Docker ne correspond : vérifiez le filtre d’environnements (noms ou identifiants), et que l’utilisateur du jeton peut les voir.',
    },
    urlEmpty: {
      en: 'Type the address of Portainer (e.g. https://192.168.1.10:9443).',
      fr: 'Saisissez l’adresse de Portainer (ex. https://192.168.1.10:9443).',
    },
    urlInvalid: {
      en: 'The address of Portainer is not valid: type https://host:port (e.g. https://192.168.1.10:9443), without a query.',
      fr: 'L’adresse de Portainer n’est pas valide : saisissez https://hôte:port (ex. https://192.168.1.10:9443), sans paramètres.',
    },
    urlCredentials: {
      en: 'Remove the user name and password from the address: Gladys uses an access token.',
      fr: 'Retirez l’identifiant et le mot de passe de l’adresse : Gladys utilise un jeton d’accès.',
    },
    missingToken: {
      en: 'Type an access token of Portainer (My account, Access tokens, Add access token).',
      fr: 'Saisissez un jeton d’accès de Portainer (Mon compte, Access tokens, Add access token).',
    },
    fingerprintInvalid: {
      en: 'The certificate fingerprint must be a SHA-256 fingerprint: 64 hexadecimal digits, colons allowed.',
      fr: 'L’empreinte du certificat doit être une empreinte SHA-256 : 64 chiffres hexadécimaux, deux-points permis.',
    },
    tokenInvalid: {
      en: 'The access token holds a space or an invisible character (copied with it?): paste it again, only the token (it starts with ptr_).',
      fr: 'Le jeton d’accès contient une espace ou un caractère invisible (copié avec ?) : collez-le de nouveau, le jeton seul (il commence par ptr_).',
    },
    tlsOverHttp: {
      en: 'The certificate options only apply to https: the address uses http://, where nothing is checked and the token crosses the network in clear. Use the https address of Portainer, or clear the certificate options.',
      fr: 'Les options de certificat ne valent qu’en https : l’adresse utilise http://, où rien n’est vérifié et le jeton traverse le réseau en clair. Utilisez l’adresse https de Portainer, ou videz les options de certificat.',
    },
    tokenRefused: {
      en: 'Portainer refused the access token (HTTP 401: wrong, revoked or expired). Gladys does not try again by itself: create a new token in Portainer, paste it and save, or press "Test the connection".',
      fr: 'Portainer a refusé le jeton d’accès (HTTP 401 : faux, révoqué ou expiré). Gladys ne réessaie pas seul : créez un nouveau jeton dans Portainer, collez-le et enregistrez, ou appuyez sur « Tester la connexion ».',
    },
    forbidden: (delay) =>
      join(
        {
          en: 'Portainer refuses the list of environments to this token (HTTP 403): give its user access to the environments.',
          fr: 'Portainer refuse la liste des environnements à ce jeton (HTTP 403) : donnez à son utilisateur l’accès aux environnements.',
        },
        RETRY(delay),
      ),
    tlsUntrusted: (delay) =>
      join(
        {
          en: 'The certificate of Portainer is not trusted (its own self-signed certificate?): tick "Accept the self-signed certificate", or type its fingerprint, or install a certificate from a known authority.',
          fr: 'Le certificat de Portainer n’est pas reconnu (son certificat auto-signé ?) : cochez « Accepter le certificat auto-signé », ou saisissez son empreinte, ou installez un certificat d’une autorité reconnue.',
        },
        RETRY(delay),
      ),
    tlsChanged: (delay) =>
      join(
        {
          en: 'The certificate of Portainer is not the one trusted (pinned or typed fingerprint): nothing was sent. If you renewed it, press "Trust the new certificate" or type the new fingerprint; otherwise another machine may be impersonating Portainer.',
          fr: 'Le certificat de Portainer n’est pas celui accepté (empreinte mémorisée ou saisie) : rien n’a été envoyé. Si vous l’avez renouvelé, appuyez sur « Faire confiance au nouveau certificat » ou saisissez la nouvelle empreinte ; sinon une autre machine se fait peut-être passer pour Portainer.',
        },
        RETRY(delay),
      ),
    notPortainer: (delay) =>
      join(
        {
          en: 'This address does not answer like Portainer: check the scheme and the port (Portainer itself: 9443 for https, 9000 for http; behind a reverse proxy: its address and path).',
          fr: 'Cette adresse ne répond pas comme Portainer : vérifiez le protocole et le port (Portainer lui-même : 9443 en https, 9000 en http ; derrière un proxy inverse : son adresse et son chemin).',
        },
        RETRY(delay),
      ),
    busy: (delay) =>
      join(
        {
          en: 'Portainer asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'Portainer demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `Portainer answers with a server error (HTTP ${status}): it may be restarting or updating.`,
          fr: `Portainer répond par une erreur serveur (HTTP ${status}) : il redémarre ou se met peut-être à jour.`,
        },
        RETRY(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'Portainer does not answer:', fr: 'Portainer ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ environments, containers }) => ({
      en: `Connected: ${environments} ${plural(environments, 'environment', 'environments')}, ${containers} ${plural(containers, 'container', 'containers')}.`,
      fr: `Connecté : ${environments} ${plural(environments, 'environnement', 'environnements')}, ${containers} ${plural(containers, 'conteneur', 'conteneurs')}.`,
    }),
    trusted: {
      en: 'The new certificate is trusted: see the connection status above.',
      fr: 'Le nouveau certificat est accepté : voyez l’état de la connexion ci-dessus.',
    },
  },
  errors: {
    unknownDevice: 'Unknown device or feature: pick one of this integration',
    notConnected: 'Portainer is not connected: see the configuration of the integration',
    invalidValue: 'Invalid value: 0 or 1 expected',
    controlDisabled:
      'Starting, stopping and restarting containers is off: allow it first in the configuration of the integration ("Allow starting, stopping and restarting containers")',
    protected: (name, why) =>
      `"${name}" is ${
        {
          gladys: 'part of Gladys',
          portainer: 'Portainer itself (or its agent)',
          self: 'the container of this integration',
          docker: 'connected to the Docker socket (it manages other containers)',
        }[why] ?? 'protected'
      }: Gladys never stops nor restarts it. Nothing was sent`,
    tooSlow:
      'The command could not be checked in time (Gladys waits 5 s for its answer): nothing was sent, try again',
    unknownState: (err) =>
      `The current state could not be read (${reasonOf(err).en}): nothing was sent`,
    unknownContainer: 'This container no longer exists in this environment: nothing was sent',
    stillRunning:
      'The previous command on this container is still running in Docker: nothing was sent, try again in a moment',
    notSent: (err) =>
      `The command could not reach Portainer (${reasonOf(err).en}): nothing was sent`,
    refused: (err) => `Portainer refused the command (${reasonOf(err).en})`,
    configChanged: 'The configuration changed meanwhile: nothing was sent, try again',
    busy: 'Portainer asked Gladys to slow down: nothing was sent, try again later',
    busyRefused:
      'Portainer refused the request (HTTP 429, too many requests): nothing was done, Gladys pauses its requests',
    testTooLong:
      'Portainer has not answered yet: see the connection status in a moment (nothing else to do)',
    selfSignedOff:
      'The self-signed certificate is not accepted: tick "Accept the self-signed certificate" first (a typed fingerprint is changed in its own field)',
  },
};
