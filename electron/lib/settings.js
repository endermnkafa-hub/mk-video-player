'use strict';
/**
 * MK VideoPlayer - Kalıcı Ayarlar ve Pencere Durumu Deposu (SettingsStore)
 *
 * - Pencere boyutu, konumu (x, y) ve tam ekran/büyütülmüş (isMaximized) durumu saklanır.
 * - Çoklu monitör veya bağlantı kopması durumunda pencerenin ekran dışı kalması engellenir.
 * - Varsayılan video kalitesi tercihi ('highest', 'auto', 'lowest'), oynatma hızı,
 *   atlama süresi, ses seviyesi ve başlangıç yerleşimi gibi kullanıcı tercihleri saklanır.
 * - Ayarlar atomik dosya yazımıyla (tmp + rename) JSON olarak diske kaydedilir.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { selectLevelByPreference } = require('../../frontend/js/classify.js');

const DEFAULT_SETTINGS = {
  // Video oynatıcı tercihleri
  defaultQuality: 'auto',       // 'auto' | 'highest' | 'lowest'
  defaultSpeed: 1.0,            // 0.75, 1.0, 1.25, 1.5, 1.75, 2.0
  seekStep: 10,                 // 5, 10, 15, 30 (saniye)
  autoplay: true,               // true | false (kaynak açıldığında otomatik oynat)
  rememberVolume: true,         // true | false (son ses seviyesini hatırla)
  lastVolume: 1.0,              // 0.0 - 1.0
  lastMuted: false,             // true | false
  audioBoost: 100,              // 100 - 300 (% ses yükseltme)
  introSkipSeconds: 85,         // introyu atlama süresi (sn)
  outroSkipSeconds: 85,         // outroyu atlama süresi (sn)
  smartIntroDetection: true,    // AniSkip ve yerel parmak izi ile akıllı intro tespiti
  autoSkipIntro: false,         // introyu otomatik atla
  autoNextEpisode: true,        // video bitince otomatik sonraki bölüme geç
  bufferMode: 'balanced',       // 'normal' | 'balanced' | 'aggressive' (Smart Buffer)
  restoreLastPage: true,        // true | false (son açık olan web sayfasını geri yükle)
  lastPageUrl: '',              // son açılan geçerli sayfa adresi

  // Pencere & Görünüm tercihleri
  rememberWindowBounds: true,   // true | false
  windowBounds: {
    width: 1500,
    height: 900,
    x: null,
    y: null,
    isMaximized: false,
  },
  defaultLayout: 'split',       // 'split' (ikili mod) | 'player' (yalnızca oynatıcı)
};

/**
 * Kaydedilen pencere sınırlarının (bounds) geçerli ve ekran içinde olduğunu doğrular.
 * Çoklu monitör ayrıldığında pencerenin görünmez alanda kalmasını engeller.
 */
function validateBounds(bounds, displays = null) {
  if (!bounds || typeof bounds !== 'object') {
    return { ...DEFAULT_SETTINGS.windowBounds };
  }

  const minW = 1000;
  const minH = 640;
  let w = Number.isFinite(bounds.width) && bounds.width >= minW ? Math.round(bounds.width) : DEFAULT_SETTINGS.windowBounds.width;
  let h = Number.isFinite(bounds.height) && bounds.height >= minH ? Math.round(bounds.height) : DEFAULT_SETTINGS.windowBounds.height;
  const isMaximized = !!bounds.isMaximized;

  let x = Number.isFinite(bounds.x) ? Math.round(bounds.x) : null;
  let y = Number.isFinite(bounds.y) ? Math.round(bounds.y) : null;

  // Ekran listesi verildiyse görünürlük ve boyut testi yap
  if (displays && Array.isArray(displays) && displays.length > 0) {
    let maxWorkW = 0;
    let maxWorkH = 0;
    for (const d of displays) {
      const area = (d && d.workArea) || (d && d.bounds);
      if (area) {
        if (area.width > maxWorkW) maxWorkW = area.width;
        if (area.height > maxWorkH) maxWorkH = area.height;
      }
    }
    if (maxWorkW > 0 && w > maxWorkW) w = Math.max(minW, maxWorkW);
    if (maxWorkH > 0 && h > maxWorkH) h = Math.max(minH, maxWorkH);

    if (x !== null && y !== null) {
      // 2D AABB kesişim testi: pencerenin en az 100x100 piksellik bir kısmının
      // geçerli bir ekran çalışma alanında olması gerekir
      const isVisible = displays.some((d) => {
        const area = (d && d.workArea) || (d && d.bounds);
        if (!area) return false;
        const interW = Math.min(x + w, area.x + area.width) - Math.max(x, area.x);
        const interH = Math.min(y + h, area.y + area.height) - Math.max(y, area.y);
        return interW >= 100 && interH >= 100;
      });

      if (!isVisible) {
        // Ekran dışı kaldıysa merkezde açılması için konumu sıfırla
        x = null;
        y = null;
      }
    }
  }

  return {
    width: w,
    height: h,
    x,
    y,
    isMaximized,
  };
}

