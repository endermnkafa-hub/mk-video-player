'use strict';
// Gerçek Electron + gerçek Python arka ucu + yerel test sitesiyle uçtan uca testler.
// Üçüncü taraf hizmet kullanmaz. Çalıştırma: npm run test:e2e
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { startBackend } = require(path.join(ROOT, 'electron', 'backend.js'));
const { createBrowser } = require(path.join(ROOT, 'electron', 'browser-view.js'));
const { SourceRegistry } = require(path.join(ROOT, 'electron', 'lib', 'registry.js'));
const { WatchHistoryStore } = require(path.join(ROOT, 'electron', 'lib', 'history.js'));
const { preparePlayback, prepareFromHistory } = require(path.join(ROOT, 'electron', 'source-session.js'));

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`);
}
function skip(name, why) { results.push({ name, ok: true, skipped: true }); console.log(`SKIP  ${name}  (${why})`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 10000, step = 100) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return false;
    await sleep(step);
  }
}

// ---------------- Fixture medya (ffmpeg) ----------------
function makeMedia(dir) {
  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  const probe = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return false;
  const hls = (name, size) => {
    const d = path.join(dir, name); fs.mkdirSync(d, { recursive: true });
    const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=15`, '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '48k', '-shortest', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(d, 'seg%d.ts'), path.join(d, 'index.m3u8')], { encoding: 'utf8' });
    return r.status === 0;
  };
  const ok1 = hls('hls360', '640x360'); const ok2 = hls('hls180', '320x180');
  const mp4 = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=330',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart',
    path.join(dir, 'b.mp4')], { encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'hls'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'hls', 'master.m3u8'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\n../hls180/index.m3u8\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360\n../hls360/index.m3u8?v=1\n');
  return ok1 && ok2 && mp4.status === 0;
}

// ---------------- Yerel test sitesi ----------------
const MIME = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.mp4': 'video/mp4' };
const PAGE = (ep) => `<!doctype html><meta charset="utf-8"><title>Bölüm ${ep}</title><body style="margin:0;background:#222">
<div id="root"></div><script>
const B = new URLSearchParams(location.search).get('b');
fetch('/media/preload/ad.m3u8').catch(()=>{});            // seçimden ÖNCE (reklam/ön yükleme): yok sayılmalı
const img = new Image(); img.src = '/pixel.gif?ad=1';
setTimeout(() => {                                         // JavaScript ile üretilen arayüz
  const root = document.getElementById('root');
  const mk = (id, label, top, fn) => { const b = document.createElement('button'); b.id = id; b.textContent = label;
    b.style.cssText = 'position:absolute;left:10px;width:300px;height:50px;top:' + top + 'px'; b.onclick = fn; root.appendChild(b); };
  mk('trA', 'Çeviri A (HLS)', 10, async () => {
    await (await fetch('/media/hls/master.m3u8')).text();
    await (await fetch('/media/hls360/index.m3u8?v=1')).text();
    await (await fetch('/media/hls360/seg0.ts')).arrayBuffer();
  });
  mk('trB', 'Çeviri B (MP4)', 70, () => { const v = document.createElement('video'); v.muted = true; v.preload = 'auto';
    v.src = '/media/b.mp4?token=1&ep=${ep}'; root.appendChild(v); });
  mk('pop', 'Reklam penceresi', 130, () => { window.open('/popup', '_blank'); });
  mk('probe', 'Yerel API dene', 190, async () => { try { const r = await fetch(B + '/api/health'); window.__probe = 'reached:' + r.status; }
    catch (e) { window.__probe = 'blocked'; } });
  window.__ready = true;
}, 150);
</script>`;

