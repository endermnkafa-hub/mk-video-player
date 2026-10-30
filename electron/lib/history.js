'use strict';
/**
 * MK VideoPlayer - İzleme Geçmişi ve İlerleme Deposu (WatchHistoryStore)
 *
 * - Hassas medya URL'leri ve başlıkları (Referer vb.) diskte şifreli saklanır.
 * - Electron `safeStorage` (OS DPAPI / Keychain) birincil şifreleme mekanizmasıdır.
 * - safeStorage kullanılamazsa (testler, headless ortamlar) AES-256-GCM güvenli alternatif olarak devreye girer.
 * - Düz metin (legacy v1) kayıtlar otomatik olarak şifreli v2 biçimine dönüştürülür (migrasyon).
 * - Renderer sürecine yalnızca gösterim için güvenli alanlar iletilir; çözülmüş URL ve tokenlar iletilmez.
 * - Geçmişten oynatma sırasında URL yalnızca ana süreçte ve tam oturum oluşturulurken çözülür.
 * - Atomik dosya yazımı (tmp + rename) ile veri kaybı önlenir.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const MAX_HISTORY_ITEMS = 200;

function safeNumber(val, fallback = null) {
  const n = Number(val);
  return Number.isFinite(n) && !Number.isNaN(n) && n >= 0 ? n : fallback;
}

function safeHost(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
}

function hashMediaUrl(url) {
  if (!url || typeof url !== 'string') return '';
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 24);
}

const SENSITIVE_QUERY_KEYS = [
  'token', 'sig', 'signature', 'auth', 'key', 'secret',
  'hash', 'expires', 'pass', 'ticket', 'access_token', 'id_token', 'bearer'
];

function sanitizeDisplayUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    let modified = false;
    for (const k of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.some((s) => k.toLowerCase().includes(s))) {
        u.searchParams.delete(k);
        modified = true;
      }
    }
    return modified ? u.toString() : rawUrl;
  } catch (_) {
    return rawUrl;
  }
}

/**
 * Güvenli şifreleme sağlayıcısı:
 * - Electron safeStorage (OS DPAPI/Keychain) önceliklidir.
 * - Desteklenmediği durumlarda cihaz/kullanıcı bağlamlı AES-256-GCM güvenli alternatif olarak çalışır.
 * - Düz metin tokenların diske yazılmasını kesin olarak engeller.
 */
class HistoryCrypto {
  constructor({ safeStorage = null, fallbackKey = null } = {}) {
    this._safeStorage = safeStorage || this._resolveElectronSafeStorage();
    this._fallbackKey = fallbackKey || null;
    this._cachedKey = null;
  }

  _resolveElectronSafeStorage() {
    try {
      const electron = require('electron');
      if (electron && typeof electron === 'object' && electron.safeStorage) {
        return electron.safeStorage;
      }
    } catch (_) {}
    return null;
  }

  isSafeStorageAvailable() {
    try {
      return !!(
        this._safeStorage &&
        typeof this._safeStorage.isEncryptionAvailable === 'function' &&
        this._safeStorage.isEncryptionAvailable()
      );
    } catch (_) {
      return false;
    }
  }

  getEncryptionStatus() {
    if (this.isSafeStorageAvailable()) {
      return {
        available: true,
        mode: 'safeStorage',
        warning: null,
      };
    }
    return {
      available: true,
      mode: 'aes_fallback',
      warning: 'İşletim sistemi safeStorage API kullanılamıyor; uygulama düzeyinde AES-256-GCM şifreleme devrede.',
    };
  }

  _getAesKey() {
    if (this._cachedKey) return this._cachedKey;
    if (this._fallbackKey) {
      this._cachedKey = crypto.createHash('sha256').update(String(this._fallbackKey)).digest();
      return this._cachedKey;
    }
    const seed = [
      'mk-player-history-key-v2',
      process.env.USER || process.env.USERNAME || 'mk_user',
      os.hostname() || 'mk_host',
      process.platform || 'win32',
    ].join(':');
    this._cachedKey = crypto.createHash('sha256').update(seed).digest();
    return this._cachedKey;
  }

