'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  SettingsStore,
  DEFAULT_SETTINGS,
  selectLevelByPreference,
  validateBounds,
} = require('../../electron/lib/settings.js');

test('SettingsStore varsayılan ayarları yükler ve diske kaydeder', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-settings-test-'));
  const filePath = path.join(tmpDir, 'settings.json');

  const store1 = new SettingsStore({ storagePath: filePath });
  const all = store1.getAll();

  assert.equal(all.defaultQuality, 'auto');
  assert.equal(all.defaultSpeed, 1.0);
  assert.equal(all.seekStep, 10);
  assert.equal(all.autoplay, true);
  assert.equal(all.rememberVolume, true);
  assert.equal(all.rememberWindowBounds, true);
  assert.equal(all.restoreLastPage, true);
  assert.equal(all.lastPageUrl, '');
  assert.equal(all.audioBoost, 100);
  assert.equal(all.introSkipSeconds, 85);
  assert.equal(all.outroSkipSeconds, 85);
  assert.equal(all.autoNextEpisode, true);
  assert.equal(all.bufferMode, 'balanced');
  assert.equal(all.windowBounds.width, 1500);
  assert.equal(all.windowBounds.height, 900);
  assert.equal(all.windowBounds.isMaximized, false);

  // Güncelleme ve kaydetme
  store1.update({
    defaultQuality: 'highest',
    defaultSpeed: 1.5,
    seekStep: 15,
    defaultLayout: 'player',
    restoreLastPage: true,
    lastPageUrl: 'https://example.com/anime/ep1',
    windowBounds: {
      width: 1280,
      height: 720,
      x: 100,
      y: 150,
      isMaximized: true,
    },
  });
  store1.saveSync();
  assert.ok(fs.existsSync(filePath));

  // Yeni store örneği açıp diskten okumayı doğrula (uygulama yeniden başlatma simülasyonu)
  const store2 = new SettingsStore({ storagePath: filePath });
  const loaded = store2.getAll();

  assert.equal(loaded.defaultQuality, 'highest');
  assert.equal(loaded.defaultSpeed, 1.5);
  assert.equal(loaded.seekStep, 15);
  assert.equal(loaded.defaultLayout, 'player');
  assert.equal(loaded.restoreLastPage, true);
  assert.equal(loaded.lastPageUrl, 'https://example.com/anime/ep1');
  assert.equal(loaded.windowBounds.width, 1280);
  assert.equal(loaded.windowBounds.height, 720);
  assert.equal(loaded.windowBounds.x, 100);
  assert.equal(loaded.windowBounds.y, 150);
  assert.equal(loaded.windowBounds.isMaximized, true);

  // Sıfırlama
  store2.reset();
  const resetAll = store2.getAll();
  assert.equal(resetAll.defaultQuality, 'auto');
  assert.equal(resetAll.defaultSpeed, 1.0);
  assert.equal(resetAll.seekStep, 10);
  assert.equal(resetAll.defaultLayout, 'split');

  // Temizlik
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('selectLevelByPreference HLS kalite seviyelerini tercihe göre seçer', () => {
  const levels = [
    { index: 0, height: 180, bitrate: 200000 },
    { index: 1, height: 360, bitrate: 600000 },
    { index: 2, height: 720, bitrate: 1800000 },
    { index: 3, height: 1080, bitrate: 4500000 },
  ];

  // En yüksek kalite
  assert.equal(selectLevelByPreference(levels, 'highest'), 3);
  assert.equal(selectLevelByPreference(levels, 'max'), 3);

  // En düşük kalite
  assert.equal(selectLevelByPreference(levels, 'lowest'), 0);
  assert.equal(selectLevelByPreference(levels, 'min'), 0);

  // Otomatik
  assert.equal(selectLevelByPreference(levels, 'auto'), -1);
  assert.equal(selectLevelByPreference(levels, '-1'), -1);
  assert.equal(selectLevelByPreference(levels, null), -1);

  // Belirli çözünürlük veya doğrudan seviye indeksi
  assert.equal(selectLevelByPreference(levels, '720'), 2);
  assert.equal(selectLevelByPreference(levels, '360'), 1);
  assert.equal(selectLevelByPreference(levels, '0'), 0);
  assert.equal(selectLevelByPreference(levels, '1'), 1);
  assert.equal(selectLevelByPreference(levels, '480'), -1); // listede yoksa otomatik

  // Boş liste
  assert.equal(selectLevelByPreference([], 'highest'), -1);
  assert.equal(selectLevelByPreference(null, 'highest'), -1);
});

test('validateBounds pencere boyutlarını ve ekran görünürlüğünü sınırlar', () => {
  // Min genişlik (1000) ve min yükseklik (640) koruması
  const tooSmall = validateBounds({ width: 500, height: 300, x: 50, y: 50 });
  assert.equal(tooSmall.width, 1500); // varsayılan
  assert.equal(tooSmall.height, 900); // varsayılan
  assert.equal(tooSmall.x, 50);
  assert.equal(tooSmall.y, 50);

  // Geçerli boyut
  const valid = validateBounds({ width: 1200, height: 800, x: 200, y: 100, isMaximized: false });
  assert.equal(valid.width, 1200);
  assert.equal(valid.height, 800);
  assert.equal(valid.x, 200);
  assert.equal(valid.y, 100);

  // Ekran dışı kontrolü
  const mockDisplays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  ];

  // Ekran içinde
  const inside = validateBounds({ width: 1200, height: 800, x: 100, y: 100 }, mockDisplays);
  assert.equal(inside.x, 100);
  assert.equal(inside.y, 100);

  // Ekranın tamamen dışında (ikinci monitör bağlantısı kesilmiş)
  const outside = validateBounds({ width: 1200, height: 800, x: 3500, y: 2500 }, mockDisplays);
  assert.equal(outside.x, null);
  assert.equal(outside.y, null);
});
