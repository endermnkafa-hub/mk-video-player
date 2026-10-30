'use strict';
// Kullanıcının seçtiği kaynağı oynatıcıya hazırlar: yalnızca o kaynak için gerekli başlıklar
// ve çerezler arka uca BELLEK içi oturum olarak aktarılır. Hiçbiri loglanmaz/diske yazılmaz.
const { classifyInput } = require('../frontend/js/classify.js');

function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function preparePlayback({ backend, registry, ses, id, pageTitle }) {
  const src = registry.get(id);
  if (!src) return { ok: false, code: 'stale_source' };
  if (src.availability === 'unsupported') return { ok: false, code: src.reason || 'unsupported' };
  if (src.availability === 'failed') return { ok: false, code: src.reason || 'network_error' };
  let cookie = '';
  try { cookie = cookieHeader(await ses.cookies.get({ url: src.url })); } catch (_) { /* çerezsiz dene */ }
  const h = src.requestHeaders || {};
  let origin = h.origin;
  if (!origin && h.referer) { try { origin = new URL(h.referer).origin; } catch (_) { /* yoksay */ } }
  try {
    const r = await backend.post('/api/sessions', {
      url: src.url,
      referer: h.referer || src.frameUrl || src.pageUrl || null,
      origin: origin || null,
      user_agent: h.userAgent || ses.getUserAgent(),
      cookie: cookie || null,
    });
    return {
      ok: true, sid: r.sid, proxyUrl: r.proxy_url, sourceId: src.id, kind: src.kind,
      live: src.live, title: pageTitle || src.host, host: src.host,
      pageUrl: src.pageUrl || null,
      rawUrl: src.url,
      headers: {
        referer: h.referer || src.frameUrl || src.pageUrl || null,
        origin: origin || null,
        userAgent: h.userAgent || ses.getUserAgent(),
      },
    };
  } catch (e) {
    return { ok: false, code: e.code || 'connection_error' };
  }
}

function safeHost(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

/** Geçmişten videoyu orijinal web sayfasına gitmeden doğrudan oynatır */
async function prepareFromHistory({ backend, historyStore, ses, id, restart = false }) {
  const item = historyStore.get(id);
  if (!item) return { ok: false, code: 'stale_source' };
  if (!item.mediaUrl) return { ok: false, code: 'invalid_source', pageUrl: item.pageUrl };

  let cookie = '';
  if (ses && ses.cookies) {
    try {
      cookie = cookieHeader(await ses.cookies.get({ url: item.mediaUrl }));
    } catch (_) { /* çerezsiz devam */ }
  }

  const h = item.headers || {};
  let origin = h.origin;
  if (!origin && h.referer) {
    try { origin = new URL(h.referer).origin; } catch (_) {}
  }

  try {
    const r = await backend.post('/api/sessions', {
      url: item.mediaUrl,
      referer: h.referer || item.pageUrl || null,
      origin: origin || null,
      user_agent: h.userAgent || (ses ? ses.getUserAgent() : 'MKPlayer/2.0'),
      cookie: cookie || null,
    });
    return {
      ok: true,
      sid: r.sid,
      proxyUrl: r.proxy_url,
      historyId: item.id,
      kind: item.kind,
      live: false,
      title: item.title,
      host: item.provider || safeHost(item.mediaUrl) || 'Web',
      startTime: restart ? 0 : (item.currentTime || 0),
      duration: item.duration,
      pageUrl: item.pageUrl,
      // Güvenlik: Çözülmüş tam medya URL'si renderer tarafına sızdırılmaz
    };
  } catch (e) {
    return { ok: false, code: e.code || 'connection_error', pageUrl: item.pageUrl };
  }
}

/** Adres çubuğuna doğrudan medya URL'si yapıştırıldığında (kullanıcı açıkça istedi). */
async function prepareDirect({ backend, url }) {
  const c = classifyInput(url);
  if (c.type !== 'media') return { ok: false, code: c.type === 'empty' ? 'empty_url' : 'invalid_url' };
  if (c.supported === false) return { ok: false, code: 'dash_unsupported' };
  try {
    const r = await backend.post('/api/sessions', { url: c.url });
    return { ok: true, sid: r.sid, proxyUrl: r.proxy_url, sourceId: null, kind: c.kind, title: 'Doğrudan akış', host: new URL(c.url).host, rawUrl: c.url };
  } catch (e) {
    return { ok: false, code: e.code || 'connection_error' };
  }
}

module.exports = { preparePlayback, prepareFromHistory, prepareDirect, cookieHeader };
