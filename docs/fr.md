# Portainer

Vos conteneurs Docker dans Gladys, par l'API REST de Portainer (CE ou BE 2.x)
sur votre réseau :

- chaque conteneur devient un appareil Gladys : **en marche** (un
  interrupteur : démarrer / arrêter), **sain** (son healthcheck Docker),
  **CPU (%)**, **mémoire** (Mo) et un bouton **redémarrer** ;
- chaque environnement Portainer devient un appareil avec ses **conteneurs en
  marche** et ses **conteneurs arrêtés** ;
- le déclencheur de scène **Conteneur arrêté ou malsain**.

> **Cette intégration n'a jamais été testée sur un vrai Portainer.** Cette
> première version a été écrite à partir de la référence de l'API Portainer,
> de l'API Docker Engine et de tomaae/homeassistant-portainer, et testée
> seulement contre un faux Portainer. Dites sur le forum de Gladys ce qui
> marche et ce qui ne marche pas.

Intégration non officielle, sans lien avec Portainer.io.

## Avant de commencer : un utilisateur dédié et son jeton

1. Dans Portainer, **Administration → User-related → Users**, créez un
   utilisateur `gladys` (Portainer BE : donnez-lui le rôle **Read-only user**
   sur les environnements que Gladys doit seulement surveiller, **Operator**
   là où il peut démarrer et arrêter des conteneurs ; Portainer CE :
   ajoutez-le à une équipe qui a accès à ces environnements).
2. Connectez-vous avec cet utilisateur, ouvrez **My account → Access tokens →
   Add access token**, nommez-le `gladys` et copiez le jeton (il commence par
   `ptr_`) : Portainer ne l'affiche qu'une fois.
3. Un jeton d'administrateur marche aussi, mais donne à Gladys bien plus que
   nécessaire.

## Configuration

- **Adresse de Portainer** : `https://192.168.1.10:9443`. Une adresse seule
  est lue en https sur le port 9443. Un chemin est gardé (Portainer derrière
  un proxy inverse, `https://example.org/portainer`). Évitez
  `http://192.168.1.10:9000` : le jeton traverserait votre réseau en clair.
- **Jeton d'accès** : gardé par Gladys dans sa base, jamais réaffiché, envoyé
  seulement à Portainer, dans l'en-tête `X-API-Key` (jamais dans une adresse,
  jamais dans un journal).
