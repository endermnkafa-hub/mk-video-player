'use strict';
// Electron oturumuna (gömülü tarayıcının ağ yığınına) bağlanıp gerçek ağ isteklerini izler.
const { classifyResponseDetailed, hostOf } = require('../frontend/js/classify.js');
const { analyzeManifest } = require('./lib/m3u8.js');

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

/** Gömülü sayfanın uygulamanın yerel API sunucusuna istek atmasını engellemek için. */
function isLocalBackendUrl(url, backendPort) {
  try {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return LOOPBACK.has(u.hostname.toLowerCase()) && String(port) === String(backendPort);
  } catch (_) {
    return false;
  }
}

function pickHeaders(requestHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(requestHeaders || {})) {
    const l = k.toLowerCase();
    if (l === 'referer') out.referer = v;
    else if (l === 'origin') out.origin = v;
    else if (l === 'user-agent') out.userAgent = v;
  }
  return out; // Cookie/Authorization BİLEREK alınmaz
}

function attachCapture({ session, registry, backendPort, onMainFrameResponse }) {
  const headerStash = new Map();
  const selfFetch = new Set();

  session.webRequest.onBeforeRequest((d, cb) => {
    if (isLocalBackendUrl(d.url, backendPort)) { cb({ cancel: true }); return; }
    if (!selfFetch.has(d.url)) {
      registry.noteActivity('request');
      registry.beginRequest(d.id);
    }
    cb({});
  });

  session.webRequest.onBeforeSendHeaders((d, cb) => {
    // Başlıklar sayfa oturumu boyunca tamponlanır (kullanıcı algılamayı sonradan açarsa başlıklar hazır olsun)
    if (headerStash.size > 3000) headerStash.clear();
    headerStash.set(d.id, pickHeaders(d.requestHeaders));
    cb({ requestHeaders: d.requestHeaders });
  });

  session.webRequest.onResponseStarted((d) => {
    const token = registry.takeRequest(d.id);
    const reqHeaders = headerStash.get(d.id) || {};
    headerStash.delete(d.id);

    if (d.resourceType === 'mainFrame' && onMainFrameResponse) {
      onMainFrameResponse({ url: d.url, statusCode: d.statusCode });
    }
    if (selfFetch.has(d.url)) return;

    const detailed = classifyResponseDetailed({
      url: d.url,
      statusCode: d.statusCode,
      resourceType: d.resourceType,
      headers: d.responseHeaders,
    });

    if (!detailed.accepted) {
      registry.noteActivity('ignored');
      if (detailed.reason) registry.noteRejection(detailed.reason);
      return;
    }

    const cls = detailed.result;
    const frameUrl = d.frame && d.frame.url ? d.frame.url : (d.referrer || null);

    // Segment isteği yakalandı: segment sayacı artırılır ve referer üzerinden manifest aranır
    if (cls.role === 'segment') {
      registry.noteSegmentObserved({
        url: d.url,
        referer: reqHeaders.referer || d.referrer || null,
        requestHeaders: reqHeaders,
        frameUrl,
      });
      return;
    }

    // Oynatılabilir medya kaynağı (HLS / MP4 / vb.)
    registry.noteActivity('media');
    registry.offer({
      url: d.url,
      classification: cls,
      token,
      requestHeaders: reqHeaders,
      frameUrl,
    });
  });

  registry.onSourceAdded = (src) => {
    if (src.kind === 'hls' && src.availability === 'detected') {
      verifyManifest(src);
    } else if (src.availability === 'detected') {
      registry.setAvailability(src.id, 'verified'); // 2xx + video MIME döndü
    }
  };

  async function verifyManifest(src) {
    registry.setAvailability(src.id, 'checking');
    selfFetch.add(src.url);
    try {
      const headers = {};
      if (src.requestHeaders.referer) headers.Referer = src.requestHeaders.referer;
      if (src.requestHeaders.origin) headers.Origin = src.requestHeaders.origin;
      if (src.requestHeaders.userAgent) headers['User-Agent'] = src.requestHeaders.userAgent;
      else if (typeof session.getUserAgent === 'function') headers['User-Agent'] = session.getUserAgent();
      const resp = await session.fetch(src.url, { headers, credentials: 'include', signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        if (resp.status === 404 || resp.status === 410) {
          registry.setAvailability(src.id, 'failed', `http_${resp.status}`);
        } else {
          // 403 veya diğer durumlarda oynatıcı proxy üzerinden deneyebilsin
          registry.setAvailability(src.id, 'verified');
        }
        return;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_MANIFEST_BYTES) { registry.setAvailability(src.id, 'failed', 'manifest_too_large'); return; }
      registry.attachAnalysis(src.id, analyzeManifest(buf.toString('utf8'), resp.url || src.url));
    } catch (e) {
      const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      // Zaman aşımı veya ağ hatası durumunda oynatıcı proxy üzerinden deneyebilsin diye verified kabul edilir
      registry.setAvailability(src.id, 'verified');
    } finally {
      selfFetch.delete(src.url);
    }
  }

  return { hostOf, verifyManifest };
}

module.exports = { attachCapture, isLocalBackendUrl, pickHeaders };
