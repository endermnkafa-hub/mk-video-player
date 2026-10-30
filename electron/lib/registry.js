'use strict';
// Kaynak kayıt defteri: algılanan medya kaynaklarını, sayfa dönemini (epoch),
// son medya adayları tamponunu ve tanılama sayaçlarını yönetir.

const MAX_SOURCES = 50;
const MAX_PENDING_REQUESTS = 3000;
const MAX_RECENT_BUFFER = 50;

class SourceRegistry {
  constructor({ onChange } = {}) {
    this.onChange = onChange || (() => {});
    this.epoch = 0;
    this.armed = false;
    this.interacted = false;
    this.pageUrl = '';
    this.sources = new Map();
    this.hiddenUrls = new Set();
    this.pending = new Map();
    this.recentCandidates = []; // Bu sayfa döneminde görülen medya istekleri tamponu
    this.counter = 0;
    this.activity = this._freshActivity();
    this.rejections = this._freshRejections();
    this.activeVideoFound = false;
    this.segmentsSeenWithoutSource = 0;
  }

  _freshActivity() {
    return { requests: 0, mediaRequests: 0, segments: 0, ignored: 0 };
  }

  _freshRejections() {
    return {
      ad_host: 0,
      noise_resource_type: 0,
      bad_status: 0,
      not_media: 0,
      stale_page: 0,
      before_selection: 0,
      html_content: 0,
    };
  }

  _emit() {
    try {
      this.onChange(this.snapshot());
    } catch (_) {
      /* arayüz hatası kaydı bozmasın */
    }
  }

  start() {
    this.armed = true;
    // Eğer sayfada video segmentleri akıyorsa veya aktif video tespit edildiyse,
    // o segmentlerin ait olduğu tamponlanmış kaynağı hemen açığa çıkar
    if (this.activity.segments > 0 || this.activeVideoFound) {
      this._flushActiveStreamCandidates();
    }
    this._emit();
  }

  stop() {
    this.armed = false;
    this._emit();
  }

  /** Ana çerçeve gezintisi: önceki sayfanın kaynakları ve seçim durumu tamamen sıfırlanır. */
  resetForNavigation(url) {
    this.epoch += 1;
    this.pageUrl = url || '';
    this.interacted = false;
    this.sources = new Map();
    this.hiddenUrls = new Set();
    this.pending = new Map();
    this.recentCandidates = [];
    this.activity = this._freshActivity();
    this.rejections = this._freshRejections();
    this.activeVideoFound = false;
    this.segmentsSeenWithoutSource = 0;
    this._emit();
  }

  /** Kullanıcı gömülü sayfada fare/klavye ile etkileşti: armed olsun/olmasın bu sayfa için kaydedilir. */
  noteInteraction() {
    if (this.interacted) return false;
    this.interacted = true;
    this._emit();
    return true;
  }

  /** DOM incelemesinde sayfada aktif bir video oynatıcı (örn. blob: veya video etiketi) bulunduğunda */
  noteActiveVideo(found = true) {
    this.activeVideoFound = !!found;
    if (found && this.armed) {
      this._flushActiveStreamCandidates();
    }
    this._emit();
  }

  /** İstek başlarken çağrılır; isteğin hangi sayfa döneminde başladığını mühürler. */
  beginRequest(requestId) {
    if (this.pending.size >= MAX_PENDING_REQUESTS) this.pending.clear();
    const token = {
      epoch: this.epoch,
      interacted: this.interacted,
    };
    this.pending.set(requestId, token);
    return token;
  }

  takeRequest(requestId) {
    const t = this.pending.get(requestId);
    this.pending.delete(requestId);
    return t || null;
  }

  noteActivity(kind) {
    if (kind === 'request') this.activity.requests += 1;
    else if (kind === 'segment') {
      this.activity.segments += 1;
      if (this.list().length === 0) {
        this.segmentsSeenWithoutSource += 1;
      }
    }
    else if (kind === 'media') this.activity.mediaRequests += 1;
    else if (kind === 'ignored') this.activity.ignored += 1;
  }

  noteRejection(reason) {
    if (this.rejections[reason] !== undefined) {
      this.rejections[reason] += 1;
    } else if (String(reason).startsWith('bad_status')) {
      this.rejections.bad_status += 1;
    } else {
      this.rejections.not_media += 1;
    }
  }

