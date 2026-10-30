/* Medya URL/MIME sınıflandırma — hem Electron ana süreci hem arayüz kullanır (UMD).
 * Web sayfası URL'si, iframe URL'si, medya URL'si ve oynatılabilir kaynak AYRI kavramlardır;
 * burada yalnızca "bu ağ isteği bir medya kaynağı mı, hangi türde?" sorusu yanıtlanır. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MKClassify = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SEGMENT_EXT = ['.ts', '.m4s', '.aac', '.m4a', '.mp3', '.vtt', '.webvtt', '.srt', '.cmfv', '.cmfa', '.key'];
  const NOISE_RESOURCE_TYPES = new Set([
    'image', 'stylesheet', 'font', 'script', 'ping', 'cspReport', 'mainFrame', 'subFrame', 'webSocket',
  ]);
  const AD_HOST_PATTERNS = [
    /(^|\.)doubleclick\.net$/, /(^|\.)googlesyndication\.com$/, /(^|\.)google-analytics\.com$/,
    /(^|\.)googletagmanager\.com$/, /(^|\.)googleadservices\.com$/, /(^|\.)adservice\.google\./,
    /(^|\.)facebook\.net$/, /(^|\.)histats\.com$/, /(^|\.)popads\.net$/, /(^|\.)propellerads\.com$/,
    /(^|\.)adsterra\.com$/, /(^|\.)exoclick\.com$/, /(^|\.)taboola\.com$/, /(^|\.)outbrain\.com$/,
    /(^|\.)scorecardresearch\.com$/, /(^|\.)yandex\.ru$/, /(^|\.)hotjar\.com$/, /(^|\.)adnxs\.com$/,
    /(^|\.)criteo\.(com|net)$/, /(^|\.)amazon-adsystem\.com$/, /(^|\.)imasdk\.googleapis\.com$/,
    /(^|\.)ads?\./, /(^|\.)adserver\./, /(^|\.)analytics\./, /(^|\.)tracker\./,
  ];

  function safeUrl(url) {
    try { return new URL(url); } catch (_) { return null; }
  }

  /** Sorgu/parça kısmı olmadan küçük harfli yol. `?token=a.m3u8` gibi sorgular yolu bozmaz. */
  function urlPath(url) {
    const u = safeUrl(url);
    if (u) return u.pathname.toLowerCase();
    return String(url || '').split('#')[0].split('?')[0].toLowerCase();
  }

  function hostOf(url) {
    const u = safeUrl(url);
    return u ? u.hostname.toLowerCase() : '';
  }

  function schemeOf(url) {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(String(url || '').trim());
    return m ? m[1].toLowerCase() : '';
  }

  function kindFromUrl(url) {
    const scheme = schemeOf(url);
    if (scheme === 'blob') return 'blob';
    if (scheme === 'data') return 'data';
    if (scheme !== 'http' && scheme !== 'https') return null;
    const p = urlPath(url);
    if (p.endsWith('.m3u8') || p.endsWith('.m3u')) return 'hls';
    // Path içinde .m3u8 veya master.txt geçen rotalar (örn: .../stream.m3u8/subpath veya master.txt)
    if (p.includes('.m3u8') || p.includes('/m3u8') || p.endsWith('/master') || p.endsWith('/playlist') || p.includes('master.txt') || p.includes('playlist.txt')) return 'hls';
    if (p.endsWith('.mpd') || p.includes('.mpd')) return 'dash';
    if (p.endsWith('.mp4') || p.endsWith('.m4v')) return 'mp4';
    if (p.endsWith('.webm')) return 'webm';
    if (SEGMENT_EXT.some((e) => p.endsWith(e))) return 'segment';
    return null;
  }

  function kindFromMime(mime, url) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (!m) return null;
    if (['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'].includes(m)) return 'hls';
    if (m === 'application/dash+xml') return 'dash';
    if (m === 'video/mp4' || m === 'video/m4v') return 'mp4';
    if (m === 'video/webm') return 'webm';
    if (m === 'video/mp2t' || m === 'video/iso.segment' || m === 'audio/mp4' || m === 'audio/aac' || m === 'video/x-m4s') return 'segment';
    // application/octet-stream veya text/plain durumunda URL HLS ipucu içeriyorsa HLS kabul edilir
    if ((m === 'application/octet-stream' || m === 'text/plain') && url) {
      const p = urlPath(url);
      if (p.endsWith('.m3u8') || p.endsWith('.m3u') || p.includes('.m3u8') || p.includes('/hls/') || p.includes('/playlist')) {
        return 'hls';
      }
    }
    return null;
  }

  function isAdHost(host) {
    return AD_HOST_PATTERNS.some((re) => re.test(host));
  }

  /** `1280x720`, `720p`, `/1080/` gibi ipuçlarından yükseklik çıkarır (yalnızca ipucu). */
  function resolutionHint(url) {
    const p = urlPath(url);
    let m = /(?:^|[^0-9])(2160|1440|1080|720|480|360|240)p(?![a-z])/.exec(p);
    if (m) return Number(m[1]);
    m = /[/_-](2160|1440|1080|720|480|360|240)[/_.-]/.exec(p);
    return m ? Number(m[1]) : null;
  }

  function parseContentRangeTotal(value) {
    const m = /\/(\d+)\s*$/.exec(String(value || ''));
    return m ? Number(m[1]) : null;
  }

  function getHeader(headers, name) {
    if (!headers) return '';
    const lower = name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) {
        const v = headers[k];
        return Array.isArray(v) ? v[0] : v;
      }
    }
    return '';
  }

  /**
   * Bir tamamlanmış ağ yanıtını ayrıntılı sınıflandırır.
   * Dönüş: { accepted: boolean, reason?: string, result?: object }
   */
  function classifyResponseDetailed({ url, mimeType, statusCode, resourceType, headers }) {
    if (!url) return { accepted: false, reason: 'missing_url' };
    const scheme = schemeOf(url);
    if (scheme === 'blob' || scheme === 'data') return { accepted: false, reason: 'blob_or_data' };
    if (scheme !== 'http' && scheme !== 'https') return { accepted: false, reason: 'unsupported_scheme' };
    if (!(statusCode === 200 || statusCode === 206)) return { accepted: false, reason: `bad_status_${statusCode}` };
    const host = hostOf(url);
    if (isAdHost(host)) return { accepted: false, reason: 'ad_host' };

    const mime = mimeType || getHeader(headers, 'content-type');
    const byUrl = kindFromUrl(url);
    const byMime = kindFromMime(mime, url);
    const kind = byMime || byUrl;
    if (!kind) {
      if (NOISE_RESOURCE_TYPES.has(resourceType)) return { accepted: false, reason: 'noise_resource_type' };
      return { accepted: false, reason: 'not_media' };
    }
    // Görsel/stil/script gibi türlerden gelen yanıtlar medya değildir (örn. .ts içeren script yolu).
    if (NOISE_RESOURCE_TYPES.has(resourceType) && resourceType !== 'mainFrame') {
      return { accepted: false, reason: 'noise_resource_type' };
    }
    if (resourceType === 'mainFrame' || resourceType === 'subFrame') {
      return { accepted: false, reason: 'frame_html' };
    }
    if (kind === 'segment') {
      return { accepted: true, result: { role: 'segment', kind, url, host } };
    }
    // MIME yok/uyumsuz ise URL uzantısı tek başına yeterli sayılır ama MIME html ise değil.
    if (/^text\/html/i.test(String(mime || ''))) return { accepted: false, reason: 'html_content' };

    const res = { role: 'source', kind, host, supported: true, reason: null, mime: String(mime || '').split(';')[0] || null };
    if (kind === 'dash') {
      res.supported = false;
      res.reason = 'dash_unsupported';
    }
    res.resolutionHint = resolutionHint(url);
    res.sizeBytes = parseContentRangeTotal(getHeader(headers, 'content-range'))
      || (statusCode === 200 ? Number(getHeader(headers, 'content-length')) || null : null);
    return { accepted: true, result: res };
  }

  /**
   * Geriye dönük uyumlu sınıflandırıcı.
   * Dönüş: null (ilgisiz) | { role: 'segment' } | { role: 'source', kind, supported, reason, ... }
   */
  function classifyResponse(params) {
    const detailed = classifyResponseDetailed(params);
    return detailed.accepted ? detailed.result : null;
  }

  /** Adres çubuğuna yapıştırılan URL'nin ne olduğunu söyler: doğrudan medya mı, sayfa mı? */
  function classifyInput(raw) {
    const text = String(raw || '').trim();
    if (!text) return { type: 'empty' };
    let candidate = text;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
      if (/\s/.test(candidate) || !candidate.includes('.')) return { type: 'invalid' };
      candidate = 'https://' + candidate;
    }
    const u = safeUrl(candidate);
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname) return { type: 'invalid' };
    const kind = kindFromUrl(candidate);
    if (kind === 'hls' || kind === 'mp4' || kind === 'webm') return { type: 'media', kind, url: u.href };
    if (kind === 'dash') return { type: 'media', kind, url: u.href, supported: false };
    return { type: 'page', url: u.href };
  }

  /**
   * HLS kalite seviyeleri arasından kullanıcının kalite tercihine en uygun seviyeyi belirler.
   *
   * @param {Array<{index: number, height: number|null, bitrate: number|null}>} levels
   * @param {'auto'|'highest'|'lowest'|string} preference
   * @returns {number} HLS seviye indeksi veya otomatik için -1
   */
  function selectLevelByPreference(levels, preference) {
    if (!Array.isArray(levels) || levels.length === 0) return -1;
    const pref = (preference || 'auto').toLowerCase();

    if (pref === 'auto' || pref === '-1') return -1;

    if (pref === 'highest' || pref === 'max') {
      let best = levels[0];
      for (let i = 1; i < levels.length; i++) {
        const cur = levels[i];
        const curH = cur.height || 0;
        const bestH = best.height || 0;
        if (curH > bestH) {
          best = cur;
        } else if (curH === bestH && (cur.bitrate || 0) > (best.bitrate || 0)) {
          best = cur;
        }
      }
      return best.index !== undefined ? best.index : -1;
    }

    if (pref === 'lowest' || pref === 'min') {
      let lowest = levels[0];
      for (let i = 1; i < levels.length; i++) {
        const cur = levels[i];
        const curH = cur.height || Infinity;
        const lowH = lowest.height || Infinity;
        if (curH < lowH) {
          lowest = cur;
        } else if (curH === lowH && (cur.bitrate || Infinity) < (lowest.bitrate || Infinity)) {
          lowest = cur;
        }
      }
      return lowest.index !== undefined ? lowest.index : -1;
    }

    // Doğrudan seviye indeksi verilmişse (ör: '0', '1', '2')
    const directMatch = levels.find((l) => String(l.index) === String(pref));
    if (directMatch && directMatch.index !== undefined) return directMatch.index;

    const targetH = parseInt(pref, 10);
    if (Number.isFinite(targetH) && targetH > 0) {
      const match = levels.find((l) => l.height === targetH);
      if (match && match.index !== undefined) return match.index;
    }

    return -1;
  }

  return {
    urlPath, hostOf, schemeOf, kindFromUrl, kindFromMime, isAdHost, resolutionHint,
    classifyResponse, classifyResponseDetailed, classifyInput, getHeader,
    selectLevelByPreference,
  };
});
