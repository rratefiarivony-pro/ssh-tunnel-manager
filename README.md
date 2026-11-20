# SSH Tunnel Manager

Application de bureau **Electron** permettant de gérer des tunnels SSH vers un bastion de façon visuelle, regroupée par base de données et environnement. Elle automatise l'authentification par mot de passe via `expect`, surveille l'état des connexions et permet d'éditer la configuration SSH directement depuis l'interface.

---

## Technologies

| Couche | Technologie |
|--------|-------------|
| Runtime desktop | [Electron](https://www.electronjs.org/) v45 |
| Processus principal | Node.js (CommonJS) |
| Interface utilisateur | HTML5 / CSS3 / JavaScript vanilla |
| Communication UI ↔ main | Electron IPC (`ipcMain` / `ipcRenderer`) |
| Gestion des secrets | [keytar](https://github.com/atom/node-keytar) — Trousseau macOS (Keychain) |
| Persistance de la config SSH | Fichier `~/.ssh/config` (lecture/écriture) |
| Connexion SSH | `autossh` + `expect` (binaires système) |

---

## Librairies

### Dépendances runtime

| Package | Version | Rôle |
|---------|---------|------|
| [`keytar`](https://www.npmjs.com/package/keytar) | ^7.9.0 | Stockage sécurisé du mot de passe dans le Trousseau macOS. Expose `getPassword`, `setPassword`, `deletePassword`. Natif (module C++ compilé). |

### Dépendances de développement

| Package | Version | Rôle |
|---------|---------|------|
| [`electron`](https://www.electronjs.org/) | ^45.4.1 | Framework desktop. Fournit `BrowserWindow`, `ipcMain`, et l'environnement Node.js dans le renderer via `nodeIntegration: true`. |

### Outils système (non npm)

| Outil | Installation | Rôle |
|-------|-------------|------|
| `autossh` | `brew install autossh` | Maintient la connexion SSH et relance automatiquement en cas de coupure réseau |
| `expect` | `brew install expect` | Automatise la saisie du mot de passe lors du prompt SSH |

---

## Prérequis

- **macOS** (le stockage Keychain est spécifique à macOS)
- **Node.js** ≥ 22.12.0 et **npm**
- **Homebrew** pour les outils système

```bash
# Vérifier les versions
node --version   # ≥ 22.12.0
npm --version

# Installer les outils système
brew install autossh expect
```

---

## Initialisation

```bash
# 1. Cloner le dépôt
git clone <url-du-dépôt>
cd ssh-tunnel-manager

# 2. Installer les dépendances npm
npm install
```

> `keytar` est un module natif compilé en C++. `npm install` le compile automatiquement via `node-gyp`. Xcode Command Line Tools doit être installé (`xcode-select --install`).

### Configuration SSH

Ajouter les blocs à gérer dans `~/.ssh/config` en respectant la convention de nommage `{bdd}-{env}-tunnel` et en les préfixant de `#ssh-tunnel-manager` :

```sshconfig
#ssh-tunnel-manager
Host cat-qual-tunnel
    HostName bastion.exemple.cloud
    User monuser
    Port 22
    # Ma base de données
    LocalForward 127.0.0.1:50201 ma-bdd.rds.amazonaws.com:5432
```

### Mot de passe

Au premier lancement, l'application affiche un champ de saisie pour le mot de passe. Celui-ci est stocké dans le **Trousseau macOS** via `keytar` — aucun fichier en clair n'est créé.

Si un fichier `password.txt` existait (ancienne méthode), il est migré automatiquement dans le Keychain au premier lancement puis supprimé.

---

## Lancement

```bash
npm start
```

Cela exécute `electron .` — Electron charge `main.js` comme processus principal et `index.html` comme interface. **Laisser le terminal ouvert** : les sorties des processus `autossh`/`expect` y sont redirigées vers le terminal. Le mot de passe reste dans le Keychain et est transmis à `expect` via son entrée standard ; aucun script contenant le secret n'est créé sur disque.

Si `npm start` affiche `Downloading Electron binary...` puis `TypeError: fetch failed`, le binaire peut manquer, notamment après un nettoyage du cache. Si Node signale `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` alors que le certificat est approuvé dans le trousseau macOS, installez le binaire en utilisant les certificats système (Node.js 22.19+ ou 24.6+) :

```bash
NODE_OPTIONS=--use-system-ca npm exec --no -- install-electron
npm start
```

---

## Architecture du projet

```
ssh-tunnel-manager/
│
├── main.js          # Processus principal Electron (Node.js)
├── index.html       # Interface utilisateur (renderer)
├── style.css        # Styles de l'interface
│
├── package.json     # Dépendances et script de démarrage
├── MANUEL.md        # Manuel utilisateur
└── README.md        # Ce fichier
```

### `main.js` — Processus principal

Responsable de toute la logique système. Organisé en quatre blocs :

```
main.js
├── Initialisation
│   ├── Imports (electron, fs, os, child_process, keytar)
│   ├── État mémoire : processusActifs{}, tunnelsDeconnectes (Set)
│   └── createWindow() + resize-window IPC
│
├── Helpers ~/.ssh/config
│   ├── parseHostBlock(lines, host)   → extrait les champs d'un bloc Host
│   └── replaceHostBlock(lines, host, newConfig) → réécrit un bloc Host
│
├── IPC handlers — tunnels
│   ├── get-ssh-hosts-with-status     → liste hôtes + statut (actif/inactif/coupé)
│   ├── launch-tunnel                 → spawn expect → autossh, surveille close()
│   └── stop-tunnel                   → kill processus + nettoyage d'éventuels anciens .exp
│
├── IPC handlers — configuration SSH
│   ├── get-host-config               → lit les champs d'un hôte
│   └── save-host-config              → réécrit le bloc dans ~/.ssh/config
│
└── IPC handlers — mot de passe Keychain
    ├── has-password                  → vérifie la présence dans le Keychain
    ├── set-password                  → enregistre dans le Keychain
    └── delete-password               → supprime du Keychain
```

### `index.html` — Renderer (interface)

Chargé par Electron avec `nodeIntegration: true` — accès direct à `ipcRenderer`. Aucun framework UI, JavaScript vanilla.

```
index.html
├── DOM statique
│   ├── .tunnel-list       → conteneur du tableau de bord (rempli dynamiquement)
│   ├── #password-bar      → barre de gestion du mot de passe Keychain
│   └── #editor-panel      → panneau d'édition SSH (masqué par défaut)
│
└── JavaScript
    ├── État : loadingHosts (Set), autoReconnectBDDs (Set), currentEditingHost
    ├── parseHost(name)               → extrait { bdd, env } du nom de host
    ├── buildEnvCell(tunnel)          → construit bouton statut + bouton ✎
    ├── autoReconnect(tunnel, btn)    → déclenche reconnexion silencieuse
    ├── renderDashboard()             → récupère statuts, groupe par BDD, rend le DOM
    ├── resizeWindow()                → envoie scrollHeight au main process
    ├── openEditor(host)              → charge la config et affiche le formulaire
    ├── closeEditor()                 → masque le formulaire
    ├── addLocalForwardRow(...)       → ajoute une ligne de redirection dans le formulaire
    ├── saveConfig()                  → collecte le formulaire et appelle save-host-config
    ├── initPasswordBar()             → initialise la barre Keychain
    ├── savePassword() / deletePassword()
    └── setInterval(renderDashboard, 15 000 ms)
```

### `style.css`

CSS pur, organisé en sections :
- **Layout général** (`body`, `h2`, `.subtitle`)
- **Dashboard** (`.tunnel-list`, `.bdd-row`, `.bdd-label`, `.env-group`, `.env-cell`)
- **Boutons** (`.env-btn`, `.edit-btn`) et **indicateurs** (`.dot-*`, `.spinner`)
- **Panneau éditeur** (`.editor-panel`, `.form-*`, `.lf-*`, `.btn-save`, `.btn-cancel`)
- **Barre mot de passe** (`.password-bar`, `.pwd-*`)

### Flux de données

```
Renderer (UI)                    Main process (Node.js)          Système
─────────────────────────────────────────────────────────────────────────
clic "lancer"
  → ipcRenderer.send('launch-tunnel', host)
                                 → keytar.getPassword()          → Keychain macOS
                                 → spawn(expect, -c) + stdin     → autossh → bastion SSH
                                 ← enfant.on('close')
                                   → tunnelsDeconnectes.add(host)
                                   → ipcRenderer.send('password-required') si besoin

setInterval 15s
  → ipcRenderer.invoke('get-ssh-hosts-with-status')
                                 → processusActifs[host].exitCode
                                 → tunnelsDeconnectes.has(host)
                                 → exec('ps aux | grep autossh')
  ← { hosts: [{ name, active, deconnecte }] }
  → renderDashboard() → DOM mis à jour
  → ipcRenderer.send('resize-window', scrollHeight)
                                 → mainWindow.setSize(...)
```
