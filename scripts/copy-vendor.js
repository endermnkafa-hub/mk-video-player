// hls.js dosyasını frontend/vendor altına kopyalar (CDN bağımlılığı yok, CSP 'self' ile uyumlu).
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
const destDir = path.join(root, 'frontend', 'vendor');
if (!fs.existsSync(src)) {
  console.warn('[copy-vendor] hls.min.js bulunamadı, atlandı:', src);
  process.exit(0);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, path.join(destDir, 'hls.min.js'));
console.log('[copy-vendor] hls.min.js kopyalandı');
