const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createPlayer, MAX_NETWORK_RETRIES, MAX_MEDIA_RECOVERIES } = require('../../frontend/js/player.js');
const R = require('../../frontend/js/render.js');

class FakeHls {
  static instances = [];
  static supported = true;
  static isSupported() { return FakeHls.supported; }
  static Events = { MANIFEST_PARSED: 'mp', LEVEL_SWITCHED: 'ls', ERROR: 'err', LEVEL_LOADED: 'll', FRAG_BUFFERED: 'fb' };
  static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', OTHER_ERROR: 'otherError' };
  constructor(cfg) { this.cfg = cfg; this.handlers = {}; this.destroyed = false; this.calls = []; this.levels = []; this._level = -1; FakeHls.instances.push(this); }
  get currentLevel() { return this._level; }
  set currentLevel(v) { this._level = v; }
  get nextLevel() { return this._level; }
  set nextLevel(v) { this._level = v; }
  on(ev, fn) { this.handlers[ev] = fn; }
  emit(ev, data) { this.handlers[ev] && this.handlers[ev](ev, data); }
  loadSource(u) { this.source = u; }
  attachMedia(v) { this.media = v; }
  startLoad() { this.calls.push('startLoad'); }
  recoverMediaError() { this.calls.push('recoverMediaError'); }
  swapAudioCodec() { this.calls.push('swapAudioCodec'); }
  destroy() { this.destroyed = true; }
}

function fakeVideo() {
  const listeners = {};
  return {
    paused: true, ended: false, currentTime: 0, duration: 100, volume: 1, muted: false, playbackRate: 1, error: null,
    src: '', attrs: {}, plays: 0, pauses: 0, loads: 0,
    addEventListener(ev, fn, opts) { (listeners[ev] = listeners[ev] || []).push({ fn, once: opts && opts.once }); },
    fire(ev) { (listeners[ev] || []).slice().forEach((l) => { l.fn(); if (l.once) listeners[ev].splice(listeners[ev].indexOf(l), 1); }); },
    removeAttribute(n) { if (n === 'src') this.src = ''; },
    load() { this.loads += 1; },
    play() { this.paused = false; this.plays += 1; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses += 1; },
    canPlayType() { return ''; },
  };
}

function make(opts = {}) {
  FakeHls.instances = []; FakeHls.supported = true;
  const video = fakeVideo();
  const errors = []; const qualities = []; const toasts = [];
  const player = createPlayer({
    video, Hls: opts.noHls ? null : FakeHls,
    onError: (e) => errors.push(e.code), onQualities: (q) => qualities.push(q), onToast: (m) => toasts.push(m),
  });
  return { video, player, errors, qualities, toasts };
}

const level = (h, b) => ({ height: h, bitrate: b });

test('HLS kaynağı yüklenir, kalite seviyeleri listelenir ve kalite seçilebilir', () => {
  const { player, qualities } = make();
  player.load({ url: '/api/proxy?sid=s&url=x', kind: 'hls' });
  const h = FakeHls.instances[0];
  assert.equal(h.source, '/api/proxy?sid=s&url=x');
  h.emit('mp', { levels: [level(360, 800000), level(720, 2800000), level(1080, 5000000)] });
  assert.deepEqual(qualities.at(-1).map((q) => q.height), [360, 720, 1080]);
  assert.equal(player.setQuality(2), true);
  assert.equal(h.currentLevel, 2);
  player.setQuality(-1);
  assert.equal(h.currentLevel, -1);
});

test('oynat/duraklat ve ileri-geri sarma sınırları', () => {
  const { player, video } = make();
  player.load({ url: '/a.mp4', kind: 'mp4' });
  player.togglePlay(); assert.equal(video.paused, false);
  player.togglePlay(); assert.equal(video.paused, true);
  video.currentTime = 50;
  player.seekBy(10); assert.equal(video.currentTime, 60);
  player.seekBy(-10); assert.equal(video.currentTime, 50);
  player.seekBy(-500); assert.equal(video.currentTime, 0);
  player.seekBy(500); assert.equal(video.currentTime, 100);
  player.setRate(1.5); assert.equal(video.playbackRate, 1.5);
  player.setVolume(0); assert.equal(video.muted, true);
});

