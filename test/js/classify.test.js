const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../frontend/js/classify.js');
const M = require('../../frontend/js/messages.js');
const { analyzeManifest } = require('../../electron/lib/m3u8.js');

const ok = (o) => C.classifyResponse({ statusCode: 200, resourceType: 'xhr', ...o });

test('HLS manifest algılanır (URL ve MIME), sorgu parametresi tanımayı bozmaz', () => {
  assert.equal(ok({ url: 'https://cdn.example.com/a/index.m3u8?token=abc&e=1' }).kind, 'hls');
  assert.equal(ok({ url: 'https://cdn.example.com/play', mimeType: 'application/vnd.apple.mpegurl' }).kind, 'hls');
  assert.equal(ok({ url: 'https://cdn.example.com/play', headers: { 'Content-Type': ['application/x-mpegURL'] } }).kind, 'hls');
  assert.equal(ok({ url: 'https://anizmplayer.com/video/d8f395a31120beceaaaef1d669f/master.txt' }).kind, 'hls');
});

test('MP4 sonundaki ?token=... tanımayı bozmaz; sorguda m3u8 geçmesi yanıltmaz', () => {
  assert.equal(ok({ url: 'https://cdn.example.com/v/ep.mp4?token=XYZ&x=.m3u8', resourceType: 'media', statusCode: 206 }).kind, 'mp4');
  assert.equal(C.kindFromUrl('https://a.com/video.mp4?redirect=x.m3u8'), 'mp4');
  assert.equal(C.kindFromUrl('https://a.com/page?file=x.mp4'), null);
});

test('blob: ve data: asla doğrudan kaynak sayılmaz', () => {
  assert.equal(C.kindFromUrl('blob:https://site.com/1234'), 'blob');
  assert.equal(ok({ url: 'blob:https://site.com/1234', mimeType: 'video/mp4' }), null);
  assert.equal(ok({ url: 'data:video/mp4;base64,AAAA', mimeType: 'video/mp4' }), null);
});

test('segmentler kaynak değil etkinliktir', () => {
  assert.deepEqual(ok({ url: 'https://cdn.example.com/seg1.ts?x=1', resourceType: 'media' }).role, 'segment');
  assert.equal(ok({ url: 'https://cdn.example.com/s.bin', mimeType: 'video/mp2t' }).role, 'segment');
});

test('reklam/analitik/görsel/başarısız istekler yok sayılır', () => {
  assert.equal(ok({ url: 'https://googleads.g.doubleclick.net/pagead/x.mp4', mimeType: 'video/mp4' }), null);
  assert.equal(ok({ url: 'https://ads.tracker.example/ad.mp4', mimeType: 'video/mp4' }), null);
  assert.equal(ok({ url: 'https://cdn.example.com/poster.mp4.jpg', mimeType: 'image/jpeg', resourceType: 'image' }), null);
  assert.equal(ok({ url: 'https://cdn.example.com/x.mp4', resourceType: 'image' }), null);
  assert.equal(ok({ url: 'https://cdn.example.com/x.m3u8', statusCode: 403 }), null);
  assert.equal(ok({ url: 'https://cdn.example.com/x.m3u8', statusCode: 404 }), null);
  assert.equal(ok({ url: 'https://cdn.example.com/x.m3u8', statusCode: 302 }), null);
  assert.equal(ok({ url: 'https://cdn.example.com/watch.m3u8', mimeType: 'text/html' }), null);
  assert.equal(ok({ url: 'https://cdn.example.com/api/data', mimeType: 'application/json' }), null);
});

test('DASH algılanır ama desteklenmiyor olarak bildirilir', () => {
  const r = ok({ url: 'https://cdn.example.com/manifest.mpd?x=1' });
  assert.equal(r.kind, 'dash');
  assert.equal(r.supported, false);
  assert.equal(r.reason, 'dash_unsupported');
});

test('çözünürlük ipucu ve boyut', () => {
  assert.equal(ok({ url: 'https://c.com/v/720p/index.m3u8' }).resolutionHint, 720);
  assert.equal(ok({ url: 'https://c.com/v/x.mp4', statusCode: 206, headers: { 'content-range': 'bytes 0-9/5000' } }).sizeBytes, 5000);
});

test('adres çubuğu girdisi: sayfa / doğrudan medya / geçersiz', () => {
  assert.equal(C.classifyInput('https://anizm.net/dragon-ball-27-bolum-izle').type, 'page');
  assert.equal(C.classifyInput('anizm.net/x').url, 'https://anizm.net/x');
  assert.deepEqual(C.classifyInput('https://a.com/v.m3u8?token=1'), { type: 'media', kind: 'hls', url: 'https://a.com/v.m3u8?token=1' });
  assert.equal(C.classifyInput('https://a.com/v.mp4?t=1').kind, 'mp4');
  assert.equal(C.classifyInput('').type, 'empty');
  assert.equal(C.classifyInput('   ').type, 'empty');
  assert.equal(C.classifyInput('javascript:alert(1)').type, 'invalid');
  assert.equal(C.classifyInput('file:///etc/passwd').type, 'invalid');
  assert.equal(C.classifyInput('merhaba dünya').type, 'invalid');
});

