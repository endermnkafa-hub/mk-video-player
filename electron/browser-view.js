'use strict';
// Gömülü Chromium tarayıcısı (WebContentsView) + kaynak izleme. main.js ve e2e testleri kullanır.
const { session, WebContentsView } = require('electron');
const { attachCapture } = require('./capture.js');
const { classifyInput, classifyResponseDetailed } = require('../frontend/js/classify.js');
const { netErrorCode, httpErrorCode } = require('../frontend/js/messages.js');

const INTERACTION_TYPES = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'touchStart']);
const MAX_BLOCKED_POPUPS = 20;

function isHttpUrl(url) {
  try { const p = new URL(url).protocol; return p === 'http:' || p === 'https:'; } catch (_) { return false; }
}

function getAdjacentEpisodeUrl(currentUrl, direction = 1) {
  if (!currentUrl || typeof currentUrl !== 'string') return null;
  try {
    const u = new URL(currentUrl);

    // 1. Sorgu parametrelerinde bölüm numarası arama (?ep=14, ?episode=14, ?bolum=14, ?b=14, ?part=14)
    for (const param of ['ep', 'episode', 'bolum', 'b', 'part', 'p']) {
      if (u.searchParams.has(param)) {
        const val = parseInt(u.searchParams.get(param), 10);
        if (Number.isFinite(val) && val + direction >= 1) {
          u.searchParams.set(param, String(val + direction));
          return u.toString();
        }
      }
    }

    // 2. Pathname içinde açık bölüm desenlerini (bolum/episode/ep) öncelikle arama
    const path = u.pathname;
    const explicitPatterns = [
      /([-_/](?:bolum|bolumu|episode|ep|part|b)[-_]?)(\d+)/i,
      /([-_/])(\d+)([-_]?(?:bolum|bolumu|episode|ep))/i,
    ];

    for (const pat of explicitPatterns) {
      const match = pat.exec(path);
      if (match) {
        const prefix = match[1];
        const numStr = match[2];
        const suffix = match[3] || '';
        const num = parseInt(numStr, 10);
        const targetNum = num + direction;
        if (targetNum >= 1) {
          const paddedTarget = String(targetNum).padStart(numStr.length, '0');
          const fullMatch = match[0];
          const newMatch = prefix + paddedTarget + suffix;
          u.pathname = path.replace(fullMatch, newMatch);
          return u.toString();
        }
      }
    }

    // 3. Genel fallback: Pathname içindeki son sayı öbeğini tespit etme
    const matches = Array.from(path.matchAll(/(\d+)/g));
    if (matches.length > 0) {
      // Yıl gibi duran 4 haneli sayıları (1970-2040) eğer öncesinde başka sayı varsa ele
      let targetMatch = matches[matches.length - 1];
      if (matches.length > 1 && targetMatch[0].length === 4) {
        const yr = parseInt(targetMatch[0], 10);
        if (yr >= 1970 && yr <= 2040) {
          targetMatch = matches[matches.length - 2];
        }
      }

      const num = parseInt(targetMatch[0], 10);
      const targetNum = num + direction;
      if (targetNum >= 1) {
        const paddedTarget = String(targetNum).padStart(targetMatch[0].length, '0');
        const start = targetMatch.index;
        const end = start + targetMatch[0].length;
        u.pathname = path.substring(0, start) + paddedTarget + path.substring(end);
        return u.toString();
      }
    }
  } catch (_) {}
  return null;
}

