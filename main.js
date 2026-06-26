const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec } = require('child_process');
const keytar = require('keytar');

const KEYCHAIN_SERVICE = 'ssh-tunnel-manager';
const KEYCHAIN_ACCOUNT = 'bastion-password';

let mainWindow;

const processusActifs = {};
const tunnelsDeconnectes = new Set();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 580,
        height: 200,
        minWidth: 500,
        resizable: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

ipcMain.on('resize-window', (event, contentHeight) => {
    if (!mainWindow) return;
    const [width] = mainWindow.getSize();
    const newHeight = Math.max(200, Math.min(contentHeight + 28, 900));
    mainWindow.setSize(width, newHeight, true);
});

// ─── Helpers parsing ~/.ssh/config ────────────────────────────────────────────

function parseHostBlock(lines, host) {
    let inBlock = false;
    let markedNext = false;
    let pendingLabel = '';
    const config = { hostname: '', user: '', port: '22', localForwards: [] };

    for (const line of lines) {
        const trimmed = line.trim();
        const lower = trimmed.toLowerCase();

        if (lower === '#ssh-tunnel-manager') { markedNext = true; continue; }

        if (lower.startsWith('host ')) {
            if (inBlock) break;
            if (markedNext && trimmed.split(/\s+/)[1] === host) inBlock = true;
            markedNext = false;
            continue;
        }

        if (!inBlock) { markedNext = false; continue; }

        if (lower.startsWith('hostname '))         config.hostname = trimmed.replace(/^hostname\s+/i, '');
        else if (lower.startsWith('user '))         config.user     = trimmed.replace(/^user\s+/i, '');
        else if (lower.startsWith('port '))         config.port     = trimmed.replace(/^port\s+/i, '');
        else if (trimmed.startsWith('#'))            pendingLabel    = trimmed.replace(/^#+\s*/, '');
        else if (lower.startsWith('localforward ')) {
            const p = trimmed.split(/\s+/);
            config.localForwards.push({ label: pendingLabel, local: p[1] || '', remote: p[2] || '' });
            pendingLabel = '';
        }
    }
    return inBlock ? config : null;
}

function replaceHostBlock(lines, host, newConfig) {
    let blockStart = -1;
    let blockEnd   = lines.length;
    let lastMarkerIdx = -1;
    let inBlock    = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const lower   = trimmed.toLowerCase();

        if (lower === '#ssh-tunnel-manager') {
            if (inBlock) { blockEnd = i; break; }
            lastMarkerIdx = i;
            continue;
        }

        if (lower.startsWith('host ')) {
            if (inBlock) { blockEnd = i; break; }
            if (lastMarkerIdx !== -1 && trimmed.split(/\s+/)[1] === host) {
                blockStart = lastMarkerIdx;
                inBlock = true;
            }
            lastMarkerIdx = -1;
            continue;
        }
    }

    if (blockStart === -1) return null;

    // Trim trailing blank lines si c'est la fin du fichier
    if (blockEnd === lines.length) {
        while (blockEnd > blockStart && lines[blockEnd - 1].trim() === '') blockEnd--;
    }

    const newBlock = [
        '#ssh-tunnel-manager',
        `Host ${host}`,
        `    HostName ${newConfig.hostname}`,
        `    User ${newConfig.user}`,
        `    Port ${newConfig.port}`,
    ];
    newConfig.localForwards.forEach(lf => {
        if (lf.label && lf.label.trim()) newBlock.push(`    # ${lf.label.trim()}`);
        newBlock.push(`    LocalForward ${lf.local} ${lf.remote}`);
    });

    return [...lines.slice(0, blockStart), ...newBlock, ...lines.slice(blockEnd)].join('\n');
}

// ─── IPC : lecture / écriture config d'un host ───────────────────────────────

