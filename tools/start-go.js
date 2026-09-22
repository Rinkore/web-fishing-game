'use strict';

// Development launcher for the Go application. Node is used only as the
// cross-platform process wrapper; the game server itself is always Go.
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = path.join(root, 'server-go');
const env = { ...process.env };
if (!env.FISHING_GO_LISTEN) env.FISHING_GO_LISTEN = '127.0.0.1:9000';
if (!env.FISHING_GO_FRONTEND_DIR) env.FISHING_GO_FRONTEND_DIR = path.join(root, 'frontend');

const packaged = path.join(root, 'game.exe');
const command = require('fs').existsSync(packaged) ? packaged : (process.env.GO_EXE || 'go');
const args = command === packaged ? [] : ['run', './cmd/game'];
const child = spawn(command, args, {
  cwd: command === packaged ? root : server,
  env,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('error', err => {
  console.error('[go] unable to start Go server:', err.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code == null ? 1 : code;
  }
});