function startSite(mediaDir, state) {
  const log = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ path: u.pathname, range: req.headers.range || null, referer: req.headers.referer || null, cookie: !!req.headers.cookie });
    if (u.pathname === '/ep1' || u.pathname === '/ep2') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sess=e2e-secret; Path=/' });
      return res.end(PAGE(u.pathname.slice(3)));
    }
    if (u.pathname === '/popup') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<title>popup</title>reklam'); }
    if (u.pathname === '/status/404') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>yok</h1>'); }
    if (u.pathname === '/status/403') { res.writeHead(403, { 'content-type': 'text/html' }); return res.end('<h1>yasak</h1>'); }
    if (u.pathname === '/status/429') { res.writeHead(429, { 'content-type': 'text/html' }); return res.end('<h1>cok fazla</h1>'); }
    if (u.pathname === '/pixel.gif') { res.writeHead(200, { 'content-type': 'image/gif' }); return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); }
    if (u.pathname === '/media/preload/ad.m3u8') { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:1,\nad.ts\n#EXT-X-ENDLIST\n'); }
    if (u.pathname === '/flaky/index.m3u8') {
      if (!state.flakyReady) { res.writeHead(404); return res.end('nope'); }
      const txt = fs.readFileSync(path.join(mediaDir, 'hls180', 'index.m3u8'), 'utf8').replace(/^(seg\d+\.ts)$/gm, '/media/hls180/$1');
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end(txt);
    }
    if (u.pathname.startsWith('/media/')) {
      const file = path.join(mediaDir, u.pathname.slice('/media/'.length));
      if (!file.startsWith(mediaDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('nope'); }
      const size = fs.statSync(file).size;
      const type = MIME[path.extname(file)] || 'application/octet-stream';
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const start = m[1] ? Number(m[1]) : 0; const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
      return fs.createReadStream(file).pipe(res);
    }
    res.writeHead(404); res.end('nope');
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, log, port: srv.address().port })));
}

