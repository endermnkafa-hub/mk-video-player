// Python testlerini platformdan bağımsız çalıştırır (.venv varsa onu kullanır).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const venvPy = process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe')
  : path.join(root, '.venv', 'bin', 'python');

let cmd;
let args;
if (process.env.MK_PYTHON) { cmd = process.env.MK_PYTHON; args = []; }
else if (fs.existsSync(venvPy)) { cmd = venvPy; args = []; }
else if (process.platform === 'win32') { cmd = 'py'; args = ['-3']; }
else { cmd = 'python3'; args = []; }

const r = spawnSync(cmd, [...args, '-m', 'pytest', '-q', 'tests', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
