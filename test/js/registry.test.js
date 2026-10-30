const test = require('node:test');
const assert = require('node:assert/strict');
const { SourceRegistry } = require('../../electron/lib/registry.js');
const C = require('../../frontend/js/classify.js');
const { analyzeManifest } = require('../../electron/lib/m3u8.js');

const cls = (url, extra = {}) => C.classifyResponse({ url, statusCode: 200, resourceType: 'xhr', ...extra });

function request(reg, id, url, extra) {
  const token = reg.beginRequest(id);
  return reg.offer({ url, classification: cls(url, extra), token, requestHeaders: { referer: 'https://page.example.com/', cookieLike: 'x' } });
}

test('algılama kapalıyken hiçbir şey listelenmez', () => {
  const reg = new SourceRegistry();
  reg.resetForNavigation('https://page.example.com/ep1');
  reg.noteInteraction();
  assert.equal(request(reg, 1, 'https://c.example.com/a.m3u8').status, 'ignored_not_armed');
  assert.equal(reg.list().length, 0);
});

test('kullanıcı seçim yapmadan gelen medya istekleri (otomatik yükleme/reklam) listelenmez', () => {
  const reg = new SourceRegistry();
  reg.start();
  reg.resetForNavigation('https://page.example.com/ep1');
  assert.equal(request(reg, 1, 'https://c.example.com/preload.m3u8').status, 'ignored_before_selection');
  assert.equal(reg.list().length, 0);
  reg.noteInteraction();
  assert.equal(request(reg, 2, 'https://c.example.com/chosen.m3u8').status, 'added');
  assert.equal(reg.list().length, 1);
});

test('seçimden ÖNCE başlayıp SONRA yanıtlanan istek kabul edilmez', () => {
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/');
  const token = reg.beginRequest(1);
  reg.noteInteraction();
  const r = reg.offer({ url: 'https://c.example.com/late.m3u8', classification: cls('https://c.example.com/late.m3u8'), token });
  assert.equal(r.status, 'ignored_before_selection');
});

test('birden çok kaynak varsa hiçbiri otomatik seçilmez; hepsi listelenir', () => {
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/'); reg.noteInteraction();
  request(reg, 1, 'https://a.example.com/one.m3u8');
  request(reg, 2, 'https://b.example.com/two.mp4?token=1', { resourceType: 'media' });
  request(reg, 3, 'https://b.example.com/two.mp4?token=1', { resourceType: 'media' }); // aynı URL tekrarı
  const list = reg.list();
  assert.equal(list.length, 2);
  assert.ok(list.every((s) => s.playability === 'unknown'));
  assert.equal(reg.snapshot().activeId, undefined); // kayıt defteri aktif kaynak tutmaz
});

test('yeni bölüme geçilince önceki kaynaklar silinir, eski id geçersiz olur', () => {
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/ep1'); reg.noteInteraction();
  const added = request(reg, 1, 'https://a.example.com/ep1.m3u8').source;
  assert.ok(reg.get(added.id));
  reg.resetForNavigation('https://p.example.com/ep2');
  assert.equal(reg.list().length, 0);
  assert.equal(reg.get(added.id), null);
  assert.equal(reg.snapshot().interacted, false);
  // eski sayfadan gecikmeli gelen yanıt
  const oldToken = { epoch: added.epoch, interacted: true };
  assert.equal(reg.offer({ url: 'https://a.example.com/ep1.m3u8', classification: cls('https://a.example.com/ep1.m3u8'), token: oldToken }).status, 'ignored_stale_page');
  reg.noteInteraction();
  assert.equal(request(reg, 2, 'https://a.example.com/ep2.m3u8').status, 'added');
  assert.deepEqual(reg.list().map((s) => s.url), ['https://a.example.com/ep2.m3u8']);
});

test('master manifest alt oynatma listelerini gizler (sıra fark etmez)', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\nv720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=640x360\nv360.m3u8\n';
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/'); reg.noteInteraction();
  const m = request(reg, 1, 'https://c.example.com/hls/master.m3u8').source;
  request(reg, 2, 'https://c.example.com/hls/v720.m3u8');
  reg.attachAnalysis(m.id, analyzeManifest(master, m.url));
  request(reg, 3, 'https://c.example.com/hls/v360.m3u8'); // analizden sonra gelen
  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, m.id);
  assert.equal(list[0].availability, 'verified');
  assert.equal(list[0].maxHeight, 720);
});