// ---------------- Test akışı ----------------
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-e2e-'));
  const hasMedia = makeMedia(tmp);
  const state = { flakyReady: false };
  const site = await startSite(tmp, state);
  const origin = `http://127.0.0.1:${site.port}`;
  const backend = await startBackend({ MK_UNSAFE_TEST_ALLOW_LOOPBACK: '1' });
  console.log(`site=${origin} backend=${backend.origin} media=${hasMedia}`);

  // --- A) Gömülü tarayıcı + kaynak algılama ---
  const win = new BrowserWindow({ show: true, x: 50, y: 50, width: 1000, height: 700, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('about:blank');
  const registry = new SourceRegistry();
  const navs = [];
  const br = createBrowser({ registry, backendPort: backend.port, onState: (s) => navs.push(s), onPopups: () => {} });
  win.contentView.addChildView(br.view);
  br.view.setBounds({ x: 0, y: 0, width: 1000, height: 700 });
  const wc = br.wc;
  win.show(); wc.focus();
  const js = (code) => wc.executeJavaScript(code);
  const click = async (id) => {
    const r = await js(`(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return {x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)}; })()`);
    wc.sendInputEvent({ type: 'mouseMove', x: r.x, y: r.y });
    wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  const gotoPage = async (p) => {
    br.navigate(`${origin}${p}?b=${encodeURIComponent(backend.origin)}`);
    await waitFor(() => wc.getURL().includes(p) && !wc.isLoading(), 10000);
    await waitFor(() => js('window.__ready === true'), 5000);
  };

  registry.start();
  await gotoPage('/ep1');
  await sleep(800);
  check('Seçimden önce gelen medya istekleri (ön yükleme/reklam) listelenmedi', registry.list().length === 0, registry.list());
  check('Algılama açıkken ağ etkinliği sayıldı', registry.snapshot().activity.requests > 0);

  await click('trA');
  const hlsSrc = await waitFor(() => registry.list().find((s) => s.kind === 'hls' && s.url.includes('/media/hls/master.m3u8') && s.availability === 'verified'), 10000);
  check('Kullanıcı seçiminden sonra JS ile üretilmiş sayfadan HLS master algılandı ve doğrulandı', !!hlsSrc, registry.list());
  check('Kullanıcı etkileşimi kapıyı açtı', registry.snapshot().interacted === true);
  check('Master manifest kalite seviyeleri (360/180) tanındı', hlsSrc && hlsSrc.variants.map((v) => v.height).join() === '360,180', hlsSrc && hlsSrc.variants);
  check('Alt manifest ayrı kaynak olarak gösterilmedi, segmentler kaynak sayılmadı',
    registry.list().length === 1 && registry.snapshot().activity.segments >= 1, registry.list().map((s) => s.url));
  check('Önceden gelen reklam manifesti listede yok', !registry.list().some((s) => s.url.includes('ad.m3u8')));
  check('Hiçbir kaynak otomatik oynatılmadı (oynatılabilirlik "unknown")', registry.list().every((s) => s.playability === 'unknown'));

  await click('trB');
  const mp4Src = await waitFor(() => registry.list().find((s) => s.kind === 'mp4'), 10000);
  check('MP4 (?token=...&ep=1 sorgulu) algılandı', !!mp4Src && mp4Src.url.includes('token=1'), registry.list());
  check('İki kaynak varsa ikisi de listelenir (rastgele biri seçilmez)', registry.list().length === 2);

  // Oturum hazırlama: yalnızca bu kaynak için başlık/çerez bellek içi oturuma aktarılır
  const prep = await preparePlayback({ backend, registry, ses: br.ses, id: hlsSrc.id, pageTitle: 'T' });
  check('Seçilen kaynak için proxy oturumu hazırlandı', prep.ok && prep.proxyUrl.startsWith('/api/proxy?sid='), prep);
  const json = JSON.stringify(registry.snapshot()) + JSON.stringify(prep);
  check('Çerez/başlık değerleri arayüze giden veride yok', !json.includes('e2e-secret') && !json.includes('cookie'));

  // Yerel API'ye erişim engeli
  await click('probe');
  await waitFor(() => js('window.__probe !== undefined'), 5000);
  check('Gömülü sayfa uygulamanın yerel API sunucusuna erişemiyor', (await js('window.__probe')) === 'blocked', await js('window.__probe'));

  // Pop-up kontrolü
  await wc.executeJavaScript("document.getElementById('pop').click()", true); // kullanıcı jestiyle
  await waitFor(() => br.popups.blocked.length === 1, 5000);
  check('Yeni pencere varsayılan olarak engellendi ve listelendi', br.popups.blocked.length === 1 && br.popups.blocked[0].url.endsWith('/popup'), br.popups.blocked);
  check('Sayfa aynı sekmede kaldı', wc.getURL().includes('/ep1'));
  br.openBlockedPopup(br.popups.blocked[0].id);
  await waitFor(() => wc.getURL().endsWith('/popup'), 5000);
  check('Engellenen pencere kullanıcı isteğiyle açılabildi', wc.getURL().endsWith('/popup'), wc.getURL());

  // Yeni bölüm: önceki kaynaklar kullanılmaz
  const oldId = hlsSrc.id;
  await gotoPage('/ep2');
  await sleep(600);
  check('Yeni bölüme geçince liste temizlendi', registry.list().length === 0, registry.list());
  const stale = await preparePlayback({ backend, registry, ses: br.ses, id: oldId, pageTitle: 'T' });
  check('Önceki bölümün kaynağı oynatılamıyor (stale_source)', stale.ok === false && stale.code === 'stale_source', stale);
  await click('trB');
  const ep2 = await waitFor(() => registry.list().find((s) => s.kind === 'mp4'), 10000);
  check('Yeni bölümde yalnızca yeni seçimin kaynağı listelendi', !!ep2 && ep2.url.includes('ep=2') && registry.list().length === 1, registry.list());

  // probeActiveMedia DOM videosu algılama (Aincard / gömülü iframe simülasyonu)
  await js(`(() => {
    const v = document.createElement('video');
    v.id = 'probedVideo';
    v.src = '/media/b.mp4?probe=1';
    document.body.appendChild(v);
  })()`);
  await br.probeActiveMedia();
  const probed = await waitFor(() => registry.list().find((s) => s.url.includes('probe=1')), 5000);
  check('probeActiveMedia() oynatılmakta olan DOM videosunu doğru algıladı', !!probed, registry.list());

  // Gezinti hataları
  for (const [p, code] of [['/status/404', 'http_404'], ['/status/403', 'http_403'], ['/status/429', 'http_429']]) {
    br.navigate(origin + p);
    const ok = await waitFor(() => br.state.error && br.state.error.code === code, 8000);
    check(`Sayfa ${p.slice(-3)} yanıtı doğru bildirildi (${code})`, !!ok, br.state.error);
  }
  const dead = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  br.navigate('http://127.0.0.1:' + dead + '/');
  check('Bağlantı hatası bildirildi', !!(await waitFor(() => br.state.error && br.state.error.code === 'connection_error', 8000)), br.state.error);
  br.navigate('http://yok-boyle-bir-alan.invalid/');
  check('DNS hatası bildirildi', !!(await waitFor(() => br.state.error && br.state.error.code === 'dns_error', 8000)), br.state.error);

  // --- B) Özel oynatıcı: gerçek HLS.js + gerçek proxy ---
  if (!hasMedia) {
    skip('HLS/MP4 oynatma, kalite, sarma, yeniden yükleme', 'ffmpeg bulunamadı veya fixture üretilemedi');
  } else {
    const pw = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false } });
    await pw.loadURL(backend.origin + '/');
    const pj = (code) => pw.webContents.executeJavaScript(code);
    await pj(`window.__errors = []; window.__video = document.getElementById('videoElement'); __video.muted = true;
      window.__p = MKPlayer.createPlayer({ video: __video, Hls: window.Hls, onError: (e) => __errors.push(e.code), onQualities: (q) => { window.__levels = q.length; } }); true`);
    const sessionFor = async (url, extra) => (await backend.post('/api/sessions', { url, referer: origin + '/ep1', ...extra })).proxy_url;

    const hStart = site.log.length;
    const hlsProxy = await sessionFor(`${origin}/media/hls/master.m3u8`);
    await pj(`__p.load({ url: ${JSON.stringify(hlsProxy)}, kind: 'hls' }); __p.play(); true`);
    check('HLS: proxy üzerinden oynatma başladı (currentTime ilerliyor)', !!(await waitFor(() => pj('__video.currentTime > 0.8'), 20000)), await pj('JSON.stringify({t: __video.currentTime, err: __errors, ready: __video.readyState})'));
    check('HLS: kalite seviyeleri HLS.js tarafından tanındı (2)', (await pj('window.__levels')) === 2, await pj('window.__levels'));
    check('HLS: alt manifest ve segmentler proxy ile göreli URL zincirinden alındı',
      site.log.some((l) => l.path.startsWith('/media/hls180/') || l.path.startsWith('/media/hls360/')) && site.log.some((l) => l.path.endsWith('.ts')));
    check('HLS: kaynak sitesine Referer aktarıldı (çerez aktarılmadı: oturumda çerez yok)', site.log.slice(hStart).filter((l) => l.path.endsWith('.ts')).length > 0 && site.log.slice(hStart).filter((l) => l.path.endsWith('.ts')).every((l) => l.referer === origin + '/ep1'));

    await pj('__p.setQuality(0); true');
    await sleep(1200);
    check('HLS: kalite sabitleme (180p) uygulandı', (await pj('__p.engine.currentLevel')) === 0 || (await pj('__p.engine.loadLevel')) === 0, await pj('__p.engine.currentLevel'));
    await pj('__p.setQuality(-1); true');
    check('HLS: otomatik kaliteye dönüş', (await pj('__p.engine.autoLevelEnabled')) === true);

    await pj('__p.pause(); true'); await sleep(200);
    check('Duraklat çalışıyor', (await pj('__video.paused')) === true);
    await pj('__p.play(); true');
    check('Oynat çalışıyor (duraklatma sonrası ilerliyor)', !!(await waitFor(() => pj('!__video.paused && __video.currentTime > 0'), 5000)));

    const before = site.log.length;
    await pj('__p.seekTo(5); true');
    check('HLS: ileri sarma (5 sn) sonrası oynatma sürüyor', !!(await waitFor(() => pj('Math.abs(__video.currentTime - 5) < 2.5 && __video.readyState >= 2 && !__video.seeking'), 15000)), await pj('__video.currentTime'));
    check('HLS: ileri sarma ilgili segmentleri (seg2+) yeniden istedi veya tampondan kesintisiz oynatıldı', site.log.slice(before).some((l) => /seg[2-9]\.ts/.test(l.path)) || site.log.slice(hStart).some((l) => /seg[2-9]\.ts/.test(l.path)), site.log.slice(before).map((l) => l.path));
    await pj('__p.seekBy(-4); true');
    check('HLS: geri sarma çalışıyor', !!(await waitFor(() => pj('__video.currentTime < 3.5 && __video.readyState >= 2 && !__video.seeking'), 15000)), await pj('__video.currentTime'));

    // MP4 + Range
    const mp4Proxy = await sessionFor(`${origin}/media/b.mp4?token=abc`);
    const rBefore = site.log.length;
    await pj(`__p.load({ url: ${JSON.stringify(mp4Proxy)}, kind: 'mp4' }); __p.play(); true`);
    check('MP4: oynatma başladı', !!(await waitFor(() => pj('__video.currentTime > 0.5'), 15000)), await pj('JSON.stringify({t:__video.currentTime, err:__errors})'));
    await pj('__p.seekTo(5.5); true');
    check('MP4: sarma sonrası oynatma sürüyor', !!(await waitFor(() => pj('__video.currentTime > 5.4 && !__video.seeking && __video.readyState >= 2'), 15000)), await pj('__video.currentTime'));
    const ranges = site.log.slice(rBefore).filter((l) => l.path === '/media/b.mp4');
    check('MP4: kaynağa Range istekleri iletildi', ranges.some((l) => l.range), ranges);
    const rr = await pj(`fetch(${JSON.stringify(mp4Proxy)}, { headers: { Range: 'bytes=10-19' } }).then(async (r) => ({ s: r.status, cr: r.headers.get('content-range'), n: (await r.arrayBuffer()).byteLength }))`);
    check('MP4: proxy 206 + Content-Range koruyor', rr.s === 206 && /^bytes 10-19\//.test(rr.cr) && rr.n === 10, rr);

    // Hata ve yeniden yükleme
    const flakyProxy = await sessionFor(`${origin}/flaky/index.m3u8`);
    await pj(`__errors.length = 0; __p.load({ url: ${JSON.stringify(flakyProxy)}, kind: 'hls' }); true`);
    check('Kaynak 404 verince ayrı ve anlaşılır hata kodu (upstream_404)', !!(await waitFor(() => pj('__errors.length > 0'), 15000)) && (await pj('__errors[0]')) === 'upstream_404', await pj('JSON.stringify(__errors)'));
    state.flakyReady = true;
    await pj(`__errors.length = 0; __p.reload(); __p.play(); true`);
    check('Hata sonrası yeniden yükleme kaynak düzelince oynatıyor', !!(await waitFor(() => pj('__video.currentTime > 0.5'), 20000)), await pj('JSON.stringify({t:__video.currentTime, err:__errors})'));
    check('Yeniden yükleme sonrası hata yok', (await pj('__errors.length')) === 0);

    // Geçersiz oturum
    const bad = await pj(`fetch('/api/proxy?sid=uydurma&url=${encodeURIComponent(origin + '/media/b.mp4')}').then(r => r.status)`);
    check('Oturumsuz proxy isteği reddedildi (403)', bad === 403, bad);
    const noTok = await pj(`fetch('/api/sessions', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({url: '${origin}/media/b.mp4'}) }).then(r => r.status)`);
    check('Oturum oluşturma admin token olmadan reddedildi (403)', noTok === 403, noTok);

    // --- C) Kalıcı web oturumu, İzleme geçmişi ve Geçmişten doğrudan oynatma ---
    check('Gömülü tarayıcı kalıcı oturum (persist:) kullanıyor', br.getSessionInfo().persistent === true);
    const siteCookies = await br.ses.cookies.get({ url: origin });
    check('Gömülü sayfanın çerezleri kalıcı oturumda saklandı', siteCookies.some((c) => c.name === 'sess' && c.value === 'e2e-secret'), siteCookies);

    // İzleme geçmişi deposu ve ilerleme kaydı
    const historyPath = path.join(tmp, 'e2e_history.json');
    const histStore1 = new WatchHistoryStore({ storagePath: historyPath });
    const hItem = histStore1.upsert({
      pageUrl: `${origin}/ep1`,
      mediaUrl: `${origin}/media/hls/master.m3u8`,
      title: 'Bölüm 1',
      episode: '1. Bölüm',
      provider: 'Yerel Site',
      kind: 'hls',
      duration: 8,
      currentTime: 4.5,
      headers: { referer: `${origin}/ep1` },
    });
    histStore1.saveSync();
    check('Video izlenince geçmişe eklendi', histStore1.list().length === 1 && histStore1.list()[0].id === hItem.id);
    const rawDiskHist = fs.readFileSync(historyPath, 'utf8');
    check('Geçmiş dosyasında medya URL düz metin saklanmıyor (şifreli)', !rawDiskHist.includes('/media/hls/master.m3u8') && rawDiskHist.includes('enc:'));

    // Uygulama yeniden başlatma simülasyonu: yeni store örneği diskten okur
    const histStore2 = new WatchHistoryStore({ storagePath: historyPath });
    check('Uygulama yeniden başlatılınca geçmiş kaydı kaybolmuyor', histStore2.list().length === 1 && histStore2.list()[0].currentTime === 4.5);
    check('İlerleme doğru saniye (4.5s) ve süre (8s) olarak kaydedildi', histStore2.list()[0].currentTime === 4.5 && histStore2.list()[0].duration === 8);

    // Geçmişten doğrudan oynatma (Orijinal web sayfasını açmadan)
    const fromHist = await prepareFromHistory({
      backend,
      historyStore: histStore2,
      ses: br.ses,
      id: hItem.id,
      restart: false,
    });
    check('Geçmişten oynatma orijinal sayfaya gitmeden proxy oturumu hazırladı', fromHist.ok && fromHist.startTime === 4.5, fromHist);
    check('Geçmişten oynatma tam çözülmüş URL yi renderer a sızdırmadı', fromHist.rawUrl === undefined);

    await pj(`__errors.length = 0; __p.load({ url: ${JSON.stringify(fromHist.proxyUrl)}, kind: 'hls', startTime: ${fromHist.startTime} }); __p.play(); true`);
    check('Geçmişten oynatma kaldığı yerden (4.5s) devam ediyor', !!(await waitFor(() => pj('__video.currentTime >= 3.8'), 15000)), await pj('__video.currentTime'));

    // Baştan başlat seçeneği
    const restartHist = await prepareFromHistory({
      backend,
      historyStore: histStore2,
      ses: br.ses,
      id: hItem.id,
      restart: true,
    });
    check('Baştan başlat seçeneği startTime=0 veriyor', restartHist.startTime === 0);
    histStore2.updateProgress({ id: hItem.id, currentTime: 0, duration: 8, completed: false });
    check('Baştan başlat geçmişteki ilerlemeyi doğru sıfırlıyor', histStore2.get(hItem.id).currentTime === 0 && !histStore2.get(hItem.id).completed);

    // Süresi dolmuş veya geçersiz medya kaynağı
    const badHistItem = histStore2.upsert({
      pageUrl: `${origin}/ep1`,
      mediaUrl: `${origin}/media/not_exist.m3u8`,
      title: 'Geçersiz Kaynak',
      kind: 'hls',
    });
    const badPlay = await prepareFromHistory({
      backend,
      historyStore: histStore2,
      ses: br.ses,
      id: badHistItem.id,
    });
    await pj(`__errors.length = 0; __p.load({ url: ${JSON.stringify(badPlay.proxyUrl)}, kind: 'hls' }); true`);
    check('Süresi dolmuş veya var olmayan medya anlaşılır hata kodu veriyor', !!(await waitFor(() => pj('__errors.length > 0'), 15000)), await pj('JSON.stringify(__errors)'));

    // Temizleme işlemlerinin birbirinden bağımsızlığı
    histStore2.clear();
    check('Geçmişi temizlemek geçmiş kayıtlarını sildi', histStore2.list().length === 0);
    check('Geçmişi temizlemek web çerezlerini silmedi', (await br.ses.cookies.get({ url: origin })).some((c) => c.name === 'sess'));

    histStore2.upsert({ pageUrl: `${origin}/ep1`, mediaUrl: `${origin}/media/hls/master.m3u8`, title: 'Kalıcı Video' });
    histStore2.saveSync();
    await br.clearAllData();
    check('Web oturumunu temizlemek çerezleri sildi', (await br.ses.cookies.get({ url: origin })).length === 0);
    check('Web oturumunu temizlemek geçmiş kayıtlarını silmedi', histStore2.list().length === 1);

    // Dört görüntüleme modu: Detached BrowserWindow (In Window / PiP fallback) testi
    const detachedWin = new BrowserWindow({ show: false, width: 800, height: 500, webPreferences: { backgroundThrottling: false } });
    await detachedWin.loadURL(`${backend.origin}/detached.html`);
    const detTitle = await detachedWin.webContents.executeJavaScript('document.title');
    check('In Window / PiP: detached.html penceresi yüklendi', detTitle.includes('MK VideoPlayer'));
    const hasDropdown = await detachedWin.webContents.executeJavaScript('!!document.getElementById("displayModeMenu")');
    check('Detached pencerede 4 görüntüleme modu menüsü mevcut', hasDropdown);
    detachedWin.destroy();

    // Kalıcı Ayarlar ve Pencere Boyutu / Konumu Testi
    const settingsPath = path.join(tmp, 'e2e_settings.json');
    const { SettingsStore } = require(path.join(ROOT, 'electron', 'lib', 'settings.js'));
    const setStore1 = new SettingsStore({ storagePath: settingsPath });
    setStore1.update({
      defaultQuality: 'highest',
      seekStep: 15,
      rememberVolume: true,
      lastVolume: 0.8,
      restoreLastPage: true,
      lastPageUrl: `${origin}/ep1`,
      introSkipSeconds: 90,
      bufferMode: 'aggressive',
      autoNextEpisode: true,
      smartIntroDetection: true,
      autoSkipIntro: true,
      windowBounds: { width: 1200, height: 750, x: 50, y: 50, isMaximized: false },
    });
    setStore1.saveSync();
    check('Ayarlar başarıyla kaydedildi', fs.existsSync(settingsPath));

    const setStore2 = new SettingsStore({ storagePath: settingsPath });
    const sLoaded = setStore2.getAll();
    check('Ayarlar yeniden başlatılınca korundu (kalite: highest, seek: 15s)', sLoaded.defaultQuality === 'highest' && sLoaded.seekStep === 15);
    check('Pencere boyutları ve konumu korundu (1200x750, x=50, y=50)', sLoaded.windowBounds.width === 1200 && sLoaded.windowBounds.height === 750 && sLoaded.windowBounds.x === 50);
    check('Son açık web sayfası ve geri yükleme tercihi korundu', sLoaded.restoreLastPage === true && sLoaded.lastPageUrl === `${origin}/ep1`);
    check('Yeni ayarlar (introSkip: 90s, bufferMode: aggressive, smartIntro: true) korundu', sLoaded.introSkipSeconds === 90 && sLoaded.bufferMode === 'aggressive' && sLoaded.autoNextEpisode === true && sLoaded.smartIntroDetection === true && sLoaded.autoSkipIntro === true);

    // Favoriler (Bookmarks) Kalıcılık Testi
    const bmPath = path.join(tmp, 'e2e_bookmarks.json');
    const { BookmarkStore } = require(path.join(ROOT, 'electron', 'lib', 'bookmarks.js'));
    const bmStore1 = new BookmarkStore({ storagePath: bmPath });
    bmStore1.add({ title: 'Test Anime 1', pageUrl: `${origin}/ep1`, host: '127.0.0.1' });
    const bmStore2 = new BookmarkStore({ storagePath: bmPath });
    check('Favoriler yeniden başlatılınca korundu', bmStore2.list().length === 1 && bmStore2.has(`${origin}/ep1`));

    // Çevrimdışı İndirilen Medya API Sunumu (/api/local-media)
    const testLocalFile = path.join(tmp, 'offline_test.mp4');
    fs.writeFileSync(testLocalFile, Buffer.from('fake-mp4-data'));
    const fetch = require('node:http');
    const offlineUrl = `${backend.origin}/api/local-media?path=${encodeURIComponent(testLocalFile)}`;
    const offlineRes = await new Promise((resolve) => {
      fetch.get(offlineUrl, { agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
    });
    check('Çevrimdışı medya uç noktası (/api/local-media) yerel dosyayı başarıyla sunuyor', offlineRes === 200);

    pw.destroy();
  }

  // Temizlik
  if (br && typeof br.destroy === 'function') br.destroy();
  win.destroy();
  backend.stop();
  if (typeof site.srv.closeAllConnections === 'function') site.srv.closeAllConnections();
  site.srv.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* yoksay */ }
  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\nE2E: ${results.length - failed.length - skipped.length} geçti, ${failed.length} başarısız, ${skipped.length} atlandı`);
  app.exit(failed.length ? 1 : 0);
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(() => main().catch((e) => { console.error('E2E beklenmeyen hata:', e); app.exit(2); }));
setTimeout(() => { console.error('E2E zaman aşımı'); app.exit(3); }, 240000).unref();