  encrypt(plainText) {
    if (plainText === null || plainText === undefined) return '';
    const text = String(plainText);
    if (!text) return '';

    // 1. Electron safeStorage
    if (this.isSafeStorageAvailable()) {
      try {
        const buf = this._safeStorage.encryptString(text);
        return 'enc:safe:' + buf.toString('base64');
      } catch (_) {
        // safeStorage çalışma zamanı hatası durumunda AES-256-GCM yedeğine geç
      }
    }

    // 2. AES-256-GCM güvenli alternatif
    try {
      const key = this._getAesKey();
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      const combined = Buffer.concat([iv, tag, enc]);
      return 'enc:aes:' + combined.toString('base64');
    } catch (_) {
      // Şifreleme tamamen başarısız olursa düz metin yazmak yerine temizlenmiş URL döndür
      return '';
    }
  }

  decrypt(cipherText) {
    if (!cipherText || typeof cipherText !== 'string') return '';

    if (cipherText.startsWith('enc:safe:')) {
      if (!this.isSafeStorageAvailable()) {
        return '';
      }
      try {
        const buf = Buffer.from(cipherText.slice('enc:safe:'.length), 'base64');
        return this._safeStorage.decryptString(buf);
      } catch (_) {
        return '';
      }
    }

    if (cipherText.startsWith('enc:aes:')) {
      try {
        const key = this._getAesKey();
        const buf = Buffer.from(cipherText.slice('enc:aes:'.length), 'base64');
        if (buf.length < 28) return ''; // 12 byte IV + 16 byte Tag
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const enc = buf.subarray(28);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
      } catch (_) {
        return '';
      }
    }

    // Eski düz metin kayıt desteği
    return cipherText;
  }

  isEncrypted(str) {
    return typeof str === 'string' && (str.startsWith('enc:safe:') || str.startsWith('enc:aes:'));
  }
}

/**
 * Sayfa başlığından ve adresinden temiz anime/video başlığı ve bölüm bilgisini ayıklar.
 */
function extractMediaMetadata({ pageTitle, pageUrl, sourceHost, kind, sourceLabel }) {
  let title = (pageTitle || '').trim();
  let episode = null;

  // Başlıktan yaygın site takılarını temizle
  title = title
    .replace(/\s*[-–|]\s*(?:Anizm|Anime|Dizi|Film|HD\s*İzle|İzle|Watch|Online).*$/i, '')
    .replace(/\s*(?:HD\s*)?Türkçe\s*(?:Altyazılı|Dublajlı)?\s*İzle.*$/i, '')
    .replace(/\s+HD\s*İzle.*$/i, '')
    .replace(/\s+İzle\s*$/i, '')
    .trim();

  // Bölüm numarası desenleri: "27. Bölüm", "Episode 27", "27.Bolum", "Bölüm 27"
  const epMatch = title.match(/(?:(\d+)\s*\.\s*[Bb]ölüm|[Bb]ölüm\s*(\d+)|[Ee]pisode\s*(\d+))/i);
  if (epMatch) {
    const epNum = epMatch[1] || epMatch[2] || epMatch[3];
    episode = `${epNum}. Bölüm`;
  } else if (pageUrl) {
    const urlEpMatch = pageUrl.match(/(\d+)[-_]?(?:bolum|episode)/i);
    if (urlEpMatch) {
      episode = `${urlEpMatch[1]}. Bölüm`;
    }
  }

  if (!title) {
    if (pageUrl) {
      try {
        const p = new URL(pageUrl).pathname.replace(/^\/|\/$/g, '').split('/').pop();
        title = p ? decodeURIComponent(p).replace(/[-_]+/g, ' ') : safeHost(pageUrl);
      } catch (_) {
        title = 'Video';
      }
    } else {
      title = sourceHost || 'Video';
    }
  }

  let provider = sourceHost || '';
  if (/aincard/i.test(sourceHost) || /aincard/i.test(pageUrl || '')) {
    provider = 'Aincard';
  } else if (sourceHost) {
    provider = sourceHost.replace(/^www\./i, '');
  }

  return {
    title,
    episode,
    provider: provider || 'Web',
    sourceLabel: sourceLabel || (kind ? String(kind).toUpperCase() : 'HLS'),
  };
}