function createBrowser({ registry, backendPort, onState, onPopups, partition = 'persist:mk-player-browser' }) {
  // Kalıcı oturum: "persist:" önekiyle kullanıcı girişleri ve çerezler uygulama yeniden başlatıldığında korunur.
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  ses.setCertificateVerifyProc((request, callback) => {
    // 0: NET_OK (anime video barındırıcıları ve CDN'lerdeki sertifika uyumsuzluklarında akışın kesilmesini önler)
    callback(0);
  });

  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  const wc = view.webContents;
  // Normal Chromium kullanıcı aracısı (Electron/uygulama jetonları olmadan).
  ses.setUserAgent(wc.getUserAgent().replace(/\s?Electron\/\S+/i, '').replace(/\s?mk-video-player\/\S+/i, ''));

  const state = {
    url: '', title: '', loading: false, canGoBack: false, canGoForward: false,
    error: null, httpStatus: null,
  };
  const popups = { mode: 'block', blocked: [], counter: 0 };

  const pushState = () => {
    state.canGoBack = wc.navigationHistory.canGoBack();
    state.canGoForward = wc.navigationHistory.canGoForward();
    state.loading = wc.isLoading();
    state.title = wc.getTitle();
    try { onState && onState({ ...state }); } catch (_) { /* yoksay */ }
  };
  const pushPopups = () => {
    try { onPopups && onPopups({ mode: popups.mode, blocked: popups.blocked.map((b) => ({ ...b })) }); } catch (_) { /* yoksay */ }
  };

  attachCapture({
    session: ses, registry, backendPort,
    onMainFrameResponse: ({ url, statusCode }) => {
      if (url !== wc.getURL() && url !== state.url) return;
      state.httpStatus = statusCode;
      if (statusCode >= 400) state.error = { code: httpErrorCode(statusCode), status: statusCode, url };
      pushState();
    },
  });

  // --- Kullanıcı etkileşimi (sayfada tıklama/tuş yapıldığında) ---
  let probeTimer = null;
  const scheduleProbe = (delay = 350) => {
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(() => {
      probeActiveMedia().catch(() => {});
    }, delay);
  };

  wc.on('input-event', (_e, ev) => {
    if (ev && INTERACTION_TYPES.has(ev.type)) {
      registry.noteInteraction();
      scheduleProbe(350);
    }
  });

  registry.onNeedActiveProbe = () => {
    scheduleProbe(100);
  };

  // --- Sayfadaki video ve DOM oynatıcılarını güvenle sorgulama (ana çerçeve + iframe'ler) ---
  async function probeActiveMedia() {
    if (wc.isDestroyed()) return;
    try {
      const frames = (wc.mainFrame && Array.isArray(wc.mainFrame.framesInSubtree))
        ? wc.mainFrame.framesInSubtree
        : (wc.mainFrame ? [wc.mainFrame] : []);

      let hasAnyVideos = false;
      let hasAnyBlob = false;
      const directSources = new Set();

      const probeCode = `
        (() => {
          try {
            const results = [];
            const videos = Array.from(document.querySelectorAll('video'));
            for (const v of videos) {
              results.push({
                src: v.src || '',
                currentSrc: v.currentSrc || '',
                paused: v.paused,
                currentTime: v.currentTime,
              });
              for (const s of Array.from(v.querySelectorAll('source'))) {
                if (s.src) results.push({ src: s.src, currentSrc: s.src, paused: v.paused, currentTime: v.currentTime });
              }
            }
            return {
              hasVideos: videos.length > 0,
              hasBlob: results.some(r => (r.src && r.src.startsWith('blob:')) || (r.currentSrc && r.currentSrc.startsWith('blob:'))),
              directSources: results.map(r => r.currentSrc || r.src).filter(s => s && s.startsWith('http')),
            };
          } catch (_) {
            return { hasVideos: false, hasBlob: false, directSources: [] };
          }
        })()
      `;

      for (const frame of frames) {
        try {
          const info = await frame.executeJavaScript(probeCode, true);
          if (info) {
            if (info.hasVideos) hasAnyVideos = true;
            if (info.hasBlob) hasAnyBlob = true;
            if (Array.isArray(info.directSources)) {
              for (const s of info.directSources) directSources.add(s);
            }
          }
        } catch (_) {}
      }

      if (hasAnyVideos || hasAnyBlob) {
        registry.noteActiveVideo(true);
      }

      for (const srcUrl of directSources) {
        const cls = classifyResponseDetailed({
          url: srcUrl,
          statusCode: 200,
          resourceType: 'media',
          headers: {},
        });
        if (cls.accepted && cls.result.role === 'source') {
          registry.offer({
            url: srcUrl,
            classification: cls.result,
            token: { epoch: registry.epoch, interacted: true },
            requestHeaders: { referer: wc.getURL() },
            frameUrl: wc.getURL(),
            fromActiveStream: true,
            fromSegmentRecovery: true,
          });
        }
      }
    } catch (_) {
      /* cross-origin veya DOM erişiminde sessiz kal */
    }
  }

  // --- Gezinti ---
  wc.on('did-start-navigation', (details) => {
    const d = details && details.url !== undefined ? details : {};
    if (d.isMainFrame && !d.isSameDocument) {
      state.url = d.url;
      state.error = null;
      state.httpStatus = null;
      registry.resetForNavigation(d.url);
      pushState();
    }
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    let changedPath = false;
    try { changedPath = new URL(url).pathname !== new URL(state.url || url).pathname; } catch (_) { /* yoksay */ }
    state.url = url;
    if (changedPath) registry.resetForNavigation(url);
    pushState();
  });
  wc.on('did-navigate', (_e, url) => { state.url = url; pushState(); });
  wc.on('did-start-loading', pushState);
  wc.on('did-stop-loading', () => {
    pushState();
    probeActiveMedia();
  });
  wc.on('page-title-updated', pushState);
  wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // -3: iptal/yönlendirme
    state.error = { code: netErrorCode(errorDescription), detail: errorDescription, url: validatedURL };
    pushState();
  });
  wc.on('render-process-gone', () => {
    state.error = { code: 'load_failed', detail: 'render-process-gone' };
    pushState();
  });

  const blockNonHttp = (e, url) => { if (!isHttpUrl(url)) e.preventDefault(); };
  wc.on('will-navigate', (e, url) => blockNonHttp(e, url));
  wc.on('will-redirect', (e, url) => blockNonHttp(e, url));

  // --- Yeni pencereler: kontrollü ---
  wc.setWindowOpenHandler(({ url }) => {
    if (!isHttpUrl(url)) return { action: 'deny' };
    if (popups.mode === 'same-tab') {
      setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}); });
      return { action: 'deny' };
    }
    popups.counter += 1;
    popups.blocked.unshift({ id: popups.counter, url, host: safeHost(url) });
    popups.blocked.length = Math.min(popups.blocked.length, MAX_BLOCKED_POPUPS);
    pushPopups();
    return { action: 'deny' };
  });

  function safeHost(url) { try { return new URL(url).host; } catch (_) { return ''; } }

  const api = {
    view, wc, ses, state, popups,
    go(url) {
      if (isHttpUrl(url)) {
        wc.loadURL(url).catch(() => {});
        return { ok: true, url };
      }
      return this.navigate(url);
    },
    navigate(raw) {
      const c = classifyInput(raw);
      if (c.type === 'page') {
        wc.loadURL(c.url).catch(() => {});
      }
      return c;
    },
    back() { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); },
    forward() { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); },
    reload() { wc.reload(); },
    stop() { wc.stop(); },
    async getEpisodeNav(fallbackUrl = null) {
      if (wc.isDestroyed()) return { prev: null, next: null };
      let currentUrl = wc.getURL() || state.url;
      if ((!currentUrl || currentUrl === 'about:blank') && fallbackUrl && isHttpUrl(fallbackUrl)) {
        currentUrl = fallbackUrl;
      }
      let domNav = { prev: null, next: null };

      const frames = (wc.mainFrame && Array.isArray(wc.mainFrame.framesInSubtree))
        ? wc.mainFrame.framesInSubtree
        : (wc.mainFrame ? [wc.mainFrame] : []);

      const domScript = `(() => {
        try {
          let prev = null;
          let next = null;

          function toAbs(href) {
            if (!href || href.startsWith('javascript:') || href.startsWith('#')) return null;
            try { return new URL(href, window.location.href).href; } catch (_) { return href; }
          }

          // 1. Bağlantılar ve butonlar (class, rel, text, title, aria-label)
          const candidates = Array.from(document.querySelectorAll('a[href], button, [role="button"], [data-url], [data-href]'));
          for (const el of candidates) {
            const text = (el.innerText || el.textContent || '').trim().toLowerCase();
            const title = (el.getAttribute('title') || '').toLowerCase();
            const cls = (el.className || '').toLowerCase();
            const rel = (el.getAttribute('rel') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').toLowerCase();
            const rawHref = el.href || el.getAttribute('data-url') || el.getAttribute('data-href') || '';
            const href = toAbs(rawHref);
            if (!href) continue;

            const isNext = rel === 'next' || cls.includes('next') || cls.includes('sonraki') ||
              text.includes('sonraki') || text.includes('next') || text.includes('ileri') || text === '»' || text === '>' ||
              title.includes('sonraki') || title.includes('next') || aria.includes('sonraki') || aria.includes('next');

            const isPrev = rel === 'prev' || cls.includes('prev') || cls.includes('onceki') || cls.includes('önceki') ||
              text.includes('önceki') || text.includes('onceki') || text.includes('previous') || text.includes('geri') || text === '«' || text === '<' ||
              title.includes('önceki') || title.includes('onceki') || aria.includes('önceki') || aria.includes('previous');

            if (isNext && !next && !isPrev) {
              next = href;
            }
            if (isPrev && !prev && !isNext) {
              prev = href;
            }
          }

          // 2. Bölüm seçim kutuları (<select>)
          if (!next || !prev) {
            const selects = Array.from(document.querySelectorAll('select'));
            for (const sel of selects) {
              if (sel.options && sel.options.length > 1) {
                const curIdx = sel.selectedIndex;
                if (curIdx >= 0) {
                  if (!next && curIdx + 1 < sel.options.length) {
                    const opt = sel.options[curIdx + 1];
                    const val = toAbs(opt.value || opt.getAttribute('data-url'));
                    if (val) next = val;
                  }
                  if (!prev && curIdx - 1 >= 0) {
                    const opt = sel.options[curIdx - 1];
                    const val = toAbs(opt.value || opt.getAttribute('data-url'));
                    if (val) prev = val;
                  }
                }
              }
            }
          }

          return { prev, next };
        } catch (_) {
          return { prev: null, next: null };
        }
      })()`;

      for (const frame of frames) {
        try {
          const res = await frame.executeJavaScript(domScript, true);
          if (res) {
            if (!domNav.next && res.next) domNav.next = res.next;
            if (!domNav.prev && res.prev) domNav.prev = res.prev;
          }
          if (domNav.next && domNav.prev) break;
        } catch (_) {}
      }

      const urlNext = getAdjacentEpisodeUrl(currentUrl, 1) || (fallbackUrl ? getAdjacentEpisodeUrl(fallbackUrl, 1) : null);
      const urlPrev = getAdjacentEpisodeUrl(currentUrl, -1) || (fallbackUrl ? getAdjacentEpisodeUrl(fallbackUrl, -1) : null);

      return {
        prev: domNav.prev || urlPrev,
        next: domNav.next || urlNext,
        currentUrl,
      };
    },
    async goNextEpisode(fallbackUrl = null) {
      const nav = await this.getEpisodeNav(fallbackUrl);
      if (nav && nav.next) {
        const action = this.go(nav.next);
        return { ok: true, url: nav.next, action };
      }
      return { ok: false, error: 'no_next_episode' };
    },
    async goPrevEpisode(fallbackUrl = null) {
      const nav = await this.getEpisodeNav(fallbackUrl);
      if (nav && nav.prev) {
        const action = this.go(nav.prev);
        return { ok: true, url: nav.prev, action };
      }
      return { ok: false, error: 'no_prev_episode' };
    },
    probeActiveMedia,
    setPopupMode(mode) {
      popups.mode = mode === 'same-tab' ? 'same-tab' : 'block';
      pushPopups();
    },
    openBlockedPopup(id) {
      const item = popups.blocked.find((b) => b.id === id);
      if (!item || !isHttpUrl(item.url)) return false;
      popups.blocked = popups.blocked.filter((b) => b.id !== id);
      pushPopups();
      wc.loadURL(item.url).catch(() => {});
      return true;
    },
    getSessionInfo() {
      return {
        persistent: typeof partition === 'string' && partition.startsWith('persist:'),
        partition,
      };
    },
    async clearSiteData(target) {
      let origin = target;
      if (target && !target.startsWith('http://') && !target.startsWith('https://')) {
        origin = `https://${target}`;
      }
      try {
        await ses.clearStorageData({
          origin: origin || undefined,
          storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
        });
        if (ses.cookies && typeof ses.cookies.flushStore === 'function') {
          await ses.cookies.flushStore();
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    async clearAllData() {
      try {
        await ses.clearStorageData({
          storages: ['cookies', 'localstorage', 'indexdb', 'websql', 'serviceworkers', 'cachestorage'],
        });
        if (ses.cookies && typeof ses.cookies.flushStore === 'function') {
          await ses.cookies.flushStore();
        }
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    snapshot() { return { ...state, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward() }; },
    popupSnapshot() { return { mode: popups.mode, blocked: popups.blocked.map((b) => ({ ...b })) }; },
    destroy() { try { wc.close(); } catch (_) { /* yoksay */ } },
  };
  return api;
}

module.exports = { createBrowser, isHttpUrl, getAdjacentEpisodeUrl };
