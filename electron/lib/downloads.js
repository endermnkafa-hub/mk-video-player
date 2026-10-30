'use strict';
/**
 * MK VideoPlayer - Video İndirme ve Çevrimdışı İzleme Yöneticisi (DownloadManager)
 *
 * - HLS (.m3u8) veya doğrudan MP4 akışlarını diske kaydeder.
 * - HLS için varsa yerel ffmpeg kullanarak remux eder (kayıpsız, yeniden kodlamasız).
 * - MP4 için doğrudan parça parça akış indirir.
 * - İndirme ilerlemesini (yüzde, hız, bayt) gerçek zamanlı bildirir.
 * - İndirilen videoları çevrimdışı yerel sunucudan izlenebilir kılar.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

class DownloadManager {
  constructor({ downloadDir, metadataPath, onProgress, onListChange }) {
    this.downloadDir = downloadDir;
    this.metadataPath = metadataPath;
    this.onProgress = onProgress;
    this.onListChange = onListChange;
    this.activeTasks = new Map(); // id -> { process, req, cancelled, ... }
    this.items = [];

    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    if (this.downloadDir && !fs.existsSync(this.downloadDir)) {
      try { fs.mkdirSync(this.downloadDir, { recursive: true }); } catch (_) {}
    }
  }

  _load() {
    if (!this.metadataPath) return;
    try {
      if (fs.existsSync(this.metadataPath)) {
        const raw = fs.readFileSync(this.metadataPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.items = parsed.map((it) => {
            // Eğer tamamlanmamış ve aktif değilse durduruldu/hata olarak işaretle
            if (it.status === 'downloading') {
              return { ...it, status: 'error', error: 'Uygulama kapandığı için indirme durduruldu.' };
            }
            return it;
          });
        }
      }
    } catch (_) {
      this.items = [];
    }
  }

  _save() {
    if (!this.metadataPath) return;
    try {
      const dir = path.dirname(this.metadataPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.metadataPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
      fs.renameSync(tmp, this.metadataPath);
      if (this.onListChange) this.onListChange(this.list());
    } catch (e) {
      console.error('DownloadManager metadata kaydetme hatası:', e);
    }
  }

  list() {
    return [...this.items].map((it) => ({
      ...it,
      fileExists: it.filePath ? fs.existsSync(it.filePath) : false,
    }));
  }

  get(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  _sanitizeFilename(name) {
    return String(name || 'video')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
  }

  async startDownload({ title, streamUrl, proxyUrl, kind, pageUrl }) {
    this._ensureDir();
    const id = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const safeTitle = this._sanitizeFilename(title || 'MK_Video');
    const filename = `${safeTitle}_${Date.now().toString().slice(-4)}.mp4`;
    const targetPath = path.join(this.downloadDir, filename);

    const record = {
      id,
      title: title || 'Video',
      filename,
      filePath: targetPath,
      kind: kind || 'mp4',
      pageUrl: pageUrl || '',
      streamUrl: streamUrl || '',
      proxyUrl: proxyUrl || streamUrl || '',
      status: 'downloading',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    };

    this.items.unshift(record);
    this._save();

    // İndirmeyi arka planda başlat
    if (kind === 'hls') {
      this._downloadHls(record);
    } else {
      this._downloadDirect(record);
    }

    return record;
  }

  _downloadDirect(record) {
    const downloadUrl = record.proxyUrl || record.streamUrl;
    if (!downloadUrl) {
      record.status = 'error';
      record.error = 'İndirilecek URL bulunamadı.';
      this._save();
      return;
    }

    const fileStream = fs.createWriteStream(record.filePath);
    fileStream.on('error', () => {});
    const client = downloadUrl.startsWith('https:') ? https : http;

    let req = null;
    try {
      req = client.get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fileStream.close();
          try { fs.unlinkSync(record.filePath); } catch (_) {}
          record.proxyUrl = res.headers.location;
          return this._downloadDirect(record);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          record.status = 'error';
          record.error = `Sunucu hatası: HTTP ${res.statusCode}`;
          fileStream.close();
          this._save();
          return;
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        record.totalBytes = totalBytes;
        let downloaded = 0;
        let lastReport = 0;

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          record.downloadedBytes = downloaded;
          if (totalBytes > 0) {
            record.progress = Math.min(100, Math.round((downloaded / totalBytes) * 100));
          }

          const now = Date.now();
          if (now - lastReport > 600) {
            lastReport = now;
            if (this.onProgress) this.onProgress({ ...record });
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          record.status = 'completed';
          record.progress = 100;
          record.completedAt = Date.now();
          this.activeTasks.delete(record.id);
          this._save();
          if (this.onProgress) this.onProgress({ ...record });
        });
      });

      req.on('error', (err) => {
        fileStream.close();
        try { if (fs.existsSync(record.filePath)) fs.unlinkSync(record.filePath); } catch (_) {}
        record.status = 'error';
        record.error = `İndirme hatası: ${err.message}`;
        this.activeTasks.delete(record.id);
        this._save();
        if (this.onProgress) this.onProgress({ ...record });
      });

      this.activeTasks.set(record.id, { req, filePath: record.filePath, fileStream });
    } catch (e) {
      record.status = 'error';
      record.error = e.message;
      this._save();
    }
  }

  _fetchHttp(url, isBinary = false, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      if (redirectCount > 5) return reject(new Error('Çok fazla yönlendirme'));
      const client = url.startsWith('https:') ? https : http;
      const req = client.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, url).href;
          return resolve(this._fetchHttp(nextUrl, isBinary, redirectCount + 1));
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve(isBinary ? buf : buf.toString('utf8'));
        });
      });
      req.on('error', reject);
    });
  }

  async _downloadHlsFallback(record) {
    const streamUrl = record.proxyUrl || record.streamUrl;
    if (!streamUrl) {
      record.status = 'error';
      record.error = 'HLS adresi bulunamadı';
      this._save();
      return;
    }

    let isCancelled = false;
    let currentReq = null;
    let fileStream = null;

    this.activeTasks.set(record.id, {
      abort: () => {
        isCancelled = true;
        if (currentReq) {
          try { currentReq.abort(); } catch (_) {}
        }
        if (fileStream) {
          try { fileStream.close(); } catch (_) {}
        }
      },
      filePath: record.filePath,
    });

    try {
      // 1. Manifest dosyasını indir
      let manifestText = await this._fetchHttp(streamUrl, false);
      let playlistUrl = streamUrl;

      // 2. Eğer master manifest ise (#EXT-X-STREAM-INF), ilk alt akışa geç
      if (manifestText.includes('#EXT-X-STREAM-INF')) {
        const lines = manifestText.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXT-X-STREAM-INF') && i + 1 < lines.length) {
            let nextLine = lines[i + 1].trim();
            if (nextLine && !nextLine.startsWith('#')) {
              playlistUrl = new URL(nextLine, playlistUrl).href;
              manifestText = await this._fetchHttp(playlistUrl, false);
              break;
            }
          }
        }
      }

      // 3. Segment URL'lerini ayıkla
      const segmentUrls = [];
      const lines = manifestText.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          segmentUrls.push(new URL(trimmed, playlistUrl).href);
        }
      }

      if (segmentUrls.length === 0) {
        record.status = 'error';
        record.error = 'HLS akışında parça (segment) bulunamadı.';
        this.activeTasks.delete(record.id);
        this._save();
        if (this.onProgress) this.onProgress({ ...record });
        return;
      }

      // 4. Parçaları sırayla indir ve dosyaya ekle
      fileStream = fs.createWriteStream(record.filePath);
      fileStream.on('error', () => {});
      const totalSegments = segmentUrls.length;
      let downloadedBytes = 0;
      let lastReport = 0;

      for (let i = 0; i < totalSegments; i++) {
        if (isCancelled || record.status === 'cancelled') {
          fileStream.close();
          try { if (fs.existsSync(record.filePath)) fs.unlinkSync(record.filePath); } catch (_) {}
          return;
        }

        const segUrl = segmentUrls[i];
        const segData = await new Promise((resolve, reject) => {
          const client = segUrl.startsWith('https:') ? https : http;
          currentReq = client.get(segUrl, (res) => {
            if (res.statusCode !== 200 && res.statusCode !== 206) {
              return reject(new Error(`Segment indirilemedi: HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
          });
          currentReq.on('error', reject);
        });

        fileStream.write(segData);
        downloadedBytes += segData.length;
        record.downloadedBytes = downloadedBytes;
        record.progress = Math.min(100, Math.round(((i + 1) / totalSegments) * 100));

        const now = Date.now();
        if (now - lastReport > 600 || i === totalSegments - 1) {
          lastReport = now;
          if (this.onProgress) this.onProgress({ ...record });
        }
      }

      fileStream.end();
      record.status = 'completed';
      record.progress = 100;
      record.completedAt = Date.now();
      record.totalBytes = downloadedBytes;
      this.activeTasks.delete(record.id);
      this._save();
      if (this.onProgress) this.onProgress({ ...record });
    } catch (err) {
      if (fileStream) fileStream.close();
      if (isCancelled || record.status === 'cancelled') return;
      record.status = 'error';
      record.error = `Akış indirme hatası: ${err.message}`;
      this.activeTasks.delete(record.id);
      this._save();
      if (this.onProgress) this.onProgress({ ...record });
    }
  }

  _downloadHls(record) {
    // HLS proxy URL'i FastAPI yerel sunucumuz üzerinden manifest ve segmentleri çeker
    const streamUrl = record.proxyUrl || record.streamUrl;
    let proc = null;
    try {
      proc = spawn('ffmpeg', [
        '-y',
        '-i', streamUrl,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        record.filePath,
      ], { windowsHide: true });
    } catch (_) {
      return this._downloadHlsFallback(record);
    }

    let lastProgressTime = 0;
    this.activeTasks.set(record.id, { process: proc, filePath: record.filePath });

    proc.stderr.on('data', (data) => {
      const line = data.toString();
      // ffmpeg çıktısından zaman / ilerleme tespiti
      // Örnek: time=00:12:34.56
      const timeMatch = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (timeMatch) {
        const secs = parseInt(timeMatch[1], 10) * 3600 + parseInt(timeMatch[2], 10) * 60 + parseFloat(timeMatch[3]);
        record.downloadedBytes = Math.round(secs * 250 * 1024); // tahmini bayt
        const now = Date.now();
        if (now - lastProgressTime > 800) {
          lastProgressTime = now;
          if (this.onProgress) this.onProgress({ ...record, progressSecs: secs });
        }
      }
    });

    proc.on('close', (code) => {
      this.activeTasks.delete(record.id);
      if (code === 0 && fs.existsSync(record.filePath)) {
        record.status = 'completed';
        record.progress = 100;
        record.completedAt = Date.now();
        try {
          const stats = fs.statSync(record.filePath);
          record.totalBytes = stats.size;
          record.downloadedBytes = stats.size;
        } catch (_) {}
      } else {
        if (record.status !== 'cancelled') {
          record.status = 'error';
          record.error = `ffmpeg indirmesi hata verdi (kod: ${code})`;
        }
      }
      this._save();
      if (this.onProgress) this.onProgress({ ...record });
    });

    proc.on('error', (err) => {
      this.activeTasks.delete(record.id);
      // Eğer ffmpeg sistemde kurulu değilse (ENOENT) yerel HTTP segment indiricisine geç
      if (err.code === 'ENOENT') {
        return this._downloadHlsFallback(record);
      }
      record.status = 'error';
      record.error = `ffmpeg başlatılamadı: ${err.message}`;
      this._save();
      if (this.onProgress) this.onProgress({ ...record });
    });
  }

  cancel(id) {
    const task = this.activeTasks.get(id);
    const item = this.get(id);
    if (task) {
      if (task.process) {
        try { task.process.kill(); } catch (_) {}
      }
      if (task.req) {
        try { task.req.abort(); } catch (_) {}
      }
      if (task.abort) {
        try { task.abort(); } catch (_) {}
      }
      if (task.fileStream) {
        try { task.fileStream.destroy(); } catch (_) {}
      }
      this.activeTasks.delete(id);
    }
    if (item) {
      item.status = 'cancelled';
      try {
        if (item.filePath && fs.existsSync(item.filePath)) {
          fs.unlinkSync(item.filePath);
        }
      } catch (_) {}
      this._save();
      if (this.onProgress) this.onProgress({ ...item });
      return true;
    }
    return false;
  }

  delete(id) {
    this.cancel(id);
    const item = this.get(id);
    if (item && item.filePath && fs.existsSync(item.filePath)) {
      try { fs.unlinkSync(item.filePath); } catch (_) {}
    }
    this.items = this.items.filter((it) => it.id !== id);
    this._save();
    return true;
  }
}

module.exports = { DownloadManager };
