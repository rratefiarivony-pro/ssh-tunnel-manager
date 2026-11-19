const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('launch-tunnel keeps the Keychain password out of files, process arguments, and logs', async () => {
    const secret = 'test-secret-that-must-not-leak';
    const registeredListeners = new Map();
    const calls = { spawned: [], fileWrites: [], logs: [] };
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.stdin = {
        end(value) {
            calls.stdinValue = value;
        }
    };

    const electron = {
        app: {
            whenReady: () => ({ then() {} }),
            on() {},
            quit() {}
        },
        BrowserWindow: class {},
        ipcMain: {
            on(name, listener) {
                registeredListeners.set(name, listener);
            },
            handle() {}
        }
    };
    const mockFs = {
        existsSync: () => false,
        writeFileSync(...args) {
            calls.fileWrites.push(args);
        }
    };
    const mockChildProcess = {
        exec() {},
        execSync() {
            return Buffer.from('');
        },
        spawn(...args) {
            calls.spawned.push(args);
            return child;
        }
    };
    const mocks = {
        electron,
        keytar: { getPassword: async () => secret },
        fs: mockFs,
        os: { homedir: () => '/unused-home' },
        'child_process': mockChildProcess
    };
    const sandbox = {
        __dirname: path.join(__dirname, '..'),
        require(name) {
            return mocks[name] || require(name);
        },
        console: {
            log(...args) { calls.logs.push(args.join(' ')); },
            error(...args) { calls.logs.push(args.join(' ')); }
        },
        setTimeout() {}
    };

    vm.runInNewContext(mainSource, sandbox, { filename: 'main.js' });
    await registeredListeners.get('launch-tunnel')({ sender: { send() {} } }, 'test-host');

    assert.equal(calls.fileWrites.length, 0, 'launch must not create a script or other file');
    assert.equal(calls.spawned.length, 1);
    const [command, args, options] = calls.spawned[0];
    assert.equal(command, 'expect');
    assert.equal(args[0], '-c');
    assert.ok(args[1].includes('gets stdin password'));
    assert.ok(!JSON.stringify([command, args, options]).includes(secret));
    assert.equal(calls.stdinValue, `${secret}\n`);
    assert.ok(!calls.logs.join('\n').includes(secret));
});