test('MP4: kaynak atanır, sorgu parametreleri korunur', () => {
  const { player, video } = make();
  player.load({ url: '/api/proxy?sid=s&url=https%3A%2F%2Fa.com%2Fv.mp4%3Ftoken%3D1', kind: 'mp4' });
  assert.match(video.src, /token%3D1/);
  assert.equal(FakeHls.instances.length, 0);
});

test('yeni kaynak yüklenince eski HLS örneği yok edilir ve video temizlenir', () => {
  const { player, video } = make();
  player.load({ url: '/one', kind: 'hls' });
  const first = FakeHls.instances[0];
  player.load({ url: '/two.mp4', kind: 'mp4' });
  assert.equal(first.destroyed, true);
  assert.equal(video.src, '/two.mp4');
  assert.ok(video.loads >= 2);
  player.load({ url: '/three', kind: 'hls' });
  assert.equal(FakeHls.instances.length, 2);
  assert.equal(FakeHls.instances[1].destroyed, false);
});

test('HLS ağ hatası sınırlı sayıda yeniden denenir, sonra anlaşılır hata verilir', () => {
  const { player, errors } = make();
  player.load({ url: '/x', kind: 'hls' });
  const h = FakeHls.instances[0];
  for (let i = 0; i < MAX_NETWORK_RETRIES + 5; i++) {
    h.emit('err', { fatal: true, type: 'networkError', details: 'fragLoadError' });
  }
  assert.equal(h.calls.filter((c) => c === 'startLoad').length, MAX_NETWORK_RETRIES);
  assert.equal(errors.length, 1);
  assert.equal(errors[0], 'hls_network');
  assert.equal(h.destroyed, true);
});

test('medya hatası kurtarma sınırlıdır', () => {
  const { player, errors } = make();
  player.load({ url: '/x', kind: 'hls' });
  const h = FakeHls.instances[0];
  for (let i = 0; i < 6; i++) h.emit('err', { fatal: true, type: 'mediaError', details: 'bufferAppendError' });
  assert.equal(h.calls.filter((c) => c === 'recoverMediaError').length, MAX_MEDIA_RECOVERIES);
  assert.deepEqual(errors, ['hls_media']);
});

test('403/404 yanıtları yeniden denenmez ve ayrı hata kodu üretir', () => {
  for (const code of [403, 404]) {
    const { player, errors } = make();
    player.load({ url: '/x', kind: 'hls' });
    const h = FakeHls.instances[0];
    h.emit('err', { fatal: true, type: 'networkError', details: 'manifestLoadError', response: { code } });
    assert.equal(h.calls.length, 0);
    assert.deepEqual(errors, [`upstream_${code}`]);
  }
});

test('ölümcül olmayan hatalar yok sayılır', () => {
  const { player, errors } = make();
  player.load({ url: '/x', kind: 'hls' });
  FakeHls.instances[0].emit('err', { fatal: false, type: 'networkError', details: 'fragLoadError' });
  assert.deepEqual(errors, []);
});

test('HLS.js yoksa veya desteklenmiyorsa uygulama bozulmaz, anlaşılır hata verilir', () => {
  const a = make({ noHls: true });
  assert.equal(a.player.load({ url: '/x', kind: 'hls' }), false);
  assert.deepEqual(a.errors, ['hls_unavailable']);
  const b = make();
  FakeHls.supported = false;
  assert.equal(b.player.load({ url: '/x', kind: 'hls' }), false);
  assert.deepEqual(b.errors, ['hls_unsupported']);
  const c = make();
  assert.equal(c.player.load({ url: '/x', kind: 'dash' }), false);
  assert.deepEqual(c.errors, ['media_not_supported']);
  const d = make();
  assert.equal(d.player.load({ url: '', kind: 'hls' }), false);
  assert.deepEqual(d.errors, ['no_source']);
});

test('MP4 MediaError kodları ayrı bildirilir', () => {
  for (const [code, expected] of [[2, 'media_network'], [3, 'media_decode'], [4, 'media_not_supported']]) {
    const { player, video, errors } = make();
    player.load({ url: '/a.mp4', kind: 'mp4' });
    video.error = { code };
    video.fire('error');
    assert.deepEqual(errors, [expected]);
  }
});

