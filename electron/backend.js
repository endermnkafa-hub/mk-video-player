'use strict';
// Python arka ucunu (FastAPI) başlatır. Oturum bilgileri yalnızca bellekte tutulur;
// erişim logu kapalıdır çünkü proxy URL'leri token/sorgu içerebilir.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pythonCommand() {
  if (process.env.MK_PYTHON) return { cmd: process.env.MK_PYTHON, args: [] };
  const venv = process.platform === 'win32'
    ? path.join(ROOT, '.venv', 'Scripts', 'python.exe')
    : path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venv)) return { cmd: venv, args: [] };
  if (process.platform === 'win32') return { cmd: 'py', args: ['-3'] };
  return { cmd: 'python3', args: [] };
}

async function waitHealthy(origin, child, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error('Python arka ucu beklenmedik şekilde kapandı.');
    try {
      const r = await fetch(`${origin}/api/health`);
      if (r.ok) return;
    } catch (_) { /* henüz hazır değil */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Python arka ucu zamanında başlamadı.');
}

async function startBackend(extraEnv = {}) {
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('base64url');
  const { cmd, args } = pythonCommand();
  const child = spawn(
    cmd,
    [...args, '-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(port),
      '--no-access-log', '--log-level', 'warning'],
    {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv, MK_ADMIN_TOKEN: token, MK_ALLOWED_HOSTS: `127.0.0.1,localhost`, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  child.stdout.on('data', (d) => process.stdout.write(`[py] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[py] ${d}`));
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitHealthy(origin, child);
  } catch (e) {
    child.kill();
    throw e;
  }
  return {
    port, token, origin, child,
    async post(urlPath, body) {
      const r = await fetch(origin + urlPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MK-Token': token },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error((data.error && data.error.message) || `HTTP ${r.status}`);
        err.code = (data.error && data.error.code) || `upstream_${r.status}`;
        throw err;
      }
      return data;
    },
    async del(urlPath) {
      await fetch(origin + urlPath, { method: 'DELETE', headers: { 'X-MK-Token': token } }).catch(() => {});
    },
    stop() {
      try {
        if (child.stdout) child.stdout.destroy();
        if (child.stderr) child.stderr.destroy();
        child.kill();
      } catch (_) { /* yoksay */ }
    },
  };
}

module.exports = { startBackend, ROOT };
