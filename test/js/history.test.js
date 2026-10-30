'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WatchHistoryStore, extractMediaMetadata, safeNumber } = require('../../electron/lib/history.js');

test('extractMediaMetadata sayfa başlığı ve URL den anime ve bölüm bilgisini ayıklar', () => {
  const m1 = extractMediaMetadata({
    pageTitle: 'Dragon Ball 27. Bölüm Türkçe Altyazılı İzle - Anizm',
    pageUrl: 'https://anizm.net/dragon-ball-27-bolum-izle',
    sourceHost: 'video.aincard.net',
    kind: 'hls',
  });
  assert.equal(m1.title, 'Dragon Ball 27. Bölüm');
  assert.equal(m1.episode, '27. Bölüm');
  assert.equal(m1.provider, 'Aincard');
  assert.equal(m1.sourceLabel, 'HLS');

  const m2 = extractMediaMetadata({
    pageTitle: 'Naruto Shippuuden Episode 150 HD İzle',
    pageUrl: 'https://site.example/naruto/150',
    sourceHost: 'stream.example.com',
    kind: 'mp4',
    sourceLabel: '1080p',
  });
  assert.equal(m2.title, 'Naruto Shippuuden Episode 150');
  assert.equal(m2.episode, '150. Bölüm');
  assert.equal(m2.provider, 'stream.example.com');
  assert.equal(m2.sourceLabel, '1080p');
});

test('safeNumber geçersiz, NaN veya sonsuz değerleri eler', () => {
  assert.equal(safeNumber(12.5), 12.5);
  assert.equal(safeNumber('42'), 42);
  assert.equal(safeNumber(NaN), null);
  assert.equal(safeNumber(Infinity), null);
  assert.equal(safeNumber(-5), null);
  assert.equal(safeNumber(undefined, 0), 0);
});

test('WatchHistoryStore disk kaydı, yükleme ve kalıcılık', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-hist-test-'));
  const filePath = path.join(tmpDir, 'history.json');

  const store1 = new WatchHistoryStore({ storagePath: filePath });
  assert.equal(store1.list().length, 0);

  const entry = store1.upsert({
    pageUrl: 'https://anizm.net/anime-1',
    mediaUrl: 'https://video.example.com/master.m3u8',
    title: 'Anime 1. Bölüm',
    episode: '1. Bölüm',
    provider: 'Aincard',
    kind: 'hls',
    duration: 1200,
    currentTime: 300,
  });

  assert.ok(entry.id);
  assert.equal(entry.progressPercent, 25);
  assert.equal(entry.completed, false);

  // Diske yazmayı tamamla
  store1.saveSync();
  assert.ok(fs.existsSync(filePath));

  // Yeni bir store örneği açıp diskten okumayı doğrula (uygulama yeniden başlatma simülasyonu)
  const store2 = new WatchHistoryStore({ storagePath: filePath });
  const items = store2.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, entry.id);
  assert.equal(items[0].currentTime, 300);
  assert.equal(items[0].duration, 1200);
  assert.equal(items[0].progressPercent, 25);
  assert.equal(items[0].title, 'Anime 1. Bölüm');

  // Temizlik
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Aynı video için mükerrer kayıt oluşturulmaz, mevcut kayıt güncellenir', () => {
  const store = new WatchHistoryStore();
  const item1 = store.upsert({
    pageUrl: 'https://anizm.net/ep-5',
    mediaUrl: 'https://video.example.com/ep5.m3u8',
    title: 'Ep 5',
    currentTime: 60,
    duration: 1000,
  });

  assert.equal(store.list().length, 1);

  // Aynı sayfa ve medyadan tekrar izleme
  const item2 = store.upsert({
    pageUrl: 'https://anizm.net/ep-5',
    mediaUrl: 'https://video.example.com/ep5.m3u8',
    title: 'Ep 5',
    currentTime: 120,
    duration: 1000,
  });

  assert.equal(store.list().length, 1);
  assert.equal(item1.id, item2.id);
  assert.equal(store.list()[0].currentTime, 120);
});