ipcMain.handle('get-host-config', async (event, host) => {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    try {
        const lines  = fs.readFileSync(sshConfigPath, 'utf-8').split('\n');
        const config = parseHostBlock(lines, host);
        if (!config) return { success: false, error: `Hôte "${host}" introuvable.` };
        return { success: true, config };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('save-host-config', async (event, host, newConfig) => {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    try {
        const lines      = fs.readFileSync(sshConfigPath, 'utf-8').split('\n');
        const newContent = replaceHostBlock(lines, host, newConfig);
        if (newContent === null)
            return { success: false, error: `Hôte "${host}" introuvable dans ~/.ssh/config` };
        fs.writeFileSync(sshConfigPath, newContent, 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ─── IPC : gestion du mot de passe dans le Keychain ──────────────────────────

ipcMain.handle('has-password', async () => {
    const pwd = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return !!pwd;
});

ipcMain.handle('set-password', async (event, password) => {
    try {
        await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, password);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('delete-password', async () => {
    try {
        await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ─── IPC : statut des tunnels ────────────────────────────────────────────────
ipcMain.handle('get-ssh-hosts-with-status', async () => {
    const sshConfigPath = path.join(os.homedir(), '.ssh', 'config');
    const hosts = [];

    if (!fs.existsSync(sshConfigPath)) {
        throw new Error("Le fichier ~/.ssh/config est introuvable.");
    }

    try {
        fs.accessSync(sshConfigPath, fs.constants.R_OK);
        const content = fs.readFileSync(sshConfigPath, 'utf-8');
        const lines = content.split('\n');

        let selectionnerProchainHost = false;
        const tempHosts = [];

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;

            if (trimmed.toLowerCase() === '#ssh-tunnel-manager') {
                selectionnerProchainHost = true;
                return;
            }

            if (trimmed.toLowerCase().startsWith('host ')) {
                if (selectionnerProchainHost) {
                    const parts = trimmed.split(/\s+/);
                    if (parts.length > 1 && !parts[1].includes('*')) {
                        tempHosts.push(parts[1]);
                    }
                }
                selectionnerProchainHost = false;
            }
        });

        const checkStatus = (host) => {
            return new Promise((resolve) => {
                const enfant = processusActifs[host];
                // Processus en mémoire et toujours en vie
                if (enfant && enfant.exitCode === null && !enfant.killed) {
                    resolve({ name: host, active: true, deconnecte: false });
                    return;
                }
                // Tunnel lancé par l'app mais process mort inopinément
                if (tunnelsDeconnectes.has(host)) {
                    resolve({ name: host, active: false, deconnecte: true });
                    return;
                }
                // Fallback : vérification système (tunnels lancés en dehors de l'app)
                exec(`ps aux | grep "autossh" | grep "${host}" | grep -v "grep"`, (err, stdout) => {
                    resolve({ name: host, active: !!stdout.trim(), deconnecte: false });
                });
            });
        };

        const hostsWithStatus = await Promise.all(tempHosts.map(h => checkStatus(h)));
        return { success: true, hosts: hostsWithStatus };

    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 2. Lancer le tunnel DIRECTEMENT dans le terminal actuel (qui a fait npm start)
ipcMain.on('launch-tunnel', async (event, host) => {
    let password = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);

    if (!password) {
        // Fallback : migration depuis password.txt si présent
        const pwdPath = path.join(__dirname, 'password.txt');
        if (fs.existsSync(pwdPath)) {
            password = fs.readFileSync(pwdPath, 'utf-8').trim();
            await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, password);
            fs.unlinkSync(pwdPath);
            console.log('✓ Mot de passe migré depuis password.txt vers le Trousseau macOS. Fichier supprimé.');
        } else {
            console.error('Erreur : aucun mot de passe trouvé. Configurez-le depuis l\'application.');
            event.sender.send('password-required');
            return;
        }
    }
    const scriptPath = path.join(__dirname, `run_${host}.exp`);

    const expectScriptContent = `#!/usr/bin/expect -f
set timeout -1
spawn autossh -M 0 -N ${host}
expect {
    "*password:*" { send "${password}\\r"; exp_continue }
    eof
}
`;

    try {
        fs.writeFileSync(scriptPath, expectScriptContent, 'utf-8');
        fs.chmodSync(scriptPath, '755');

        // On lance le processus en arrière-plan sous Node.js mais rattaché au terminal d'origine
        // 'spawn' permet de garder une référence sur le processus pour le couper plus tard
        const { spawn } = require('child_process');
        const enfant = spawn(scriptPath, [], {
            stdio: 'inherit' // Déporte les entrées/sorties textuelles directement dans ton iTerm actuel !
        });

        // On garde le processus en mémoire pour pouvoir l'arrêter au clic sur le bouton
        processusActifs[host] = enfant;

        // Si le tunnel se coupe tout seul (ex: erreur réseau)
        enfant.on('close', () => {
            if (processusActifs[host]) {
                // Clôture inattendue : on marque comme déconnecté
                tunnelsDeconnectes.add(host);
                delete processusActifs[host];
            }
            if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
        });

    } catch (error) {
        console.error("Erreur lors du lancement dans le terminal actuel :", error);
    }
});

// 3. Arrêter le tunnel et nettoyer son processus et son fichier
ipcMain.on('stop-tunnel', (event, host) => {
    // Si on a le processus en mémoire, on lui envoie un signal d'arrêt (SIGTERM)
    if (processusActifs[host]) {
        processusActifs[host].kill();
        delete processusActifs[host];
    }
    // Arrêt manuel : on efface aussi l'état déconnecté
    tunnelsDeconnectes.delete(host);

    // Sécurité : On s'assure aussi de tuer le autossh système si besoin
    const cmdGetPid = `ps aux | grep "autossh" | grep "${host}" | grep -v "grep" | awk '{print $2}'`;
    exec(cmdGetPid, (err, stdout) => {
        if (stdout.trim()) {
            const pids = stdout.trim().split('\n');
            pids.forEach(pid => exec(`kill ${pid}`));
        }
    });

    // Nettoyage du fichier temporaire
    const scriptPath = path.join(__dirname, `run_${host}.exp`);
    setTimeout(() => {
        if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);
    }, 5000);
});

// ─── Fermeture propre — tous les cas (bouton ✕, Cmd+Q, menu Electron) ─────────

function couperTousTunnels() {
    const { execSync } = require('child_process');

    Object.keys(processusActifs).forEach(host => {
        // 1. Tuer le processus Node.js enfant (expect)
        try { processusActifs[host].kill(); } catch (e) {}

        // 2. S'assurer que le autossh système est aussi tué (kill synchrone avant exit)
        try {
            const pids = execSync(
                `ps aux | grep "autossh" | grep "${host}" | grep -v "grep" | awk '{print $2}'`
            ).toString().trim();
            if (pids) pids.split('\n').forEach(pid => { try { execSync(`kill ${pid}`); } catch (e) {} });
        } catch (e) {}
    });

    // 3. Nettoyage des scripts expect temporaires restants
    try {
        fs.readdirSync(__dirname)
            .filter(f => f.startsWith('run_') && f.endsWith('.exp'))
            .forEach(f => { try { fs.unlinkSync(path.join(__dirname, f)); } catch (e) {} });
    } catch (e) {}
}

// Se déclenche quelle que soit la façon de quitter (Cmd+Q, menu, programmatique)
app.on('before-quit', couperTousTunnels);

// Fermeture de la fenêtre → quitter l'app (y compris sur macOS)
app.on('window-all-closed', () => app.quit());