'use strict';
// HLS manifest analizi: master/media ayrımı, kalite seviyeleri, şifreleme/DRM tespiti.
// Yalnızca bilgi çıkarır; DRM veya erişim kontrolünü aşmaya çalışmaz.

function parseAttributes(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  }
  return out;
}

function resolveUrl(base, ref) {
  try { return new URL(ref, base).href; } catch (_) { return null; }
}

function analyzeManifest(text, baseUrl) {
  let body = String(text || '').replace(/^\uFEFF/, '').trim();

  // Base64 kontrolü (AnizmPlayer / FirePlayer veya benzeri oynatıcılar manifesti base64 encode edebiliyor)
  if (!body.includes('#EXT') && /^[A-Za-z0-9+/=\r\n\s]+$/.test(body) && body.length > 20) {
    try {
      const decoded = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (decoded.includes('#EXTM3U') || decoded.includes('#EXTINF') || decoded.includes('#EXT-X-')) {
        body = decoded.trim();
      }
    } catch (_) {
      /* yoksay */
    }
  }

  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hasHlsSignature = body.includes('#EXTM3U') || body.includes('#EXTINF') || body.includes('#EXT-X-');
  if (!lines.length || !hasHlsSignature) {
    return { valid: false, reason: 'not_hls' };
  }
  const variants = [];
  const audioRenditions = [];
  let segmentCount = 0;
  let endList = false;
  let encryption = 'none';
  let drmReason = null;
  let pendingVariant = null;

  const noteKey = (attrs) => {
    const method = (attrs.METHOD || 'NONE').toUpperCase();
    const keyformat = (attrs.KEYFORMAT || 'identity').toLowerCase();
    if (method === 'NONE') return;
    if (method !== 'AES-128' || keyformat !== 'identity') {
      encryption = 'drm';
      drmReason = `${method}/${keyformat}`;
    } else if (encryption === 'none') {
      encryption = 'aes-128';
    }
  };

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      let width = null; let height = null;
      const rm = /^(\d+)x(\d+)$/i.exec(a.RESOLUTION || '');
      if (rm) { width = Number(rm[1]); height = Number(rm[2]); }
      pendingVariant = {
        bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH']) || null,
        width, height, codecs: a.CODECS || null, frameRate: Number(a['FRAME-RATE']) || null,
      };
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      if ((a.TYPE || '').toUpperCase() === 'AUDIO') audioRenditions.push({ name: a.NAME || null, language: a.LANGUAGE || null });
    } else if (line.startsWith('#EXT-X-KEY:') || line.startsWith('#EXT-X-SESSION-KEY:')) {
      noteKey(parseAttributes(line.slice(line.indexOf(':') + 1)));
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (line.startsWith('#')) {
      continue;
    } else if (pendingVariant) {
      variants.push({ ...pendingVariant, url: resolveUrl(baseUrl, line) });
      pendingVariant = null;
    } else {
      segmentCount += 1;
    }
  }

  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
  const type = variants.length ? 'master' : 'media';
  return {
    valid: true,
    type,
    variants,
    audioRenditions,
    segmentCount,
    live: type === 'media' ? !endList : false,
    encryption,
    drm: encryption === 'drm',
    drmReason,
    maxHeight: variants.reduce((m, v) => Math.max(m, v.height || 0), 0) || null,
  };
}

module.exports = { analyzeManifest, parseAttributes };