- **Certificat** : par défaut le certificat de Portainer doit venir d'une
  autorité reconnue (Let's Encrypt…). Portainer en génère un auto-signé sur
  le port 9443 ; deux façons de l'accepter :
  - **Accepter le certificat auto-signé** : le certificat vu à la première
    connexion est accepté et mémorisé (dans le volume `/data` de
    l'intégration) ; un autre ensuite est refusé tant que vous n'appuyez pas
    sur **Faire confiance au nouveau certificat** ;
  - **Empreinte du certificat** : plus sûr, rien d'autre n'est jamais
    accepté, même à la première connexion. Dans votre navigateur, ouvrez
    Portainer, cliquez sur le cadenas, affichez le certificat et copiez son
    empreinte SHA-256 ; ou lancez
    `openssl s_client -connect 192.168.1.10:9443 </dev/null | openssl x509 -noout -fingerprint -sha256`.
    Dans les deux cas, le certificat est vérifié AVANT l'envoi du jeton : une
    machine qui se ferait passer pour Portainer ne le reçoit jamais.
- **Environnements** : noms ou identifiants, séparés par des virgules ; vide,
  tous les environnements Docker que voit le jeton. Les environnements Edge et
  Kubernetes sont ignorés.
- **Autoriser le démarrage, l'arrêt et le redémarrage des conteneurs** :
  désactivé par défaut (voir Commandes).
- **CPU et mémoire** : toutes les minutes (par défaut) à toutes les 10
  minutes, ou non lus.

Ouvrez ensuite l'onglet **Découverte** et créez les conteneurs et
environnements à suivre. Seuls les conteneurs créés ont leur CPU et leur
mémoire lus.

## Commandes

- Désactivées par défaut : Gladys ne fait que lire. Une fois **Autoriser le
  démarrage, l'arrêt et le redémarrage des conteneurs** coché, l'interrupteur
  **en marche** démarre (activé) ou arrête (désactivé) le conteneur, et le
  bouton **redémarrer** le redémarre.
- **Jamais** arrêtés ni redémarrés depuis Gladys, même autorisé : Gladys et
  ses intégrations (une image `gladysassistant/…` ou un dépôt nommé
  `gladys…`, ou un conteneur dont le nom commence par `gladys`), Portainer et
  son agent (images `portainer/portainer-ce`, `-ee`, `portainer/agent`, ou un
  nom commençant par `portainer`), et le conteneur de cette intégration
  elle-même. Les démarrer reste possible.
- Les commandes passent une par une. Juste avant d'agir, Gladys relit le
  conteneur dans Docker : s'il n'y arrive pas, rien n'est envoyé ; si le
  conteneur est déjà en marche (démarrer) ou arrêté (arrêter), rien n'est
  envoyé non plus. Quand Portainer est trop lent pour répondre en 3,5 s, rien
  n'est envoyé et Gladys affiche un échec (jamais d'action après un échec
  affiché).
- Docker répond à un arrêt une fois le conteneur arrêté (10 s de grâce par
  défaut). Gladys n'attend pas si longtemps : il répond « fait » au plus 4,3 s
  après votre commande, une fois la commande envoyée, et l'interrupteur suit
  l'état réel dès que Docker a fini. Une autre commande sur le même conteneur
  est refusée tant que Docker travaille encore.
- Les conteneurs sont reconnus par leur **nom** (et leur environnement), pas
  par leur identifiant Docker : un conteneur recréé par une mise à jour
  d'image ou par `docker compose up` garde son appareil Gladys, son
  historique et ses scènes.

## Rafraîchissement et limites

- Les conteneurs (en marche, santé) de chaque environnement sont lus toutes
  les 30 secondes : l'interrupteur, le capteur de santé, les compteurs et le
  déclencheur ont jusqu'à 30 secondes de retard.
- Les chiffres de CPU et de mémoire coûtent à Docker environ une seconde par
  conteneur : ils ne sont lus que pour les conteneurs créés qui tournent, 25
  par tour au plus (3 à la fois ; au-delà de 25, à tour de rôle), au rythme
  choisi. Un conteneur arrêté affiche 0. Gladys reste sous 250 états par
  minute (sa limite est 300) : une fois atteint, les chiffres de CPU et de
  mémoire attendent, les états en marche et santé passent toujours.
- **CPU (%)** est le chiffre de `docker stats` : 100 veut dire un CPU occupé
  à plein (400 sur quatre CPU occupés). Gladys n'a pas de catégorie CPU : la
  fonctionnalité n'a pas d'unité. La **mémoire** est en Mo (Mio, comme
  `docker stats`), cache des pages exclu.
- **Sain** n'est publié que pour un conteneur qui a un healthcheck Docker (1
  sain, 0 malsain ; rien pendant son démarrage).
- Le déclencheur part quand un conteneur en marche s'arrête (exited ou dead),
  ou quand son healthcheck passe à malsain, une fois par changement, avec le
  conteneur, son nom, son environnement et le problème (`stopped` ou
  `unhealthy`). La première lecture après un démarrage de l'intégration ne
  déclenche rien. Un conteneur supprimé (et non arrêté) ne déclenche rien.

## Problèmes de connexion

- **Jeton refusé** (HTTP 401 : faux, révoqué ou expiré) : Gladys ne réessaie
  pas seul, même après un redémarrage. Créez un nouveau jeton, collez-le et
  enregistrez, ou appuyez sur **Tester la connexion**.
- **Portainer injoignable** : nouvel essai après 30 s, puis jusqu'à toutes
  les 10 min ; les appareils apparaissent injoignables entre-temps. Un
  environnement qui ne répond pas (agent arrêté) ne marque injoignables que
  ses propres conteneurs.
- **Portainer surchargé** (HTTP 429) : toutes les requêtes s'arrêtent de 1
  minute à 6 heures, tant que Portainer le demande (Retry-After), même après
  un redémarrage ; enregistrer la configuration ou appuyer sur **Tester la
  connexion** lève la pause.
- **Certificat changé** : rien n'est envoyé ; si vous l'avez renouvelé,
  appuyez sur **Faire confiance au nouveau certificat** (ou saisissez la
  nouvelle empreinte).

## Limites

- Un seul Portainer par intégration, 20 environnements et 500 conteneurs au
  plus.
- Environnements Docker seulement (socket, API ou agent Portainer) : les
  agents Edge (leur tunnel s'ouvre à la demande) et Kubernetes sont ignorés.
- Les tâches d'un service Swarm changent de nom à chaque mise à jour :
  chacune devient un nouvel appareil.
- Pas testé avec les règles de rôles de Portainer BE, ni avec Podman.