class WatchHistoryStore {
  constructor({ storagePath, maxItems = MAX_HISTORY_ITEMS, onChange, safeStorage, fallbackKey } = {}) {
    this.storagePath = storagePath || null;
    this.maxItems = maxItems;
    this.onChange = onChange || (() => {});
    this.crypto = new HistoryCrypto({ safeStorage, fallbackKey });
    this.items = [];
    this._saveTimer = null;
    this._dirty = false;
    this.load();
  }

  getEncryptionStatus() {
    return this.crypto.getEncryptionStatus();
  }

  load() {
    if (!this.storagePath) {
      this.items = [];
      return;
    }
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        let loaded = [];
        if (Array.isArray(parsed)) {
          loaded = parsed;
        } else if (parsed && Array.isArray(parsed.items)) {
          loaded = parsed.items;
        }

        let needsMigrationSave = false;
        this.items = loaded.map((rawItem) => {
          const item = { ...rawItem };

          // 1. Düz metin mediaUrl (eski v1 formatı) migrasyonu
          if (item.mediaUrl && !item.encMediaUrl) {
            item.encMediaUrl = this.crypto.encrypt(item.mediaUrl);
            item.mediaHost = safeHost(item.mediaUrl);
            item.mediaHash = hashMediaUrl(item.mediaUrl);
            delete item.mediaUrl;
            needsMigrationSave = true;
          }

          // 2. Düz metin headers migrasyonu
          if (item.headers && !item.encHeaders) {
            try {
              item.encHeaders = this.crypto.encrypt(JSON.stringify(item.headers));
            } catch (_) {}
            delete item.headers;
            needsMigrationSave = true;
          }

          // 3. Hassas pageUrl parametreleri kontrolü
          if (item.pageUrl && !item.encPageUrl) {
            const clean = sanitizeDisplayUrl(item.pageUrl);
            if (clean !== item.pageUrl) {
              item.encPageUrl = this.crypto.encrypt(item.pageUrl);
              item.pageUrl = clean;
              needsMigrationSave = true;
            }
          }

          // 4. mediaHash ve mediaHost tamamlama
          if (!item.mediaHash && item.encMediaUrl) {
            const dec = this.crypto.decrypt(item.encMediaUrl);
            if (dec) {
              item.mediaHash = hashMediaUrl(dec);
              if (!item.mediaHost) item.mediaHost = safeHost(dec);
            }
          }

          return item;
        });

        // Eski düz metin kayıtlar tespit edildiyse derhal diske şifreli olarak yeniden yaz
        if (needsMigrationSave) {
          this.saveSync();
        }
      } else {
        this.items = [];
      }
    } catch (_) {
      this.items = [];
    }
  }

  saveSync() {
    if (!this.storagePath) return false;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Diske yazarken ASLA düz metin mediaUrl veya headers bırakılmaz
      const diskItems = this.items.map((i) => {
        const copy = { ...i };
        delete copy.mediaUrl;
        delete copy.headers;
        return copy;
      });

      const data = JSON.stringify({ version: 2, items: diskItems }, null, 2);
      const tmpPath = `${this.storagePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, data, 'utf8');
      fs.renameSync(tmpPath, this.storagePath);
      this._dirty = false;
      return true;
    } catch (_) {
      return false;
    }
  }

  saveDebounced(ms = 800) {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this.saveSync();
    }, ms);
  }

  flush() {
    if (this._dirty || this._saveTimer) {
      this.saveSync();
    }
  }

  _emit() {
    try {
      this.onChange(this.list());
    } catch (_) {}
  }

  /**
   * Renderer sürecine gönderilecek güvenli görünüm.
   * Şifrelenmiş URL'ler, anahtarlar ve başlıklar renderer'a gönderilmez.
   */
  _sanitizeForRenderer(item) {
    return {
      id: item.id,
      pageUrl: sanitizeDisplayUrl(item.pageUrl),
      title: item.title,
      episode: item.episode,
      provider: item.provider,
      sourceLabel: item.sourceLabel,
      kind: item.kind,
      duration: item.duration,
      currentTime: item.currentTime,
      progressPercent: item.progressPercent,
      completed: !!item.completed,
      thumbnail: item.thumbnail || null,
      updatedAt: item.updatedAt,
      hasMedia: !!(item.encMediaUrl || item.mediaUrl),
      mediaHost: item.mediaHost || safeHost(item.pageUrl),
    };
  }

  list({ query = '', filter = 'all', limit = MAX_HISTORY_ITEMS } = {}) {
    let result = [...this.items];

    // Sıralama: En son güncellenen en başta
    result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    // Durum filtresi: tamamlananlar / yarım kalanlar
    if (filter === 'completed') {
      result = result.filter((i) => !!i.completed);
    } else if (filter === 'in_progress') {
      result = result.filter((i) => !i.completed);
    }

    // Arama filtresi: başlık, bölüm veya sağlayıcı içinde arama
    if (query && typeof query === 'string') {
      const q = query.trim().toLowerCase();
      if (q) {
        result = result.filter((i) => {
          const t = (i.title || '').toLowerCase();
          const ep = (i.episode || '').toLowerCase();
          const p = (i.provider || '').toLowerCase();
          const u = (i.pageUrl || '').toLowerCase();
          return t.includes(q) || ep.includes(q) || p.includes(q) || u.includes(q);
        });
      }
    }

    if (limit && Number.isFinite(limit)) {
      result = result.slice(0, limit);
    }

    return result.map((i) => this._sanitizeForRenderer(i));
  }

  /**
   * Ana süreçte gerektiği anda (yalnızca oynatma için) URL ve başlıkları çözer.
   */
  _inflateItem(raw) {
    if (!raw) return null;
    let mediaUrl = '';
    if (raw.encMediaUrl) {
      mediaUrl = this.crypto.decrypt(raw.encMediaUrl);
    } else if (raw.mediaUrl) {
      mediaUrl = raw.mediaUrl;
    }

    let headers = {};
    if (raw.encHeaders) {
      try {
        const dec = this.crypto.decrypt(raw.encHeaders);
        if (dec) headers = JSON.parse(dec);
      } catch (_) {}
    } else if (raw.headers && typeof raw.headers === 'object') {
      headers = { ...raw.headers };
    }

    let pageUrl = raw.pageUrl;
    if (raw.encPageUrl) {
      const decPage = this.crypto.decrypt(raw.encPageUrl);
      if (decPage) pageUrl = decPage;
    }

    return {
      ...raw,
      mediaUrl,
      headers,
      pageUrl,
    };
  }

  get(id) {
    const raw = this.items.find((i) => i.id === id);
    if (!raw) return null;
    return this._inflateItem(raw);
  }

  /**
   * Aynı video veya bölümün mevcut kaydını bulur.
   */
  findExisting({ pageUrl, mediaUrl, title }) {
    if (mediaUrl) {
      const targetHash = hashMediaUrl(mediaUrl);
      if (targetHash) {
        const byHash = this.items.find((i) => i.mediaHash && i.mediaHash === targetHash);
        if (byHash) return byHash;
      }
      const byMedia = this.items.find((i) => i.mediaUrl && i.mediaUrl === mediaUrl);
      if (byMedia) return byMedia;
    }
    if (pageUrl) {
      const cleanPage = sanitizeDisplayUrl(pageUrl);
      const byPage = this.items.find((i) => i.pageUrl && (i.pageUrl === pageUrl || i.pageUrl === cleanPage));
      if (byPage) return byPage;
    }
    if (title) {
      const byTitle = this.items.find((i) => i.title && i.title === title);
      if (byTitle) return byTitle;
    }
    return null;
  }

  upsert(entry) {
    const mediaUrl = entry.mediaUrl || '';
    // blob: adresleri kalıcı olarak saklanamaz
    const safeMediaUrl = mediaUrl.startsWith('blob:') ? '' : mediaUrl;

    const existing = this.findExisting({
      pageUrl: entry.pageUrl,
      mediaUrl: safeMediaUrl,
      title: entry.title,
    });

    const now = Date.now();
    const duration = safeNumber(entry.duration, existing ? existing.duration : null);
    const currentTime = safeNumber(entry.currentTime, existing ? existing.currentTime : 0);

    let progressPercent = null;
    if (duration && duration > 0) {
      progressPercent = Math.min(100, Math.max(0, Math.round((currentTime / duration) * 1000) / 10));
    }

    const completed = entry.completed !== undefined
      ? !!entry.completed
      : (progressPercent !== null && progressPercent >= 90) || (existing ? existing.completed : false);

    // Güvenli başlıklar: Çerez veya auth başlığı ASLA diske düz metin kaydedilmez
    const safeHeaders = {};
    if (entry.headers) {
      if (entry.headers.referer) safeHeaders.referer = entry.headers.referer;
      if (entry.headers.origin) safeHeaders.origin = entry.headers.origin;
      if (entry.headers.userAgent) safeHeaders.userAgent = entry.headers.userAgent;
    } else if (entry.pageUrl) {
      safeHeaders.referer = entry.pageUrl;
    }

    // Şifreleme işlemleri:
    const encMediaUrl = safeMediaUrl
      ? this.crypto.encrypt(safeMediaUrl)
      : (existing ? existing.encMediaUrl : '');

    const encHeaders = Object.keys(safeHeaders).length > 0
      ? this.crypto.encrypt(JSON.stringify(safeHeaders))
      : (existing ? existing.encHeaders : '');

    const mediaHost = safeMediaUrl ? safeHost(safeMediaUrl) : (existing ? existing.mediaHost : '');
    const mediaHash = safeMediaUrl ? hashMediaUrl(safeMediaUrl) : (existing ? existing.mediaHash : '');

    const rawPageUrl = entry.pageUrl || (existing ? (existing.encPageUrl ? this.crypto.decrypt(existing.encPageUrl) : existing.pageUrl) : '');
    const cleanPageUrl = sanitizeDisplayUrl(rawPageUrl);
    const encPageUrl = cleanPageUrl !== rawPageUrl ? this.crypto.encrypt(rawPageUrl) : '';

    const item = {
      id: existing ? existing.id : `hist_${now}_${crypto.randomBytes(4).toString('hex')}`,
      pageUrl: cleanPageUrl,
      title: entry.title || (existing ? existing.title : 'Video'),
      episode: entry.episode !== undefined ? entry.episode : (existing ? existing.episode : null),
      provider: entry.provider || (existing ? existing.provider : 'Web'),
      sourceLabel: entry.sourceLabel || (existing ? existing.sourceLabel : 'HLS'),
      kind: entry.kind || (existing ? existing.kind : 'hls'),
      duration: duration,
      currentTime: currentTime,
      progressPercent: progressPercent,
      completed: !!completed,
      thumbnail: entry.thumbnail || (existing ? existing.thumbnail : null),
      updatedAt: now,
      encMediaUrl: encMediaUrl || '',
      encHeaders: encHeaders || '',
      encPageUrl: encPageUrl || (existing ? existing.encPageUrl || '' : ''),
      mediaHost: mediaHost || '',
      mediaHash: mediaHash || '',
    };

    if (existing) {
      const idx = this.items.indexOf(existing);
      this.items[idx] = item;
    } else {
      this.items.unshift(item);
      if (this.items.length > this.maxItems) {
        this.items.length = this.maxItems;
      }
    }

    this.saveDebounced();
    this._emit();
    return this._inflateItem(item);
  }

  updateProgress({ id, currentTime, duration, completed }) {
    const raw = this.items.find((i) => i.id === id);
    if (!raw) return null;

    const cur = safeNumber(currentTime, raw.currentTime);
    const dur = safeNumber(duration, raw.duration);

    raw.currentTime = cur !== null ? cur : raw.currentTime;
    if (dur !== null && dur > 0) {
      raw.duration = dur;
      raw.progressPercent = Math.min(100, Math.max(0, Math.round((raw.currentTime / dur) * 1000) / 10));
    }

    if (completed !== undefined) {
      raw.completed = !!completed;
    } else if (raw.progressPercent !== null && raw.progressPercent >= 90) {
      raw.completed = true;
    }

    raw.updatedAt = Date.now();
    this.saveDebounced(1000);
    this._emit();
    return this._inflateItem(raw);
  }

  delete(id) {
    const prevLen = this.items.length;
    this.items = this.items.filter((i) => i.id !== id);
    if (this.items.length !== prevLen) {
      this.saveSync();
      this._emit();
      return true;
    }
    return false;
  }

  clear() {
    this.items = [];
    this.saveSync();
    this._emit();
    return true;
  }

  destroy() {
    this.flush();
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
  }
}

module.exports = {
  WatchHistoryStore,
  HistoryCrypto,
  extractMediaMetadata,
  safeNumber,
  safeHost,
  hashMediaUrl,
  sanitizeDisplayUrl,
};