  /** Segment isteği gözlemlendiğinde: Referer veya tampon üzerinden ana manifesti kurtarma */
  noteSegmentObserved({ url, referer, requestHeaders, frameUrl }) {
    this.noteActivity('segment');
    const segHost = safeHost(url);

    // 1. Eğer Referer doğrudan bir .m3u8 manifesti ise, doğrudan kaynak olarak sun
    if (referer && (referer.includes('.m3u8') || referer.includes('/hls/'))) {
      const cls = {
        role: 'source',
        kind: 'hls',
        host: safeHost(referer),
        supported: true,
        reason: null,
        mime: 'application/vnd.apple.mpegurl',
        resolutionHint: null,
        sizeBytes: null,
      };
      this.offer({
        url: referer,
        classification: cls,
        token: { epoch: this.epoch, interacted: true },
        requestHeaders: requestHeaders || { referer: frameUrl || this.pageUrl },
        frameUrl,
        fromActiveStream: true,
        fromSegmentRecovery: true,
      });
      return;
    }

    // 2. Eğer henüz hiçbir oynatılabilir kaynak listelenmemişse ve tamponda bu segmentle ilişkili aday varsa kurtar
    if (this.armed && this.list().length === 0 && this.recentCandidates.length > 0) {
      const match = this.recentCandidates.find((c) => {
        const cHost = safeHost(c.url);
        if (cHost && segHost && cHost === segHost) return true;
        if (referer && (safeHost(referer) === cHost || c.url.includes(referer))) return true;
        const segPath = safePathDir(url);
        const candPath = safePathDir(c.url);
        if (segPath && candPath && (segPath.startsWith(candPath) || candPath.startsWith(segPath))) return true;
        return this.recentCandidates.length === 1;
      });
      if (match) {
        this.offer({
          url: match.url,
          classification: match.classification,
          token: { epoch: this.epoch, interacted: true },
          requestHeaders: match.requestHeaders || requestHeaders,
          frameUrl: match.frameUrl || frameUrl,
          fromActiveStream: true,
          fromSegmentRecovery: true,
        });
        return;
      }
    }

    // 3. Eğer tamponda hiç aday yoksa ama segment akışı devam ediyorsa,
    // ve aktif DOM probe yapılmadıysa probe'u tetikle
    if (this.armed && this.list().length === 0 && typeof this.onNeedActiveProbe === 'function') {
      try { this.onNeedActiveProbe(); } catch (_) {}
    }
  }

  /**
   * Sınıflandırılmış bir yanıtı kayda sunar veya tampona alır.
   * @returns {{status: string, source?: object}}
   */
  offer({ url, classification, token, requestHeaders, frameUrl, fromActiveStream = false, fromSegmentRecovery = false }) {
    if (!token || token.epoch !== this.epoch) {
      this.noteRejection('stale_page');
      return { status: 'ignored_stale_page' };
    }
    if (!classification || classification.role !== 'source') {
      return { status: 'ignored_not_source' };
    }

    // Adayı mevcut sayfanın tamponuna ekle
    this._pushRecentCandidate({ url, classification, token, requestHeaders, frameUrl });

    if (!this.armed) {
      return { status: 'ignored_not_armed' };
    }

    // Kullanıcı etkileşimi kontrolü:
    // İzin verilen durumlar:
    // - İstek etkileşimden sonra başlatılmışsa (token.interacted)
    // - Segment akışıyla veya aktif oynatıcıyla kanıtlanmış bir yayından kurtarılmışsa
    const isRecovered = fromActiveStream || fromSegmentRecovery;
    const allowed = isRecovered || (token && token.interacted);
    if (!allowed) {
      this.noteRejection('before_selection');
      return { status: 'ignored_before_selection' };
    }

    for (const s of this.sources.values()) {
      if (s.url === url) return { status: 'duplicate', source: s };
    }
    if (this.sources.size >= MAX_SOURCES) return { status: 'ignored_limit' };

    this.counter += 1;
    const source = {
      id: `e${this.epoch}-s${this.counter}`,
      epoch: this.epoch,
      url,
      kind: classification.kind,
      host: classification.host,
      mime: classification.mime,
      resolutionHint: classification.resolutionHint || null,
      sizeBytes: classification.sizeBytes || null,
      availability: classification.supported ? 'detected' : 'unsupported',
      reason: classification.reason || null,
      playability: 'unknown',
      playError: null,
      hidden: this.hiddenUrls.has(url),
      frameUrl: frameUrl || null,
      pageUrl: this.pageUrl,
      variants: [],
      maxHeight: null,
      encryption: null,
      live: null,
      requestHeaders: requestHeaders || {},
      recovered: isRecovered,
    };
    this.sources.set(source.id, source);
    this.segmentsSeenWithoutSource = 0;
    if (typeof this.onSourceAdded === 'function') {
      try { this.onSourceAdded(source); } catch (_) {}
    }
    this._emit();
    return { status: 'added', source };
  }

  _pushRecentCandidate({ url, classification, token, requestHeaders, frameUrl }) {
    if (this.recentCandidates.some((c) => c.url === url)) return;
    if (this.recentCandidates.length >= MAX_RECENT_BUFFER) {
      this.recentCandidates.shift();
    }
    const interacted = token ? !!token.interacted : this.interacted;
    this.recentCandidates.push({
      url,
      classification,
      requestHeaders,
      frameUrl,
      interacted,
    });
  }