test('ağ hatası kodları ve mesajları', () => {
  assert.equal(M.netErrorCode('ERR_NAME_NOT_RESOLVED'), 'dns_error');
  assert.equal(M.netErrorCode('ERR_CONNECTION_REFUSED'), 'connection_error');
  assert.equal(M.netErrorCode('ERR_CONNECTION_TIMED_OUT'), 'timeout');
  assert.equal(M.netErrorCode('ERR_CERT_DATE_INVALID'), 'cert_error');
  assert.equal(M.httpErrorCode(403), 'http_403');
  assert.equal(M.httpErrorCode(503), 'http_5xx');
  for (const code of ['http_403', 'http_404', 'http_429', 'timeout', 'connection_error', 'dns_error', 'upstream_403', 'upstream_404', 'upstream_429', 'hls_unavailable', 'drm_protected', 'dash_unsupported']) {
    assert.ok(M.describe(code).length > 10, code);
    assert.notEqual(M.describe(code), M.describe('bilinmeyen_kod_xyz'));
  }
  assert.match(M.describe('http_403'), /403/);
  assert.match(M.describe('http_404'), /404/);
});

// ---- m3u8 analizi ----
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
360/index.m3u8?t=1
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
https://other.example.net/720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080
../hd/1080.m3u8
`;

test('master manifest: kalite seviyeleri ve göreli alt manifest URL çözümü', () => {
  const a = analyzeManifest(MASTER, 'https://cdn.example.com/v/master.m3u8');
  assert.equal(a.valid, true);
  assert.equal(a.type, 'master');
  assert.deepEqual(a.variants.map((v) => v.height), [1080, 720, 360]);
  assert.equal(a.maxHeight, 1080);
  assert.deepEqual(a.variants.map((v) => v.url), [
    'https://cdn.example.com/hd/1080.m3u8', 'https://other.example.net/720.m3u8', 'https://cdn.example.com/v/360/index.m3u8?t=1']);
  assert.equal(a.drm, false);
});

test('media manifest: canlı/VOD ve şifreleme ayrımı', () => {
  const vod = analyzeManifest('#EXTM3U\n#EXTINF:4,\ns0.ts\n#EXTINF:4,\ns1.ts\n#EXT-X-ENDLIST\n', 'https://a.com/x.m3u8');
  assert.equal(vod.type, 'media'); assert.equal(vod.live, false); assert.equal(vod.segmentCount, 2);
  const live = analyzeManifest('#EXTM3U\n#EXTINF:4,\ns0.ts\n', 'https://a.com/x.m3u8');
  assert.equal(live.live, true);
  const aes = analyzeManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k.bin"\n#EXTINF:4,\ns0.ts\n', 'https://a.com/x.m3u8');
  assert.equal(aes.encryption, 'aes-128'); assert.equal(aes.drm, false);
});

test('DRM (SAMPLE-AES / FairPlay / Widevine) desteklenmiyor olarak işaretlenir', () => {
  const fp = analyzeManifest('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:4,\ns0.ts\n', 'https://a.com/x.m3u8');
  assert.equal(fp.drm, true);
  const wv = analyzeManifest('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="data:x"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', 'https://a.com/m.m3u8');
  assert.equal(wv.drm, true);
});

test('geçersiz içerik HLS sayılmaz', () => {
  assert.equal(analyzeManifest('<html></html>', 'https://a.com/x').valid, false);
  assert.equal(analyzeManifest('', 'https://a.com/x').valid, false);
});

test('master.txt, boşluklu veya Base64 HLS manifestleri geçerli kabul edilir', () => {
  const loose = analyzeManifest('\r\n\n#EXTM3U\n#EXTINF:4,\nseg.ts\n', 'https://anizmplayer.com/master.txt');
  assert.equal(loose.valid, true);
  assert.equal(loose.type, 'media');

  const b64 = Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720\n720p.m3u8\n').toString('base64');
  const fromB64 = analyzeManifest(b64, 'https://anizmplayer.com/master.txt');
  assert.equal(fromB64.valid, true);
  assert.equal(fromB64.type, 'master');
  assert.equal(fromB64.maxHeight, 720);
});

test('classifyResponseDetailed ret nedenlerini ve sınıflandırmayı doğru üretir', () => {
  const d1 = C.classifyResponseDetailed({ statusCode: 403, url: 'https://cdn.example.com/live.m3u8' });
  assert.equal(d1.accepted, false);
  assert.equal(d1.reason, 'bad_status_403');

  const d2 = C.classifyResponseDetailed({ statusCode: 200, url: 'https://pagead2.googlesyndication.com/pagead.js' });
  assert.equal(d2.accepted, false);
  assert.equal(d2.reason, 'ad_host');

  const d3 = C.classifyResponseDetailed({ statusCode: 200, url: 'https://example.com/style.css', resourceType: 'stylesheet' });
  assert.equal(d3.accepted, false);
  assert.equal(d3.reason, 'noise_resource_type');

  const d4 = C.classifyResponseDetailed({
    statusCode: 200,
    url: 'https://stream.example.com/hls/live/playlist',
    mimeType: 'application/octet-stream',
    resourceType: 'xhr',
  });
  assert.equal(d4.accepted, true);
  assert.equal(d4.result.kind, 'hls');

  const d5 = C.classifyResponseDetailed({
    statusCode: 200,
    url: 'https://stream.example.com/custom/source',
    mimeType: 'video/mp4',
    resourceType: 'fetch',
  });
  assert.equal(d5.accepted, true);
  assert.equal(d5.result.kind, 'mp4');
});