test('hata sonrası yeniden yükleme: aynı kaynak, kaldığı konumdan', () => {
  const { player, video, errors } = make();
  player.load({ url: '/x', kind: 'hls' });
  FakeHls.instances[0].emit('err', { fatal: true, type: 'otherError', details: 'x' });
  assert.equal(errors.length, 1);
  video.currentTime = 42;
  assert.equal(player.reload(), true);
  assert.equal(FakeHls.instances.length, 2);
  assert.equal(FakeHls.instances[1].source, '/x');
  assert.equal(FakeHls.instances[1].cfg.startPosition, 42);
  assert.equal(FakeHls.instances[1].destroyed, false);
  // kurtarma sayaçları sıfırlandı
  assert.deepEqual(player.retries, { network: 0, media: 0 });
});

test('eski HLS örneğinden gelen gecikmiş hata yeni kaynağı etkilemez', () => {
  const { player, errors } = make();
  player.load({ url: '/old', kind: 'hls' });
  const old = FakeHls.instances[0];
  player.load({ url: '/new', kind: 'hls' });
  old.emit('err', { fatal: true, type: 'networkError', details: 'x' });
  assert.deepEqual(errors, []);
  assert.equal(FakeHls.instances[1].destroyed, false);
});

// ---- Güvenli render ----
test('güvenilmeyen host/etiket/URL metni HTML olarak yorumlanmaz', () => {
  const dom = new JSDOM('<div id="c"></div>');
  const { document } = dom.window;
  const evil = '<img src=x onerror="window.pwned=1"><script>window.pwned=2</script>';
  const sources = [{
    id: 'e1-s1', kind: 'hls', host: evil, url: `https://cdn.example.com/${encodeURIComponent(evil)}.m3u8`,
    availability: 'verified', playability: 'unknown', reason: evil, variants: [], maxHeight: 720, encryption: null, live: false,
  }];
  const c = document.getElementById('c');
  R.renderSources(c, sources, {});
  assert.equal(c.querySelectorAll('img').length, 0);
  assert.equal(c.querySelectorAll('script').length, 0);
  assert.ok(c.textContent.includes('<img src=x'));
  assert.equal(dom.window.pwned, undefined);
  R.renderPopups(c, [{ id: 1, host: evil, url: 'https://x' }], {});
  assert.equal(c.querySelectorAll('img').length, 0);
  assert.ok(c.textContent.includes('<script>'));
});

test('kaynak listesi: tür, ana bilgisayar, çözünürlük ve durum gösterilir; destekmeyen kaynak oynatılamaz', () => {
  const dom = new JSDOM('<div id="c"></div>');
  const c = dom.window.document.getElementById('c');
  let played = null;
  R.renderSources(c, [
    { id: 'a', kind: 'hls', host: 'cdn.example.com', url: 'https://cdn.example.com/m.m3u8', availability: 'verified', playability: 'unknown', variants: [{ height: 1080 }, { height: 720 }], maxHeight: 1080 },
    { id: 'b', kind: 'dash', host: 'x.example.com', url: 'https://x.example.com/m.mpd', availability: 'unsupported', reason: 'dash_unsupported', playability: 'unknown', variants: [] },
  ], { onPlay: (s) => { played = s.id; } });
  const rows = c.querySelectorAll('.source-row');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes('HLS') && rows[0].textContent.includes('cdn.example.com'));
  assert.ok(rows[0].textContent.includes('1080p / 720p') && rows[0].textContent.includes('Doğrulandı'));
  assert.equal(rows[1].querySelector('button').disabled, true);
  assert.ok(rows[1].textContent.includes('DASH desteklenmiyor'));
  rows[0].querySelector('button').click();
  assert.equal(played, 'a'); // yalnızca kullanıcı tıklayınca
});

test('Player: İntro/Outro atlama, hız kontrolü (pitch preservation), ses yükseltici ve tamponlama', () => {
  const { video, player } = make();
  video.duration = 200;
  video.currentTime = 10;

  // İntro atlama
  player.skipIntro(85);
  assert.equal(video.currentTime, 95);

  // Outro atlama
  player.skipOutro(85);
  assert.equal(video.currentTime, 180);

  // Hız kontrolü
  player.setRate(1.75);
  assert.equal(video.playbackRate, 1.75);
  assert.equal(video.preservesPitch, true);

  // Ses yükseltici
  const boost = player.setAudioBoost(200);
  assert.equal(boost, 200);

  // Tamponlama modu
  assert.equal(player.setBufferMode('aggressive'), true);
  assert.equal(player.setBufferMode('gecersiz_mod'), false);
});