  _flushActiveStreamCandidates() {
    if (!this.armed) return;
    // Segment akışı, aktif DOM videosu veya kullanıcı etkileşimi varsa tamponlanmış medya adaylarını açığa çıkar
    for (const cand of [...this.recentCandidates]) {
      this.offer({
        url: cand.url,
        classification: cand.classification,
        token: { epoch: this.epoch, interacted: true },
        requestHeaders: cand.requestHeaders,
        frameUrl: cand.frameUrl,
        fromActiveStream: true,
        fromSegmentRecovery: true,
      });
    }
  }

  get(id) {
    const s = this.sources.get(id);
    return s && s.epoch === this.epoch ? s : null;
  }

  setAvailability(id, availability, reason) {
    const s = this.get(id);
    if (!s) return;
    s.availability = availability;
    s.reason = reason || null;
    this._emit();
  }

  /** Manifest analizi sonucunu işler; master'ın alt oynatma listeleri ayrı kaynak olarak gösterilmez. */
  attachAnalysis(id, analysis) {
    const s = this.get(id);
    if (!s) return;
    if (!analysis || !analysis.valid) {
      // Manifest analizi (örneğin özel başlıklar, bot koruması veya standart dışı format nedeniyle)
      // varyantları ayrıştıramasa bile, aktif bir yayından gelen kaynak oynatılabilir tutulur.
      if (s.availability === 'checking' || s.availability === 'detected') {
        s.availability = 'verified';
        s.reason = null;
      }
    } else {
      s.encryption = analysis.encryption;
      s.live = analysis.live;
      s.variants = (analysis.variants || []).map((v) => ({ height: v.height, width: v.width, bandwidth: v.bandwidth }));
      s.maxHeight = analysis.maxHeight || null;
      if (analysis.drm) {
        s.availability = 'unsupported';
        s.reason = 'drm_protected';
      } else {
        s.availability = 'verified';
        s.reason = null;
      }
      if (analysis.type === 'master') {
        for (const v of analysis.variants) {
          if (!v.url) continue;
          this.hiddenUrls.add(v.url);
          for (const other of this.sources.values()) if (other.url === v.url) other.hidden = true;
        }
      }
    }
    this._emit();
  }

  setPlayback(id, playability, error) {
    const s = this.get(id);
    if (!s) return;
    s.playability = playability;
    s.playError = error || null;
    this._emit();
  }

  publicView(s) {
    const { requestHeaders, ...rest } = s; // başlıklar arayüze geçmez
    return rest;
  }

  list() {
    return [...this.sources.values()].filter((s) => !s.hidden).map((s) => this.publicView(s));
  }

  _computeDiagnostics() {
    const sourcesCount = this.list().length;
    let statusText = '';
    let stage = 'idle';

    if (!this.armed) {
      statusText = 'Kaynak algılama kapalı. Yukarıdaki butondan başlatın.';
      stage = 'not_armed';
    } else if (sourcesCount > 0) {
      statusText = `${sourcesCount} adet oynatılabilir medya kaynağı algılandı.`;
      stage = 'ready';
    } else if (this.activity.segments > 0) {
      statusText = `Medya akışı (segmentler) algılanıyor (${this.activity.segments} segment). Oynatıcı manifesti çözümleniyor...`;
      stage = 'recovering_stream';
    } else if (this.activeVideoFound) {
      statusText = 'Sayfada video oynatıcı tespit edildi. Medya istekleri bekleniyor...';
      stage = 'player_detected';
    } else if (this.interacted) {
      statusText = 'Kullanıcı seçimi algılandı. Medya istekleri izleniyor...';
      stage = 'listening';
    } else {
      statusText = 'Dinleniyor: Sayfadan bir video kaynağı veya çeviri seçin.';
      stage = 'awaiting_selection';
    }

    return {
      stage,
      statusText,
      armed: this.armed,
      interacted: this.interacted,
      hasSegmentsWithoutManifest: this.activity.segments > 0 && sourcesCount === 0,
      activeVideoFound: this.activeVideoFound,
      rejections: { ...this.rejections },
    };
  }

  snapshot() {
    return {
      armed: this.armed,
      interacted: this.interacted,
      epoch: this.epoch,
      pageUrl: this.pageUrl,
      activity: { ...this.activity },
      diagnostics: this._computeDiagnostics(),
      sources: this.list(),
    };
  }
}

function safeHost(url) {
  try { return new URL(url).host; } catch (_) { return ''; }
}

function safePathDir(url) {
  try {
    const p = new URL(url).pathname;
    const lastSlash = p.lastIndexOf('/');
    return lastSlash >= 0 ? p.slice(0, lastSlash + 1) : p;
  } catch (_) {
    return '';
  }
}

module.exports = { SourceRegistry, MAX_SOURCES };
