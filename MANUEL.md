# Manuel d'utilisation — SSH Tunnel Manager

Application de bureau (Electron) permettant de gérer visuellement des tunnels SSH, regroupés par base de données et environnement.

---

## Sommaire

1. [Prérequis](#prérequis)
2. [Installation](#installation)
3. [Configuration du mot de passe](#configuration-du-mot-de-passe)
4. [Configuration SSH](#configuration-ssh)
5. [Démarrage](#démarrage)
6. [Interface](#interface)
7. [États des tunnels](#états-des-tunnels)
8. [Reconnexion automatique](#reconnexion-automatique)
9. [Éditeur de configuration SSH](#éditeur-de-configuration-ssh)
10. [Fonctionnement interne](#fonctionnement-interne)

---

## Prérequis

Les outils suivants doivent être installés et disponibles dans votre `PATH` :

| Outil | Rôle |
|-------|------|
| `autossh` | Maintien de la connexion SSH avec reprise automatique |
| `expect` | Saisie automatique du mot de passe lors de la connexion |
| Node.js + npm | Exécution de l'application Electron |

Installation sur macOS via Homebrew :

```bash
brew install autossh expect
```

---

## Installation

```bash
git clone <url-du-dépôt>
cd ssh-tunnel-manager
npm install
```

---

## Configuration du mot de passe

Le mot de passe utilisé est votre **mot de passe de compte utilisateur d'entreprise**, nécessaire pour s'authentifier auprès du bastion SSH lors de chaque connexion.

Il est stocké de façon sécurisée dans le **Trousseau macOS (Keychain)** — jamais dans un fichier sur le disque.

### Premier lancement

Au démarrage, une barre apparaît en bas de l'interface :

- Si aucun mot de passe n'est configuré → un champ de saisie s'affiche directement.
- Saisissez votre mot de passe et cliquez **Enregistrer**.
- macOS affichera une popup *"ssh-tunnel-manager souhaite accéder à votre trousseau"* : cliquez **Toujours autoriser** pour ne plus jamais être sollicité.

### Migration depuis `password.txt`

Si un fichier `password.txt` existe dans le dossier de l'application (ancienne méthode), il est **automatiquement migré** dans le Keychain au premier lancement, puis **supprimé**.

### Modifier ou supprimer le mot de passe

La barre en bas de l'interface expose deux boutons :
- **Modifier** : saisir un nouveau mot de passe (remplace l'entrée Keychain existante)
- **Supprimer** : efface l'entrée du Trousseau (les tunnels ne pourront plus se connecter)

---

## Configuration SSH

L'application lit le fichier `~/.ssh/config` et sélectionne uniquement les hôtes précédés de la balise `#ssh-tunnel-manager`.

### Convention de nommage

Les hôtes doivent suivre le format :

```
{bdd}-{env}-tunnel
```

Exemples : `cat-qual-tunnel`, `cat-prod-tunnel`, `duty-prep-tunnel`.

- La **première partie** (`cat`, `duty`…) est le nom de la base de données — c'est le regroupement affiché dans l'interface.
- La **partie centrale** (`dev`, `qual`, `prep`, `prod`…) est l'environnement affiché sur le bouton.
- Le suffixe `-tunnel` est obligatoire.

### Exemple de bloc `~/.ssh/config`

```sshconfig
#ssh-tunnel-manager
Host cat-qual-tunnel
    HostName bastion.exemple.cloud
    User monuser
    Port 22
    # BDD principale
    LocalForward 127.0.0.1:50201 ma-bdd.rds.amazonaws.com:5432

#ssh-tunnel-manager
Host cat-prod-tunnel
    HostName bastion.exemple.cloud
    User monuser
    Port 22
    # BDD principale
    LocalForward 127.0.0.1:50301 ma-bdd-prod.rds.amazonaws.com:5432
```

> La balise `#ssh-tunnel-manager` doit être placée **sur la ligne qui précède immédiatement** le bloc `Host`.

Les lignes de commentaire (`# …`) placées juste avant un `LocalForward` servent de **labels** : ils sont affichés et éditables dans l'éditeur intégré.

---

## Démarrage

```bash
npm start
```

L'application s'ouvre dans une fenêtre dédiée. Laissez le terminal ouvert : les logs `autossh`/`expect` y sont redirigés.

---

## Interface

La fenêtre s'adapte **automatiquement en hauteur** selon le nombre de groupes BDD et l'ouverture éventuelle de l'éditeur.

```
┌──────────────────────────────────────────────────────┐
│               Dashboard Tunnels SSH                  │
│        Suivi (#ssh-tunnel-manager)                   │
│ ┌────────────────────────────────────────────────┐   │
│ │ CAT  [●DEV][✎] [●QUAL][✎] [●PREP][✎] [●PROD][✎]  ↺ auto │
│ │ DUTY [●QUAL][✎] [●PREP][✎] [●PROD][✎]            ↺ auto │
│ └────────────────────────────────────────────────┘   │
│ 🔑 Mot de passe bastion : enregistré dans le Trousseau  [Modifier] [Supprimer] │
└──────────────────────────────────────────────────────┘
```

### Lecture d'une ligne

Chaque ligne correspond à une **base de données** (BDD). Les boutons représentent les **environnements** disponibles.

Chaque cellule d'environnement contient deux boutons :
- Le **bouton principal** : point coloré (statut) + libellé de l'env — déclenche connexion/déconnexion au clic
- Le **bouton crayon `✎`** : ouvre l'éditeur de configuration pour cet environnement

### Actions au clic sur le bouton principal

| État | Action |
|------|--------|
| ⚫ Inactif | Lance le tunnel |
| 🟢 Actif | Arrête le tunnel |
| 🔴 Coupé | Relance le tunnel |

Un **cercle de chargement animé** remplace le point pendant toute la durée de l'opération.

---

## États des tunnels

| Indicateur | Couleur | Signification |
|---|---|---|
| ● | 🟢 Vert | Tunnel actif et connecté |
| ● | ⚫ Gris | Tunnel inactif (jamais lancé ou arrêté manuellement) |
| ● | 🔴 Rouge | Tunnel coupé de façon inattendue (réseau, timeout…) |

Le tableau de bord se rafraîchit automatiquement toutes les **15 secondes** pour détecter les coupures.

> La détection repose sur la surveillance du processus `autossh` en mémoire. Si le processus s'arrête sans action manuelle de l'utilisateur, le tunnel passe en état **Coupé**.

---

## Reconnexion automatique

Chaque ligne BDD dispose d'une case à cocher **`↺ auto`** en bout de ligne (à droite) :

- **Non cochée (défaut)** : aucune action automatique en cas de coupure.
- **Cochée** : dès que le tableau de bord détecte qu'un tunnel de cette BDD est en état *Coupé*, une tentative de reconnexion est lancée automatiquement au prochain rafraîchissement (dans les 15 secondes).

> L'état de la case à cocher est conservé en mémoire le temps que l'application est ouverte. Il est remis à zéro au redémarrage.

---

## Éditeur de configuration SSH

Chaque bouton `✎` (crayon) à côté d'un environnement ouvre un **panneau d'édition** sous le tableau de bord.

### Champs éditables

| Champ | Description |
|-------|-------------|
| **Bastion (HostName)** | Adresse du bastion SSH |
| **Utilisateur** | Valeur de la directive `User` |
| **Port** | Port SSH (22 par défaut) |
| **Redirections de ports** | Liste des `LocalForward` avec leur label optionnel |

### Redirections de ports

Chaque redirection est affichée sur deux lignes :
- **Label** (optionnel) : commentaire libre affiché dans `~/.ssh/config` sous forme `# label`
- **Local → Distant** : adresse locale (ex: `127.0.0.1:50201`) et hôte distant (ex: `ma-bdd.rds.amazonaws.com:5432`)

Boutons disponibles :
- **`✕`** : supprime la redirection
- **`＋ Ajouter une redirection`** : ajoute une ligne vide
- **Annuler** : ferme l'éditeur sans sauvegarder
- **💾 Enregistrer** : écrit les modifications directement dans `~/.ssh/config`

> L'enregistrement est chirurgical : seul le bloc `Host` concerné est modifié, le reste du fichier est préservé à l'identique.

---

## Fonctionnement interne

```
npm start
   └── Electron (main.js)
         ├── Lit ~/.ssh/config  →  hôtes marqués #ssh-tunnel-manager
         ├── Pour chaque tunnel lancé :
         │     lit le mot de passe depuis le Trousseau macOS (keytar)
         │     → spawn expect → autossh -M 0 -N <host>
         │     Les sorties (logs) sont redirigées vers le terminal d'origine
         └── IPC avec le renderer (index.html)
               ├── get-ssh-hosts-with-status  →  liste des hôtes + état
               ├── launch-tunnel              →  démarre le processus
               ├── stop-tunnel                →  kill + nettoyage
               ├── get-host-config            →  lit un bloc Host du fichier SSH
               ├── save-host-config           →  réécrit un bloc Host du fichier SSH
               ├── has-password               →  vérifie la présence dans le Keychain
               ├── set-password               →  enregistre dans le Keychain
               ├── delete-password            →  supprime du Keychain
               └── resize-window              →  adapte la hauteur de la fenêtre
```

Les fichiers `.exp` (scripts `expect`) sont créés temporairement dans le dossier de l'application à chaque lancement de tunnel et supprimés automatiquement à l'arrêt.