test('R.renderBookmarks ve R.renderDownloads güvenli DOM kartları üretir', () => {
  const dom = new JSDOM('<div id="bms"></div><div id="dls"></div>');
  const bms = dom.window.document.getElementById('bms');
  const dls = dom.window.document.getElementById('dls');

  let openedBm = null;
  R.renderBookmarks(bms, [
    { id: 'bm1', title: 'Dragon Ball 27', pageUrl: 'https://example.com/db27', host: 'example.com' },
  ], { onOpen: (item) => { openedBm = item.id; } });

  assert.equal(bms.querySelectorAll('.bookmark-card').length, 1);
  assert.ok(bms.textContent.includes('Dragon Ball 27'));
  bms.querySelector('button.bg-brand-600').click();
  assert.equal(openedBm, 'bm1');

  let playedDl = null;
  R.renderDownloads(dls, [
    { id: 'dl1', title: 'One Piece 1000', status: 'completed', totalBytes: 50 * 1024 * 1024 },
  ], { onPlay: (item) => { playedDl = item.id; } });

  assert.equal(dls.querySelectorAll('.download-card').length, 1);
  assert.ok(dls.textContent.includes('One Piece 1000'));
  assert.ok(dls.textContent.includes('Tamamlandı'));
  dls.querySelector('button.bg-brand-600').click();
  assert.equal(playedDl, 'dl1');
});

test('getAdjacentEpisodeUrl: farklı anime/dizi URL şemalarından sonraki ve önceki bölümleri doğru çıkarır', () => {
  const { getAdjacentEpisodeUrl } = require('../../electron/browser-view.js');

  // 1. Path sonundaki bölüm ve sezon yapısı
  const url1 = 'https://animesitesi.com/dizi/naruto-shippuuden-1-sezon-14-bolum-izle/';
  assert.equal(getAdjacentEpisodeUrl(url1, 1), 'https://animesitesi.com/dizi/naruto-shippuuden-1-sezon-15-bolum-izle/');
  assert.equal(getAdjacentEpisodeUrl(url1, -1), 'https://animesitesi.com/dizi/naruto-shippuuden-1-sezon-13-bolum-izle/');

  // 2. Query parametresi (?ep=27)
  const url2 = 'https://example.com/watch?ep=27&server=vid';
  assert.equal(getAdjacentEpisodeUrl(url2, 1), 'https://example.com/watch?ep=28&server=vid');
  assert.equal(getAdjacentEpisodeUrl(url2, -1), 'https://example.com/watch?ep=26&server=vid');

  // 3. Sıfır dolgulu bölüm numaraları (04 -> 05 / 03)
  const url3 = 'https://site.org/anime/bleach-ep-04.html';
  assert.equal(getAdjacentEpisodeUrl(url3, 1), 'https://site.org/anime/bleach-ep-05.html');
  assert.equal(getAdjacentEpisodeUrl(url3, -1), 'https://site.org/anime/bleach-ep-03.html');

  // 4. 1. bölümden geriye gidiş sınır kontrolü (null dönmeli)
  const urlFirst = 'https://example.com/watch?ep=1';
  assert.equal(getAdjacentEpisodeUrl(urlFirst, -1), null);
});

test('Player: geçmişten veya resume noktasından startTime ile başlatıldığında HLS ve MP4 doğru saniyeye atlar', () => {
  const { video, player } = make();
  // HLS testi
  player.load({ url: '/api/proxy?sid=s&url=x', kind: 'hls', startTime: 264 });
  const h = FakeHls.instances[0];
  assert.equal(h.cfg.startPosition, 264);

  // MANIFEST_PARSED olayı tetiklenince video currentTime hedefe atlanmalı
  video.readyState = 1;
  h.emit(FakeHls.Events.MANIFEST_PARSED, { levels: [] });
  assert.equal(video.currentTime, 264);

  // MP4 testi
  const { video: mp4Vid, player: mp4Player } = make();
  mp4Player.load({ url: 'http://cdn/video.mp4', kind: 'mp4', startTime: 120 });
  mp4Vid.readyState = 1;
  mp4Vid.fire('loadedmetadata');
  assert.equal(mp4Vid.currentTime, 120);
});
