'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DownloadManager } = require('../../electron/lib/downloads.js');

test('DownloadManager: başlatma, listeleme, iptal ve dosya temizleme', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-dl-test-'));
  const dlDir = path.join(tmpDir, 'downloads');
  const metaPath = path.join(tmpDir, 'downloads.json');

  const mgr = new DownloadManager({
    downloadDir: dlDir,
    metadataPath: metaPath,
  });

  assert.equal(mgr.list().length, 0);

  // Doğrudan indirme kaydı ekleme ve dosya oluşturma
  const item = await mgr.startDownload({
    title: 'Test Video',
    streamUrl: 'http://127.0.0.1/fake.mp4',
    kind: 'mp4',
    pageUrl: 'http://127.0.0.1/page',
  });

  assert.ok(item && item.id);
  assert.equal(item.status, 'downloading');
  assert.equal(mgr.list().length, 1);

  // İptal etme
  const cancelled = mgr.cancel(item.id);
  assert.equal(cancelled, true);
  assert.equal(mgr.get(item.id).status, 'cancelled');

  // Silme
  const deleted = mgr.delete(item.id);
  assert.equal(deleted, true);
  assert.equal(mgr.list().length, 0);
  await new Promise((r) => setTimeout(r, 50));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

test('DownloadManager: HLS fallback (saf HTTP parça indirici) ffmpeg olmadan segmentleri başarıyla birleştirir', async () => {
  const http = require('http');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-dl-hls-'));
  const dlDir = path.join(tmpDir, 'downloads');
  const metaPath = path.join(tmpDir, 'downloads.json');

  const server = http.createServer((req, res) => {
    if (req.url === '/playlist.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXTINF:5.0,\nseg1.ts\n#EXTINF:5.0,\nseg2.ts\n#EXT-X-ENDLIST');
    } else if (req.url === '/seg1.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.from('SEGMENT1_CONTENT_'));
    } else if (req.url === '/seg2.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.end(Buffer.from('SEGMENT2_CONTENT'));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  let progressReported = false;
  const mgr = new DownloadManager({
    downloadDir: dlDir,
    metadataPath: metaPath,
    onProgress: (rec) => {
      if (rec.progress > 0) progressReported = true;
    },
  });

  const record = {
    id: 'test_hls_dl',
    title: 'HLS Test Video',
    filename: 'test_hls.mp4',
    filePath: path.join(dlDir, 'test_hls.mp4'),
    kind: 'hls',
    proxyUrl: `http://127.0.0.1:${port}/playlist.m3u8`,
    status: 'downloading',
    progress: 0,
    downloadedBytes: 0,
  };

  await mgr._downloadHlsFallback(record);

  assert.equal(record.status, 'completed');
  assert.equal(record.progress, 100);
  assert.equal(progressReported, true);
  assert.ok(fs.existsSync(record.filePath));
  const fileContent = fs.readFileSync(record.filePath, 'utf8');
  assert.equal(fileContent, 'SEGMENT1_CONTENT_SEGMENT2_CONTENT');

  server.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});