test('İlerleme güncellemesi ve tamamlanma işareti', () => {
  const store = new WatchHistoryStore();
  const item = store.upsert({
    pageUrl: 'https://example.com/ep1',
    mediaUrl: 'https://example.com/ep1.mp4',
    title: 'Film',
    duration: 100,
    currentTime: 10,
  });

  assert.equal(item.progressPercent, 10);
  assert.equal(item.completed, false);

  // Süre %95 e ulaştığında otomatik tamamlandı olarak işaretlenir
  store.updateProgress({ id: item.id, currentTime: 95, duration: 100 });
  const updated = store.get(item.id);
  assert.equal(updated.progressPercent, 95);
  assert.equal(updated.completed, true);

  // Süre bilinmiyorsa (canlı akış) NaN yüzde üretilmez
  store.updateProgress({ id: item.id, currentTime: 150, duration: null });
  const liveItem = store.get(item.id);
  assert.equal(liveItem.currentTime, 150);
});

test('Geçmişte arama ve durum filtresi', () => {
  const store = new WatchHistoryStore();
  store.upsert({ pageUrl: 'https://a.com/1', title: 'Dragon Ball 1. Bölüm', episode: '1. Bölüm', completed: true });
  store.upsert({ pageUrl: 'https://a.com/2', title: 'Dragon Ball 2. Bölüm', episode: '2. Bölüm', completed: false });
  store.upsert({ pageUrl: 'https://a.com/3', title: 'Naruto 1. Bölüm', episode: '1. Bölüm', completed: false });

  assert.equal(store.list({ query: 'Dragon' }).length, 2);
  assert.equal(store.list({ query: 'Naruto' }).length, 1);
  assert.equal(store.list({ filter: 'completed' }).length, 1);
  assert.equal(store.list({ filter: 'in_progress' }).length, 2);
  assert.equal(store.list({ query: 'Dragon', filter: 'in_progress' }).length, 1);
});

test('Tekil kayıt silme ve tüm geçmişi temizleme', () => {
  const store = new WatchHistoryStore();
  const i1 = store.upsert({ pageUrl: 'https://a.com/1', title: 'A' });
  const i2 = store.upsert({ pageUrl: 'https://a.com/2', title: 'B' });
  assert.equal(store.list().length, 2);

  assert.equal(store.delete(i1.id), true);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].id, i2.id);

  store.clear();
  assert.equal(store.list().length, 0);
});