class SettingsStore {
  constructor({ storagePath, onChange } = {}) {
    this.storagePath = storagePath || null;
    this.onChange = onChange || (() => {});
    this.settings = { ...DEFAULT_SETTINGS };
    this._saveTimer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    if (!this.storagePath) return;
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.settings = this._sanitizeMerge(parsed);
        }
      }
    } catch (_) {
      // Bozuk dosya durumunda varsayılanları koru
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  _sanitizeMerge(incoming) {
    const s = { ...DEFAULT_SETTINGS, ...incoming };

    // Kalite tercihi doğrulaması
    const validQualities = ['auto', 'highest', 'lowest', '1080', '720', '480', '360', '180'];
    if (!validQualities.includes(String(s.defaultQuality).toLowerCase())) {
      s.defaultQuality = 'auto';
    } else {
      s.defaultQuality = String(s.defaultQuality).toLowerCase();
    }

    // Oynatma hızı doğrulaması
    const numSpeed = Number(s.defaultSpeed);
    s.defaultSpeed = Number.isFinite(numSpeed) && numSpeed >= 0.25 && numSpeed <= 4.0 ? numSpeed : 1.0;

    // Atlama süresi doğrulaması
    const numStep = Number(s.seekStep);
    s.seekStep = Number.isFinite(numStep) && numStep > 0 && numStep <= 120 ? Math.round(numStep) : 10;

    // Boolean alanlar
    s.autoplay = s.autoplay !== undefined ? !!s.autoplay : true;
    s.rememberVolume = s.rememberVolume !== undefined ? !!s.rememberVolume : true;
    s.rememberWindowBounds = s.rememberWindowBounds !== undefined ? !!s.rememberWindowBounds : true;
    s.restoreLastPage = s.restoreLastPage !== undefined ? !!s.restoreLastPage : true;
    s.lastPageUrl = typeof s.lastPageUrl === 'string' ? s.lastPageUrl : '';

    // Ses ve sessiz durumu
    const numVol = Number(s.lastVolume);
    s.lastVolume = Number.isFinite(numVol) && numVol >= 0 && numVol <= 1 ? numVol : 1.0;
    s.lastMuted = !!s.lastMuted;

    // Ses yükseltici (%100 - %300)
    const numBoost = Number(s.audioBoost);
    s.audioBoost = Number.isFinite(numBoost) && numBoost >= 100 && numBoost <= 300 ? Math.round(numBoost) : 100;

    // İntro / Outro atlama süreleri ve akıllı algılama
    const numIntro = Number(s.introSkipSeconds);
    s.introSkipSeconds = Number.isFinite(numIntro) && numIntro > 0 && numIntro <= 300 ? Math.round(numIntro) : 85;
    const numOutro = Number(s.outroSkipSeconds);
    s.outroSkipSeconds = Number.isFinite(numOutro) && numOutro > 0 && numOutro <= 300 ? Math.round(numOutro) : 85;
    s.smartIntroDetection = s.smartIntroDetection !== undefined ? !!s.smartIntroDetection : true;
    s.autoSkipIntro = s.autoSkipIntro !== undefined ? !!s.autoSkipIntro : false;

    // Otomatik sonraki bölüm
    s.autoNextEpisode = s.autoNextEpisode !== undefined ? !!s.autoNextEpisode : true;

    // Tamponlama modu (Smart Buffer)
    const validBufferModes = ['normal', 'balanced', 'aggressive'];
    s.bufferMode = validBufferModes.includes(s.bufferMode) ? s.bufferMode : 'balanced';

    // Düzen tercihi
    s.defaultLayout = ['player', 'discover'].includes(s.defaultLayout) ? s.defaultLayout : 'split';

    // Pencere sınırları
    s.windowBounds = validateBounds(incoming.windowBounds);

    return s;
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
      const data = JSON.stringify(this.settings, null, 2);
      const tmpPath = `${this.storagePath}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmpPath, data, 'utf8');
      fs.renameSync(tmpPath, this.storagePath);
      this._dirty = false;
      return true;
    } catch (_) {
      return false;
    }
  }

  saveDebounced(ms = 600) {
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

  get(key) {
    return this.settings[key];
  }

  getAll() {
    return { ...this.settings, windowBounds: { ...this.settings.windowBounds } };
  }

  update(partial, immediate = false, notifyRenderer = true) {
    if (!partial || typeof partial !== 'object') return this.getAll();
    this.settings = this._sanitizeMerge({
      ...this.settings,
      ...partial,
      windowBounds: partial.windowBounds
        ? { ...this.settings.windowBounds, ...partial.windowBounds }
        : this.settings.windowBounds,
    });

    // Pencere boyutu dışındaki kullanıcı tercihleri anında diske kaydedilir
    if (immediate || !partial.windowBounds || Object.keys(partial).some((k) => k !== 'windowBounds')) {
      this.saveSync();
    } else {
      this.saveDebounced();
    }
    if (notifyRenderer) {
      try {
        this.onChange(this.getAll());
      } catch (_) {}
    }
    return this.getAll();
  }

  reset() {
    this.settings = { ...DEFAULT_SETTINGS, windowBounds: { ...DEFAULT_SETTINGS.windowBounds } };
    this.saveSync();
    try {
      this.onChange(this.getAll());
    } catch (_) {}
    return this.getAll();
  }

  destroy() {
    this.flush();
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
  }
}

module.exports = {
  SettingsStore,
  DEFAULT_SETTINGS,
  selectLevelByPreference,
  validateBounds,
};