test('DRM manifest desteklenmiyor olarak işaretlenir', () => {
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/'); reg.noteInteraction();
  const s = request(reg, 1, 'https://c.example.com/drm.m3u8').source;
  reg.attachAnalysis(s.id, analyzeManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://k"\n#EXTINF:4,\na.ts\n', s.url));
  const v = reg.list()[0];
  assert.equal(v.availability, 'unsupported');
  assert.equal(v.reason, 'drm_protected');
});

test('DASH desteklenmiyor ama listelenir; kullanılabilir/oynatılabilir ayrıdır', () => {
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/'); reg.noteInteraction();
  request(reg, 1, 'https://c.example.com/m.mpd');
  assert.equal(reg.list()[0].availability, 'unsupported');
  const s = request(reg, 2, 'https://c.example.com/ok.mp4', { resourceType: 'media' }).source;
  reg.setAvailability(s.id, 'verified');
  assert.equal(reg.get(s.id).playability, 'unknown');
  reg.setPlayback(s.id, 'failed', 'media_decode');
  assert.equal(reg.get(s.id).availability, 'verified');
  assert.equal(reg.get(s.id).playability, 'failed');
});

test('arayüze giden görünümde istek başlıkları bulunmaz', () => {
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/'); reg.noteInteraction();
  request(reg, 1, 'https://c.example.com/a.m3u8');
  const json = JSON.stringify(reg.snapshot());
  assert.ok(!json.includes('cookieLike'));
  assert.ok(!json.includes('requestHeaders'));
});

test('ağ etkinliği sayaçları', () => {
  const reg = new SourceRegistry();
  reg.start(); reg.resetForNavigation('https://p.example.com/');
  reg.noteActivity('request'); reg.noteActivity('segment'); reg.noteActivity('media'); reg.noteActivity('ignored');
  assert.deepEqual(reg.snapshot().activity, { requests: 1, mediaRequests: 1, segments: 1, ignored: 1 });
});

test('algılama geç açıldığında ve sayfada segment akışı varken tamponlanmış kaynak kurtarılır', () => {
  const reg = new SourceRegistry();
  reg.resetForNavigation('https://p.example.com/anime-ep1');
  assert.equal(reg.snapshot().armed, false);

  // Kullanıcı Aincard/çeviri seçti
  reg.noteInteraction();

  // Master manifest isteği geldi (henüz algılama başlatılmamış)
  const tok = reg.beginRequest(101);
  const offered = reg.offer({
    url: 'https://video.aincard.net/hls/master.m3u8',
    classification: cls('https://video.aincard.net/hls/master.m3u8'),
    token: tok,
  });
  assert.equal(offered.status, 'ignored_not_armed');
  assert.equal(reg.list().length, 0);

  // Sayfada video oynuyor ve segment istekleri geliyor
  reg.noteSegmentObserved({
    url: 'https://video.aincard.net/hls/segment1.ts',
    referer: 'https://video.aincard.net/embed.html',
  });

  // Kullanıcı "Kaynak algılamayı başlat" butonuna basıyor
  reg.start();

  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://video.aincard.net/hls/master.m3u8');
  assert.equal(list[0].recovered, true);
  assert.equal(reg.snapshot().diagnostics.stage, 'ready');
});

test('kullanıcı tıklamasından ÖNCE gelen Aincard manifesti etkileşim ve 1 segment sonrasında kurtarılır (böyle kalıyor hatası)', () => {
  const reg = new SourceRegistry();
  reg.start();
  reg.resetForNavigation('https://anizm.net/anime-bolum-1');

  // 1. Sayfa yüklendiğinde Aincard iframe'i henüz kullanıcı tıklamadan manifest istedi
  const tok = reg.beginRequest(10);
  assert.equal(tok.interacted, false);
  const offered = reg.offer({
    url: 'https://cdn.aincard.net/hls/anime/master.m3u8',
    classification: cls('https://cdn.aincard.net/hls/anime/master.m3u8'),
    token: tok,
  });
  assert.equal(offered.status, 'ignored_before_selection');
  assert.equal(reg.list().length, 0);

  // 2. Kullanıcı Aincard seçti (Etkileşim Var)
  reg.noteInteraction();
  assert.equal(reg.snapshot().interacted, true);

  // 3. Orijinal sayfada video başladı ve 1 segment isteği geldi
  reg.noteSegmentObserved({
    url: 'https://cdn.aincard.net/hls/anime/720p/seg-001.ts',
    referer: 'https://aincard.net/embed/xyz',
  });

  // Kaynak listede belirmeli ve aşama "ready" olmalı
  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://cdn.aincard.net/hls/anime/master.m3u8');
  assert.equal(reg.snapshot().diagnostics.stage, 'ready');
  assert.equal(reg.snapshot().diagnostics.statusText.includes('1 adet oynatılabilir medya kaynağı algılandı'), true);
});

test('algılama açıkken segment referer m3u8 ise doğrudan manifest kurtarılır', () => {
  const reg = new SourceRegistry();
  reg.start();
  reg.resetForNavigation('https://p.example.com/');
  reg.noteInteraction();

  reg.noteSegmentObserved({
    url: 'https://cdn.example.com/stream/seg-001.m4s',
    referer: 'https://cdn.example.com/stream/manifest.m3u8',
  });

  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].url, 'https://cdn.example.com/stream/manifest.m3u8');
  assert.equal(list[0].kind, 'hls');
});

test('DOM aktif video tespiti tamponlanmış kaynağın açığa çıkmasını tetikler', () => {
  const reg = new SourceRegistry();
  reg.resetForNavigation('https://p.example.com/');
  reg.noteInteraction();

  const tok = reg.beginRequest(201);
  reg.offer({
    url: 'https://media.example.com/stream.mp4',
    classification: { role: 'source', kind: 'mp4', host: 'media.example.com', supported: true, mime: 'video/mp4' },
    token: tok,
  });
  assert.equal(reg.list().length, 0);

  reg.start();
  assert.equal(reg.list().length, 0);

  // DOM probe sayfada video buldu
  reg.noteActiveVideo(true);
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0].url, 'https://media.example.com/stream.mp4');
});

test('tanılama bilgileri ve ret sayaçları aşama aşama güncellenir', () => {
  const reg = new SourceRegistry();
  reg.resetForNavigation('https://p.example.com/');
  assert.equal(reg.snapshot().diagnostics.stage, 'not_armed');

  reg.start();
  assert.equal(reg.snapshot().diagnostics.stage, 'awaiting_selection');

  reg.noteInteraction();
  assert.equal(reg.snapshot().diagnostics.stage, 'listening');

  reg.noteRejection('ad_host');
  reg.noteRejection('noise_resource_type');
  reg.noteRejection('not_media');
  reg.noteRejection('bad_status_404');

  const diag = reg.snapshot().diagnostics;
  assert.equal(diag.rejections.ad_host, 1);
  assert.equal(diag.rejections.noise_resource_type, 1);
  assert.equal(diag.rejections.not_media, 1);
  assert.equal(diag.rejections.bad_status, 1);
});