test('Geçmiş dosyasında örnek hassas tokenlar düz metin olarak saklanmaz (şifreli)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-hist-crypto-'));
  const filePath = path.join(tmpDir, 'history_crypto.json');

  const store = new WatchHistoryStore({ storagePath: filePath });
  const entry = store.upsert({
    pageUrl: 'https://anizm.net/anime-secure-ep1?auth_token=PAGE_TOKEN_SECRET_999',
    mediaUrl: 'https://cdn.example.com/hls/master.m3u8?token=SUPER_SECRET_TOKEN_12345&sig=HEXSIG987654',
    title: 'Güvenli Video',
    headers: {
      referer: 'https://anizm.net/anime-secure-ep1?player_token=REF_TOKEN_SECRET_777',
      origin: 'https://anizm.net',
    },
    duration: 1500,
    currentTime: 450,
  });

  store.saveSync();
  assert.ok(fs.existsSync(filePath));

  // Disk dosyasının ham metnini oku: tokenlar ve tam medya URL'si düz metin görünmemeli!
  const rawDisk = fs.readFileSync(filePath, 'utf8');
  assert.equal(rawDisk.includes('SUPER_SECRET_TOKEN_12345'), false, 'medya tokenı diskte düz metin olmamalı');
  assert.equal(rawDisk.includes('HEXSIG987654'), false, 'imza parametresi diskte düz metin olmamalı');
  assert.equal(rawDisk.includes('REF_TOKEN_SECRET_777'), false, 'referer tokenı diskte düz metin olmamalı');
  assert.equal(rawDisk.includes('PAGE_TOKEN_SECRET_999'), false, 'sayfa adresi tokenı diskte düz metin olmamalı');
  assert.equal(rawDisk.includes('master.m3u8'), false, 'medya URL yolu diskte düz metin olmamalı');
  assert.ok(rawDisk.includes('enc:'), 'şifreli etiket bulunmalı');

  // Yeniden başlatma: Yeni store örneği diskteki şifreli kaydı çözebilmeli
  const store2 = new WatchHistoryStore({ storagePath: filePath });
  assert.equal(store2.list().length, 1);
  const inflated = store2.get(entry.id);
  assert.ok(inflated);
  assert.equal(inflated.mediaUrl, 'https://cdn.example.com/hls/master.m3u8?token=SUPER_SECRET_TOKEN_12345&sig=HEXSIG987654');
  assert.equal(inflated.headers.referer, 'https://anizm.net/anime-secure-ep1?player_token=REF_TOKEN_SECRET_777');
  assert.equal(inflated.currentTime, 450);
  assert.equal(inflated.duration, 1500);

  // İlerleme güncellemesi ve kalıcılığı
  store2.updateProgress({ id: entry.id, currentTime: 750, duration: 1500 });
  store2.saveSync();

  const store3 = new WatchHistoryStore({ storagePath: filePath });
  assert.equal(store3.get(entry.id).currentTime, 750);
  assert.equal(store3.list()[0].progressPercent, 50);

  // Temizlik
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Eski düz metin (v1) kayıtlar güvenli şekilde şifreli v2 biçimine dönüştürülür (migrasyon)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-hist-mig-'));
  const filePath = path.join(tmpDir, 'history_legacy.json');

  // Eski sürüm düz metin dosyası oluştur
  const legacyData = {
    version: 1,
    items: [
      {
        id: 'legacy_hist_99',
        pageUrl: 'https://site.example/ep5?auth=OLD_PAGE_TOKEN',
        title: 'Eski Kayıt Anime',
        episode: '5. Bölüm',
        provider: 'Aincard',
        kind: 'hls',
        mediaUrl: 'https://video.aincard.net/old_master.m3u8?token=OLD_LEGACY_SECRET_888',
        headers: {
          referer: 'https://site.example/ep5?auth=OLD_REF_TOKEN',
        },
        duration: 1200,
        currentTime: 400,
        progressPercent: 33.3,
        completed: false,
        updatedAt: 1729000000000,
      },
    ],
  };
  fs.writeFileSync(filePath, JSON.stringify(legacyData, null, 2), 'utf8');

  // WatchHistoryStore açıldığında eski kayıtları tespit edip otomatik şifrelemeli
  const store = new WatchHistoryStore({ storagePath: filePath });
  assert.equal(store.list().length, 1);

  // Oynatma için çözülen veri eksiksiz olmalı
  const item = store.get('legacy_hist_99');
  assert.ok(item);
  assert.equal(item.title, 'Eski Kayıt Anime');
  assert.equal(item.episode, '5. Bölüm');
  assert.equal(item.currentTime, 400);
  assert.equal(item.duration, 1200);
  assert.equal(item.mediaUrl, 'https://video.aincard.net/old_master.m3u8?token=OLD_LEGACY_SECRET_888');
  assert.equal(item.headers.referer, 'https://site.example/ep5?auth=OLD_REF_TOKEN');

  // Diskteki dosya kontrolü: Eski düz metin tokenlar artık diskte OLMAMALI
  const migratedRaw = fs.readFileSync(filePath, 'utf8');
  assert.equal(migratedRaw.includes('OLD_LEGACY_SECRET_888'), false, 'eski medya tokenı diskten temizlenmiş olmalı');
  assert.equal(migratedRaw.includes('OLD_REF_TOKEN'), false, 'eski referer tokenı diskten temizlenmiş olmalı');
  assert.equal(migratedRaw.includes('OLD_PAGE_TOKEN'), false, 'eski sayfa tokenı diskten temizlenmiş olmalı');
  assert.ok(migratedRaw.includes('"version": 2'), 'sürüm 2 ye yükseltilmiş olmalı');
  assert.ok(migratedRaw.includes('enc:'), 'şifreli içerik yazılmış olmalı');

  // Temizlik
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('Electron safeStorage API ve güvenli AES alternatifi ile uyumluluk', () => {
  // 1. Mock Electron safeStorage
  const mockSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from('mock_safe_enc:' + plain, 'utf8'),
    decryptString: (buf) => buf.toString('utf8').replace(/^mock_safe_enc:/, ''),
  };

  const storeSafe = new WatchHistoryStore({ safeStorage: mockSafeStorage });
  const statusSafe = storeSafe.getEncryptionStatus();
  assert.equal(statusSafe.available, true);
  assert.equal(statusSafe.mode, 'safeStorage');

  const item1 = storeSafe.upsert({
    pageUrl: 'https://site.example/test',
    mediaUrl: 'https://cdn.example/safe.m3u8?token=SAFE_TEST_TOKEN',
    title: 'SafeStorage Test',
  });
  assert.ok(storeSafe.crypto.isEncrypted(storeSafe.items[0].encMediaUrl));
  assert.ok(storeSafe.items[0].encMediaUrl.startsWith('enc:safe:'));
  assert.equal(storeSafe.get(item1.id).mediaUrl, 'https://cdn.example/safe.m3u8?token=SAFE_TEST_TOKEN');

  // 2. safeStorage kullanılamadığında güvenli AES-256-GCM alternatifi
  const mockNoSafeStorage = {
    isEncryptionAvailable: () => false,
  };
  const storeAes = new WatchHistoryStore({ safeStorage: mockNoSafeStorage });
  const statusAes = storeAes.getEncryptionStatus();
  assert.equal(statusAes.available, true);
  assert.equal(statusAes.mode, 'aes_fallback');
  assert.ok(statusAes.warning.includes('AES-256-GCM'));

  const item2 = storeAes.upsert({
    pageUrl: 'https://site.example/test2',
    mediaUrl: 'https://cdn.example/aes.m3u8?token=AES_TEST_TOKEN',
    title: 'AES Test',
  });
  assert.ok(storeAes.items[0].encMediaUrl.startsWith('enc:aes:'));
  assert.equal(storeAes.get(item2.id).mediaUrl, 'https://cdn.example/aes.m3u8?token=AES_TEST_TOKEN');
});

test('Renderer arayüzüne giden görünümde (list) hassas URL ve başlıklar bulunmaz', () => {
  const store = new WatchHistoryStore();
  store.upsert({
    pageUrl: 'https://anizm.net/ep-secret?sig=SENSITIVE_SIG',
    mediaUrl: 'https://video.secret.com/stream.m3u8?token=SUPER_SECRET_TOKEN',
    headers: { referer: 'https://anizm.net/ep-secret?auth=AUTH_SECRET' },
    title: 'Gizli Bölüm',
  });

  const list = store.list();
  assert.equal(list.length, 1);
  const card = list[0];
  assert.equal(card.mediaUrl, undefined, 'mediaUrl arayüze sızmamalı');
  assert.equal(card.encMediaUrl, undefined, 'encMediaUrl arayüze sızmamalı');
  assert.equal(card.headers, undefined, 'headers arayüze sızmamalı');
  assert.equal(card.encHeaders, undefined, 'encHeaders arayüze sızmamalı');
  assert.equal(card.hasMedia, true, 'hasMedia bayrağı mevcut olmalı');
  assert.equal(card.mediaHost, 'video.secret.com', 'yalnızca ana bilgisayar adı görünmeli');
  assert.equal(card.pageUrl.includes('SENSITIVE_SIG'), false, 'pageUrl hassas tokenları arayüze sızmamalı');
});

