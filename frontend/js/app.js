/* MK VideoPlayer arayüz kabuğu. Tüm uzak veriler textContent/güvenli DOM ile gösterilir. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const mk = window.mk || null;
  const { describe } = window.MKMessages;

  const video = $('videoElement');
  const playerContainer = $('playerContainer');
  const progressBar = $('progressBar');
  const toastEl = $('playerToast');
  const modeMenu = $('displayModeMenu');
  const quickSettingsMenu = $('playerQuickSettingsMenu');

  const state = {
    activeSourceId: null,
    activeSid: null,
    activeHistoryId: null,
    pendingStartTime: 0,
    lastPageUrl: null,
    sources: [],
    capture: null,
    nav: null,
    layout: 'discover',
    discover: {
      activeGenre: 'all',
      activeFormat: 'all',
      currentQuery: '',
      list: [],
      loading: false,
      selectedAnime: null,
      provider: 'anizm_direct',
    },
    activeResumeKey: null,
    history: [],
    historyQuery: '',
    historyFilter: 'all',
    historyCollapsed: false,
    bookmarks: [],
    bookmarkQuery: '',
    downloads: [],
    currentIntro: null,
    introSkipped: false,
    energySamples: [],
    lastEnergySampleTime: 0,
    activeTab: 'streams',
    displayMode: 'normal', // 'fullscreen' | 'in_window' | 'pip' | 'normal'
    subtitles: {
      currentTrack: 'off',
      size: 'md',
    },
    enhancer: {
      mode: 'none',
      aspectRatio: 'auto',
    },
    settings: {
      defaultQuality: 'auto',
      defaultSpeed: 1.0,
      seekStep: 10,
      autoplay: true,
      rememberVolume: true,
      lastVolume: 1.0,
      lastMuted: false,
      audioBoost: 100,
      introSkipSeconds: 85,
      outroSkipSeconds: 85,
      smartIntroDetection: true,
      autoSkipIntro: false,
      autoNextEpisode: true,
      bufferMode: 'balanced',
      rememberWindowBounds: true,
      defaultLayout: 'discover',
    },
  };

  // ---------- yardımcılar ----------
  let toastTimer = null;
  function showToast(msg, ms = 3000) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }
  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const s = Math.floor(sec); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  }
  function showError(code, { retry = false, backToPage = false, fallback } = {}) {
    $('errorText').textContent = describe(code, fallback);
    $('btnRetry').classList.toggle('hidden', !retry);
    $('btnBackToPage').classList.toggle('hidden', !backToPage);
    $('errorBanner').classList.remove('hidden');
  }
  function hideError() { $('errorBanner').classList.add('hidden'); }

  // ---------- oynatıcı ----------
  const qualitySelector = $('qualitySelector');

  function applyQualityPreference(pref) {
    if (!state.currentLevels || state.currentLevels.length === 0) return -1;
    const p = pref || (state.settings && state.settings.defaultQuality) || 'auto';
    const targetLvl = (window.MKClassify && typeof window.MKClassify.selectLevelByPreference === 'function')
      ? window.MKClassify.selectLevelByPreference(state.currentLevels, p)
      : -1;

    player.setQuality(targetLvl);

    if (qualitySelector) {
      if (p === 'highest' || p === 'lowest') {
        const opt = Array.from(qualitySelector.options).find((o) => o.value === p);
        qualitySelector.value = opt ? p : (targetLvl === -1 ? '-1' : String(targetLvl));
      } else if (targetLvl === -1 || p === 'auto' || p === '-1') {
        qualitySelector.value = '-1';
      } else {
        qualitySelector.value = String(targetLvl);
      }
    }

    const l = state.currentLevels.find((lvl) => lvl.index === targetLvl);
    const prefLabel = p === 'highest' ? 'En Yüksek' : (p === 'lowest' ? 'En Düşük' : (targetLvl === -1 ? 'Otomatik' : `${l ? l.height : '?'}p`));
    if (l && l.height && targetLvl !== -1) {
      showToast(`Kalite (${prefLabel}): ${l.height}p`);
    } else if (targetLvl === -1) {
      showToast('Kalite: Otomatik');
    }
    return targetLvl;
  }

  function setQualities(levels) {
    state.currentLevels = levels || [];
    const opts = [new Option('Kalite: Otomatik', '-1')];
    if (levels && levels.length > 0) {
      opts.push(new Option('En Yüksek Kalite', 'highest'));
      opts.push(new Option('En Düşük Kalite', 'lowest'));
      levels.forEach((l) => {
        opts.push(new Option(`${l.height || '?'}p${l.bitrate ? ` (${Math.round(l.bitrate / 1000)} kbps)` : ''}`, String(l.index)));
      });
    }
    qualitySelector.replaceChildren(...opts);

    // Kullanıcının varsayılan kalite tercihini uygula
    if (levels && levels.length > 0) {
      const pref = (state.settings && state.settings.defaultQuality) || 'auto';
      applyQualityPreference(pref);
    }
  }

  const player = window.MKPlayer.createPlayer({
    video,
    Hls: window.Hls || null, // yüklenmediyse uygulama bozulmaz, anlaşılır hata gösterilir
    bufferMode: (state.settings && state.settings.bufferMode) || 'balanced',
    onToast: showToast,
    onQualities: setQualities,
    onSubtitleTracks: (tracks) => {
      hlsSubtitleTracks = tracks || [];
      updateSubtitleTracksUI();
    },
    onError: ({ code }) => {
      if (mk && state.activeSourceId) mk.reportPlayback(state.activeSourceId, false, code);
      showError(code, { retry: true, backToPage: true });
      $('currentStreamInfo').textContent = 'Oynatılamadı — aşağıdaki hata mesajına bakın.';
    },
  });

  video.addEventListener('loadeddata', () => {
    if (mk && state.activeSourceId) mk.reportPlayback(state.activeSourceId, true, '');
    hideError();
    if (mk && typeof mk.detectIntro === 'function' && (!state.currentIntro || !state.currentIntro.found) && video.duration > 0) {
      const bestTitle = (state.nav && state.nav.title && !state.nav.title.includes('MK VideoPlayer'))
        ? state.nav.title
        : ($('currentVideoTitle').textContent || '');
      mk.detectIntro({
        pageTitle: bestTitle,
        pageUrl: state.lastPageUrl || (state.nav && state.nav.url) || '',
        streamTitle: $('currentVideoTitle').textContent || '',
        duration: video.duration,
      }).then((introData) => {
        if (introData && introData.found) {
          state.currentIntro = introData;
        }
      }).catch(() => {});
    }
  });

  function resumeKey(url) { try { const u = new URL(url); return `mk_pos_${u.host}${u.pathname}`; } catch (_) { return null; } }
  function savePosition() {
    const key = state.activeResumeKey;
    if (!key || !(video.duration > 10)) return;
    if (video.currentTime > 5 && video.currentTime < video.duration - 10) localStorage.setItem(key, String(video.currentTime));
    else if (video.currentTime >= video.duration - 10) localStorage.removeItem(key);
  }

  function saveWatchProgress() {
    savePosition();
    if (!mk || !state.activeHistoryId) return;
    const cur = video.currentTime;
    const dur = video.duration;
    if (!Number.isFinite(cur) || cur < 0) return;
    // Eğer henüz hedef başlangıç zamanına atlanmadıysa (başlangıçta video 0 saniyedeyken) geçmişi sıfırlama
    if (state.pendingStartTime && state.pendingStartTime > 5 && cur < 2) return;
    if (cur >= (state.pendingStartTime || 0) - 2) {
      state.pendingStartTime = 0;
    }
    const isCompleted = video.ended || (Number.isFinite(dur) && dur > 10 && cur >= dur - 15);
    mk.saveProgress({
      id: state.activeHistoryId,
      currentTime: cur,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null,
      completed: isCompleted,
    });
  }

  setInterval(() => {
    if (!video.paused && !video.ended) {
      saveWatchProgress();
    }
  }, 3000);

  async function loadHistory() {
    if (!mk) return;
    try {
      const items = await mk.getHistory({ query: state.historyQuery, filter: state.historyFilter });
      state.history = items || [];
      renderHistoryList();
    } catch (_) {}
  }

  function renderHistoryList() {
    const listEl = $('historyList');
    const emptyEl = $('historyEmpty');
    const badge = $('historyCountBadge');
    const settingsBadge = $('settingsHistoryCount');

    if (badge) badge.textContent = String(state.history.length);
    if (settingsBadge) settingsBadge.textContent = `${state.history.length} kayıt`;

    if (emptyEl) {
      emptyEl.classList.toggle('hidden', state.history.length > 0);
    }

    if (listEl) {
      window.MKRender.renderHistory(listEl, state.history, {
        onResume: (item) => playHistoryItem(item.id, false),
        onRestart: (item) => playHistoryItem(item.id, true),
        onDelete: async (item) => {
          if (!mk) return;
          await mk.deleteHistory(item.id);
          showToast('Kayıt geçmişten silindi');
          loadHistory();
        },
        onOpenPage: (item) => {
          if (!mk || !item.pageUrl) return;
          mk.go(item.pageUrl);
          setLayout('split');
        },
      });
    }
  }

  async function playHistoryItem(id, restart = false) {
    if (!mk) return;
    saveWatchProgress(); // eski oynatılanın ilerlemesini diske yaz
    $('currentStreamInfo').textContent = 'Geçmişten kaynak yükleniyor…';
    hideError();

    const res = await mk.playHistory({ id, restart });
    if (!res || !res.ok) {
      state.lastPageUrl = (res && res.pageUrl) || null;
      showError((res && res.code) || 'connection_error', {
        retry: true,
        backToPage: !!state.lastPageUrl,
        fallback: 'Kaynak artık kullanılamıyor veya süresi dolmuş. Orijinal sayfayı açarak kaynağı yenileyebilirsiniz.',
      });
      return;
    }

    state.lastPageUrl = res.pageUrl || null;
    playResult(res, {
      resumeUrl: res.rawUrl || res.pageUrl || res.proxyUrl,
      startTime: res.startTime,
      historyId: res.historyId,
    });
  }

  async function playResult(res, meta = {}) {
    saveWatchProgress();
    if (state.activeSid && mk) mk.releaseSession(state.activeSid); // eski oturumu temizle
    state.activeSid = res.sid;
    state.activeSourceId = res.sourceId || null;
    state.activeHistoryId = res.historyId || meta.historyId || null;
    state.lastPageUrl = res.pageUrl || meta.pageUrl || state.lastPageUrl;
    const candResumeUrl = meta.resumeUrl || res.rawUrl || res.pageUrl || res.proxyUrl;
    state.activeResumeKey = candResumeUrl ? resumeKey(candResumeUrl) : null;
    $('currentVideoTitle').textContent = res.title || res.host || 'Video';
    $('currentStreamInfo').textContent = `${String(res.kind).toUpperCase()} · ${res.host || ''}`;

    let start = meta.startTime !== undefined ? meta.startTime : 0;
    if (!start && state.activeResumeKey) {
      const v = parseFloat(localStorage.getItem(state.activeResumeKey));
      if (v > 5) start = v;
    }
    state.pendingStartTime = start > 5 ? start : 0;

    hideError();
    state.currentIntro = null;
    state.introSkipped = false;
    state.energySamples = [];
    state.lastEnergySampleTime = 0;
    state._localDetectAttempted = false;
    state._fingerprintSaved = false;
    const fSkipEl = $('btnFloatingSkipIntro');
    if (fSkipEl) fSkipEl.classList.add('hidden');
    const fOutroEl = $('btnFloatingSkipOutro');
    if (fOutroEl) fOutroEl.classList.add('hidden');

    if (mk && typeof mk.detectIntro === 'function') {
      const bestTitle = (state.nav && state.nav.title && !state.nav.title.includes('MK VideoPlayer'))
        ? state.nav.title
        : (res.title || (state.nav && state.nav.title) || '');
      mk.detectIntro({
        pageTitle: bestTitle,
        pageUrl: state.lastPageUrl || (state.nav && state.nav.url) || '',
        streamTitle: res.title || '',
        duration: res.duration || 0,
      }).then((introData) => {
        if (introData) {
          state.currentIntro = introData;
          if (introData.found && introData.intro) {
            const fBadge = $('floatingSkipIntroBadge');
            if (fBadge) {
              fBadge.textContent = introData.source === 'aniskip' ? 'AniSkip' : 'Akıllı İntro';
              fBadge.classList.remove('hidden');
            }
          }
        }
      }).catch(() => {});
    }

    player.load({ url: res.proxyUrl, kind: res.kind, startTime: start });
    if (start > 0) showToast(`Kaldığınız yerden devam: ${formatTime(start)}`, 4000);
    if (state.settings && state.settings.defaultSpeed) {
      player.setRate(state.settings.defaultSpeed);
    }
    if (!state.settings || state.settings.autoplay !== false || meta.forcePlay) {
      player.play();
    }
    updateMediaSession(res);
    hlsSubtitleTracks = [];
    updateSubtitleTracksUI();
    renderSources();
    loadHistory();
    updateBookmarkButton();
  }

  async function playSource(src) {
    if (!mk) return showError('no_source');
    $('currentStreamInfo').textContent = 'Kaynak hazırlanıyor…';
    const res = await mk.playSource(src.id);
    if (!res || !res.ok) {
      showError((res && res.code) || 'connection_error', { backToPage: true });
      return;
    }
    state.lastPageUrl = res.pageUrl || (state.nav && state.nav.url) || null;
    playResult(res, { resumeUrl: src.url, pageUrl: state.lastPageUrl, historyId: res.historyId });
  }

  // ---------- kaynak listesi ----------
  function renderSources() {
    window.MKRender.renderSources($('streamsList'), state.sources, {
      onPlay: playSource,
      activeId: state.activeSourceId,
      capture: state.capture,
      emptyText: state.capture && state.capture.armed
        ? ((state.capture.diagnostics && state.capture.diagnostics.statusText) || 'Seçiminiz izleniyor; henüz medya isteği algılanmadı…')
        : 'Kaynak algılama kapalı.',
    });
    $('streamCountBadge').textContent = String(state.sources.length);
  }

  function applyCapture(c) {
    state.capture = c;
    state.sources = c.sources || [];
    const btn = $('btnCapture');
    btn.textContent = c.armed ? 'Kaynak algılamayı durdur' : 'Kaynak algılamayı başlat';
    btn.setAttribute('aria-pressed', String(c.armed));
    btn.classList.toggle('bg-brand-600', c.armed);
    btn.classList.toggle('bg-slate-800', !c.armed);

    const diag = c.diagnostics || {};
    $('captureStatus').textContent = diag.statusText || (!c.armed
      ? 'Kaynak algılama kapalı. Başlatın, sonra sayfada çeviri ve oynatıcıyı seçin.'
      : 'Medya akışı izleniyor...');

    const a = c.activity || {};
    $('activityStatus').textContent = c.armed
      ? `Ağ etkinliği: ${a.requests || 0} istek · ${a.mediaRequests || 0} medya · ${a.segments || 0} segment · ${a.ignored || 0} elenen`
      : 'Ağ etkinliği: —';
    renderSources();

    // Sonraki / önceki bölüme geçiş sırasında yeni kaynak geldiğinde otomatik oynat
    if (state.autoPlayNextSource && state.autoPlayNextSource.active && state.sources.length > 0) {
      const ignore = state.autoPlayNextSource.ignoreIds || new Set();
      const freshSources = state.sources.filter((s) => !ignore.has(s.id));
      if (freshSources.length > 0) {
        const candidate = freshSources.find((s) => s.availability === 'verified' || s.availability === 'detected') || freshSources[0];
        if (candidate && candidate.availability !== 'unsupported' && candidate.availability !== 'failed') {
          state.autoPlayNextSource = null;
          clearTimeout(autoPlayNextTimer);
          playSource(candidate);
          showToast('Yeni bölüm başlatıldı');
          // Kullanıcı tercihi: Bölüm bulunup açılınca kaynak algılamayı kapat
          if (mk && typeof mk.setCapture === 'function') {
            mk.setCapture(false).catch(() => {});
          }
        }
      }
    }
  }

  // ---------- gezinme ----------
  function applyNav(n) {
    state.nav = n;
    $('btnBack').disabled = !n.canGoBack;
    $('btnForward').disabled = !n.canGoForward;
    const reloadIcon = $('iconReload');
    const stopIcon = $('iconStop');
    if (reloadIcon && stopIcon) {
      if (n.loading) {
        reloadIcon.classList.add('hidden');
        stopIcon.classList.remove('hidden');
      } else {
        reloadIcon.classList.remove('hidden');
        stopIcon.classList.add('hidden');
      }
    }
    $('btnReload').title = n.loading ? 'Durdur' : 'Yenile';
    const input = $('addressInput');
    if (document.activeElement !== input && n.url) input.value = n.url;
    const key = n.error ? `${n.error.code}|${n.error.url || ''}` : null;
    if (key && key !== state.lastNavError) showError(n.error.code, { fallback: n.error.detail });
    state.lastNavError = key;
  }

  function applyPopups(p) {
    $('popupMode').value = p.mode;
    window.MKRender.renderPopups($('popupList'), p.blocked, { onOpen: (b) => mk.openBlockedPopup(b.id) });
    $('popupEmpty').classList.toggle('hidden', p.blocked.length > 0);
  }

  // ---------- yerleşim: gömülü tarayıcı alanı ----------
  function setLayout(mode) {
    state.layout = mode;
    const isPlayer = mode === 'player';
    const isDiscover = mode === 'discover';
    const isBrowser = mode === 'browser';

    $('browserHost').classList.toggle('hidden', isPlayer);
    const discView = $('discoverView');
    if (discView) discView.classList.toggle('hidden', !isDiscover);

    const side = $('sideArea');
    side.classList.toggle('hidden', isBrowser);
    side.classList.toggle('flex-1', isPlayer);
    side.classList.toggle('w-[460px]', !isPlayer);

    const layoutBtns = [
      ['layoutDiscover', 'discover'],
      ['layoutBrowser', 'browser'],
      ['layoutSplit', 'split'],
      ['layoutPlayer', 'player'],
    ];
    for (const [id, m] of layoutBtns) {
      const b = $(id);
      if (b) {
        b.classList.toggle('bg-brand-600', m === mode);
        b.classList.toggle('text-white', m === mode);
        b.classList.toggle('bg-slate-800', m !== mode);
        b.classList.toggle('text-slate-300', m !== mode);
      }
    }
    syncBounds();
    if (typeof showControls === 'function') showControls();

    if (isDiscover && state.discover && state.discover.list.length === 0 && !state.discover.loading) {
      loadTrendingAnime('all');
    }
  }

  let boundsRaf = 0;
  function syncBounds() {
    if (!mk) return;
    cancelAnimationFrame(boundsRaf);
    boundsRaf = requestAnimationFrame(() => {
      const host = $('browserHost');
      const r = host.getBoundingClientRect();
      const isSettingsOpen = Boolean(settingsModal && !settingsModal.classList.contains('hidden'));
      const isAnimeModalOpen = Boolean($('animeDetailModal') && !$('animeDetailModal').classList.contains('hidden'));
      const isShortcutsOpen = Boolean($('shortcutsModal') && !$('shortcutsModal').classList.contains('hidden'));
      const visible = r.width > 2 && r.height > 2 && !host.classList.contains('hidden') && state.layout !== 'player' && state.layout !== 'discover' && state.displayMode !== 'in_window' && !isSettingsOpen && !isAnimeModalOpen && !isShortcutsOpen;
      mk.setBrowserVisible(visible);
      if (visible) {
        mk.setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
      } else {
        mk.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      }
    });
  }
  new ResizeObserver(syncBounds).observe($('browserHost'));
  window.addEventListener('resize', syncBounds);

  // ---------- anime keşif ve arama ----------
  async function loadTrendingAnime(genre = 'all', format = null) {
    if (!window.MKDiscover) return;
    if (genre !== undefined && genre !== null) state.discover.activeGenre = genre;
    if (format !== undefined && format !== null) state.discover.activeFormat = format;
    state.discover.currentQuery = '';
    state.discover.loading = true;

    const titleEl = $('discoverTitle');
    const backBtn = $('btnDiscoverBackTrending');
    const loadingEl = $('discoverLoading');
    const emptyEl = $('discoverEmpty');
    const formatChipsEl = $('formatChips');
    const chipsEl = $('genreChips');
    const gridEl = $('discoverGrid');

    const curGenre = state.discover.activeGenre || 'all';
    const curFormat = state.discover.activeFormat || 'all';

    if (titleEl) {
      const gLabel = curGenre === 'all' ? '' : (window.MKDiscover.GENRES.find((g) => g.id === curGenre)?.label || curGenre);
      const fLabel = curFormat === 'all' ? '' : (window.MKDiscover.FORMATS && window.MKDiscover.FORMATS.find((f) => f.id === curFormat)?.label || curFormat);
      if (gLabel && fLabel) titleEl.textContent = `Popüler: ${gLabel} (${fLabel})`;
      else if (gLabel) titleEl.textContent = `Popüler Animeler: ${gLabel}`;
      else if (fLabel) titleEl.textContent = `Popüler Animeler: ${fLabel}`;
      else titleEl.textContent = 'Trend ve Popüler Animeler';
    }
    if (backBtn) backBtn.classList.add('hidden');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');

    if (formatChipsEl && window.MKRender.renderFormatChips && window.MKDiscover.FORMATS) {
      window.MKRender.renderFormatChips(formatChipsEl, window.MKDiscover.FORMATS, curFormat, (fmtId) => {
        loadTrendingAnime(curGenre, fmtId);
      });
    }

    if (chipsEl && window.MKRender.renderGenreChips) {
      window.MKRender.renderGenreChips(chipsEl, window.MKDiscover.GENRES, curGenre, (gId) => {
        loadTrendingAnime(gId, curFormat);
      });
    }

    try {
      const opts = {
        genre: curGenre === 'all' ? null : curGenre,
        format: curFormat === 'all' ? null : curFormat,
      };
      const items = await window.MKDiscover.getTrending(opts);
      state.discover.list = items || [];
      if (loadingEl) loadingEl.classList.add('hidden');
      if (state.discover.list.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (gridEl) gridEl.replaceChildren();
      } else if (gridEl && window.MKRender.renderAnimeCards) {
        window.MKRender.renderAnimeCards(gridEl, state.discover.list, (anime) => {
          openAnimeModal(anime);
        });
      }
    } catch (err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (emptyEl) emptyEl.classList.remove('hidden');
      showToast(`Animeler yüklenemedi: ${err.message || 'Bağlantı hatası'}`, 4000);
    } finally {
      state.discover.loading = false;
    }
  }

  async function searchAnime(query) {
    if (!window.MKDiscover) return;
    const q = String(query || '').trim();
    if (!q) {
      loadTrendingAnime('all', state.discover.activeFormat || 'all');
      return;
    }

    state.discover.currentQuery = q;
    state.discover.loading = true;

    const titleEl = $('discoverTitle');
    const backBtn = $('btnDiscoverBackTrending');
    const loadingEl = $('discoverLoading');
    const emptyEl = $('discoverEmpty');
    const gridEl = $('discoverGrid');

    if (titleEl) titleEl.textContent = `Arama Sonuçları: "${q}"`;
    if (backBtn) backBtn.classList.remove('hidden');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');

    try {
      const curFormat = state.discover.activeFormat || 'all';
      const opts = {
        format: curFormat === 'all' ? null : curFormat,
      };
      const items = await window.MKDiscover.searchAnime(q, opts);
      state.discover.list = items || [];
      if (loadingEl) loadingEl.classList.add('hidden');
      if (state.discover.list.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        if (gridEl) gridEl.replaceChildren();
      } else if (gridEl && window.MKRender.renderAnimeCards) {
        window.MKRender.renderAnimeCards(gridEl, state.discover.list, (anime) => {
          openAnimeModal(anime);
        });
      }
    } catch (err) {
      if (loadingEl) loadingEl.classList.add('hidden');
      if (emptyEl) emptyEl.classList.remove('hidden');
      showToast(`Arama hatası: ${err.message || 'Bağlantı hatası'}`, 4000);
    } finally {
      state.discover.loading = false;
    }
  }

  function getWatchedEpisodes(anime) {
    const watched = new Set();
    if (!anime || !state.history || state.history.length === 0) return watched;
    const titleLower = (anime.title || '').toLowerCase();
    const romajiLower = (anime.titleRomaji || '').toLowerCase();
    const slug = (window.MKDiscover && typeof window.MKDiscover.slugify === 'function')
      ? window.MKDiscover.slugify(anime.titleRomaji || anime.title || '')
      : '';

    for (const item of state.history) {
      const full = `${item.title || ''} ${item.pageTitle || ''} ${item.pageUrl || ''} ${item.url || ''}`.toLowerCase();
      if (
        (titleLower && full.includes(titleLower)) ||
        (romajiLower && full.includes(romajiLower)) ||
        (slug && full.includes(slug))
      ) {
        if (typeof item.episode === 'number' && item.episode > 0) {
          watched.add(item.episode);
        }
        const m = full.match(/(?:(?:b[oö]l[uü]m|ep|episode)[-_ /.:]*(\d+)|(\d+)[-_ /.:]*(?:b[oö]l[uü]m|ep|episode)|-(\d+)-bolum)/i);
        if (m) {
          const num = parseInt(m[1] || m[2] || m[3], 10);
          if (num > 0) watched.add(num);
        }
      }
    }
    return watched;
  }

  function openAnimeModal(anime) {
    if (!anime) return;
    state.discover.selectedAnime = anime;

    const modal = $('animeDetailModal');
    if (!modal) return;

    const cover = $('modalAnimeCover');
    if (cover) {
      cover.src = anime.cover || '';
      cover.alt = anime.title || 'Afiş';
    }

    const tEl = $('modalAnimeTitle');
    if (tEl) tEl.textContent = anime.title || 'Bilinmeyen Anime';

    const altEl = $('modalAnimeAltTitle');
    if (altEl) altEl.textContent = anime.titleRomaji || anime.titleNative || '';

    const scoreVal = $('modalScoreValue');
    if (scoreVal) scoreVal.textContent = anime.score ? String(anime.score) : '—';

    const epEl = $('modalAnimeEpisodes');
    if (epEl) epEl.textContent = anime.episodes ? `${anime.episodes} Bölüm` : 'Bölüm Sayısı Bilinmiyor';

    const yearEl = $('modalAnimeYear');
    if (yearEl) yearEl.textContent = anime.year ? String(anime.year) : 'Yıl Bilinmiyor';

    const statusEl = $('modalAnimeStatus');
    if (statusEl) {
      statusEl.textContent = anime.status === 'FINISHED'
        ? 'Tamamlandı'
        : (anime.status === 'RELEASING' ? 'Devam Ediyor' : 'Durum Bilinmiyor');
    }

    const genEl = $('modalAnimeGenres');
    if (genEl) {
      genEl.textContent = (anime.genres && anime.genres.length > 0) ? anime.genres.join(', ') : 'Tür bilgisi yok';
    }

    const synEl = $('modalAnimeSynopsis');
    if (synEl) {
      synEl.textContent = anime.description ? anime.description.replace(/<[^>]*>/g, '') : 'Konu açıklaması bulunmuyor.';
    }

    const savedProvider = (typeof localStorage !== 'undefined' && localStorage.getItem('mk_preferred_provider')) || 'web_1080p';
    const provSel = $('modalProviderSelect');
    if (provSel) provSel.value = state.discover.provider || savedProvider;

    const watched = getWatchedEpisodes(anime);
    const grid = $('modalEpisodeGrid');
    const tabsEl = $('modalEpisodePageTabs');
    const scrollArea = $('modalEpisodeScrollArea');
    const totalEps = anime.episodes || 12;

    let activeRange = { id: '1-50', start: 1, end: Math.min(totalEps, 50) };
    if (totalEps <= 50) {
      activeRange = { id: 'all', start: 1, end: totalEps };
    }

    const renderEpisodesForRange = (range) => {
      activeRange = range;
      if (tabsEl && window.MKRender.renderEpisodeTabs) {
        window.MKRender.renderEpisodeTabs(tabsEl, totalEps, activeRange, (newRange) => {
          renderEpisodesForRange(newRange);
        });
      }
      if (grid && window.MKRender.renderEpisodeButtons) {
        window.MKRender.renderEpisodeButtons(grid, totalEps, watched, (epNum) => {
          startAnimeEpisode(anime, epNum);
        }, { start: activeRange.start, end: activeRange.end });
      }
      if (scrollArea) scrollArea.scrollTop = 0;
    };

    renderEpisodesForRange(activeRange);

    const searchInput = $('modalEpisodeSearchInput');
    if (searchInput) {
      searchInput.value = '';
      searchInput.oninput = () => {
        const val = parseInt(searchInput.value, 10);
        if (!Number.isFinite(val) || val <= 0) {
          renderEpisodesForRange(activeRange);
          return;
        }
        if (val > totalEps) return;
        const chunkIdx = Math.floor((val - 1) / 50);
        const start = chunkIdx * 50 + 1;
        const end = Math.min(totalEps, (chunkIdx + 1) * 50);
        const targetRange = { id: `${start}-${end}`, start, end };
        renderEpisodesForRange(targetRange);
        if (grid) {
          const targetBtn = grid.querySelector(`button[data-ep="${val}"]`);
          if (targetBtn) {
            targetBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
            targetBtn.classList.add('ring-2', 'ring-brand-400');
          }
        }
      };
    }

    modal.classList.remove('hidden');
    syncBounds();
  }

  function closeAnimeModal() {
    const modal = $('animeDetailModal');
    if (modal) modal.classList.add('hidden');
    state.discover.selectedAnime = null;
    syncBounds();
  }

  async function startAnimeEpisode(anime, episodeNumber) {
    if (!anime) return;
    closeAnimeModal();

    const savedProvider = (typeof localStorage !== 'undefined' && localStorage.getItem('mk_preferred_provider')) || 'web_1080p';
    const provSel = $('modalProviderSelect');
    const provider = (provSel && provSel.value) || state.discover.provider || savedProvider;
    state.discover.provider = provider;

    const targetUrl = window.MKDiscover.buildProviderUrl(provider, anime, episodeNumber);

    // Kaynak algılamayı otomatik olarak etkinleştir
    if (mk && typeof mk.setCapture === 'function') {
      try {
        await mk.setCapture(true);
      } catch (_) {}
    }

    // Yeni bölüm akışı geldiğinde yakalamak için autoPlay bayrağını ayarla
    state.autoPlayNextSource = {
      active: true,
      ignoreIds: new Set((state.sources || []).map((s) => s.id)),
    };

    // İkili (Split) moda geç: Sol tarafta web sitesi yüklenir, akış gelince sağdaki oynatıcı başlar
    setLayout('split');

    const addrInput = $('addressInput');
    if (addrInput) addrInput.value = targetUrl;

    showToast(`${anime.title} - ${episodeNumber}. Bölüm açılıyor…`, 4000);

    if (mk) {
      await mk.go(targetUrl);
    }
  }

  // ---------- olaylar ----------
  $('addressForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const rawVal = ($('addressInput').value || '').trim();
    if (!rawVal) return showError('empty_url');

    const classified = window.MKClassify.classifyInput(rawVal);
    // URL veya geçerli host değilse (ör: "Solo Leveling", "naruto", "jujutsu kaisen"), anime araması olarak ele al
    if (classified.type === 'invalid') {
      setLayout('discover');
      searchAnime(rawVal);
      $('addressInput').blur();
      return;
    }

    if (!mk) return showError('no_source', { fallback: 'Masaüstü uygulaması gerekli.' });
    if (state.layout === 'player' || state.layout === 'discover') setLayout('split');
    const res = await mk.go(rawVal);
    if (!res.ok) {
      showError(res.type === 'empty' ? 'empty_url' : 'invalid_url');
      return;
    }
    if (res.type === 'media') {
      if (res.supported === false) return showError('dash_unsupported');
      const r = await mk.playDirect(res.url); // kullanıcı doğrudan medya adresi verdi
      if (!r.ok) return showError(r.code, {});
      $('addressInput').blur();
      playResult(r, { resumeUrl: res.url });
    } else {
      $('addressInput').blur();
    }
  });
  $('btnBack').addEventListener('click', () => mk && mk.back());
  $('btnForward').addEventListener('click', () => mk && mk.forward());
  $('btnReload').addEventListener('click', () => { if (!mk) return; (state.nav && state.nav.loading) ? mk.stop() : mk.reload(); });
  $('btnCapture').addEventListener('click', () => mk && mk.setCapture(!(state.capture && state.capture.armed)));
  $('popupMode').addEventListener('change', (e) => mk && mk.setPopupMode(e.target.value));
  const lDiscover = $('layoutDiscover'); if (lDiscover) lDiscover.addEventListener('click', () => setLayout('discover'));
  $('layoutBrowser').addEventListener('click', () => setLayout('browser'));
  $('layoutSplit').addEventListener('click', () => setLayout('split'));
  $('layoutPlayer').addEventListener('click', () => setLayout('player'));

  const btnDiscBack = $('btnDiscoverBackTrending');
  if (btnDiscBack) btnDiscBack.addEventListener('click', () => loadTrendingAnime('all'));

  const btnSwitchBrowser = $('btnSwitchToBrowser');
  if (btnSwitchBrowser) btnSwitchBrowser.addEventListener('click', () => setLayout('split'));

  const btnEmptyReset = $('btnEmptyReset');
  if (btnEmptyReset) btnEmptyReset.addEventListener('click', () => loadTrendingAnime('all'));

  const btnCloseModal = $('btnCloseAnimeModal');
  if (btnCloseModal) btnCloseModal.addEventListener('click', closeAnimeModal);

  const animeModalEl = $('animeDetailModal');
  if (animeModalEl) {
    animeModalEl.addEventListener('click', (e) => {
      if (e.target === animeModalEl) closeAnimeModal();
    });
  }

  const shortcutsModalEl = $('shortcutsModal');
  function openShortcutsModal() {
    if (shortcutsModalEl) {
      shortcutsModalEl.classList.remove('hidden');
      syncBounds();
    }
  }
  function closeShortcutsModal() {
    if (shortcutsModalEl) {
      shortcutsModalEl.classList.add('hidden');
      syncBounds();
    }
  }

  const btnShortcuts = $('btnShortcuts');
  if (btnShortcuts) btnShortcuts.addEventListener('click', openShortcutsModal);

  const btnCloseShortcutsModal = $('btnCloseShortcutsModal');
  if (btnCloseShortcutsModal) btnCloseShortcutsModal.addEventListener('click', closeShortcutsModal);

  const btnShortcutsOk = $('btnShortcutsOk');
  if (btnShortcutsOk) btnShortcutsOk.addEventListener('click', closeShortcutsModal);

  if (shortcutsModalEl) {
    shortcutsModalEl.addEventListener('click', (e) => {
      if (e.target === shortcutsModalEl) closeShortcutsModal();
    });
  }

  const modalCardEl = $('animeDetailModalCard');
  if (modalCardEl) {
    modalCardEl.addEventListener('wheel', (e) => {
      const scrollArea = $('modalEpisodeScrollArea');
      if (scrollArea && scrollArea.scrollHeight > scrollArea.clientHeight) {
        if (!scrollArea.contains(e.target)) {
          scrollArea.scrollTop += e.deltaY;
          e.preventDefault();
        }
      }
    }, { passive: false });
  }

  const provSelectEl = $('modalProviderSelect');
  if (provSelectEl) {
    provSelectEl.addEventListener('change', (e) => {
      state.discover.provider = e.target.value;
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('mk_preferred_provider', e.target.value);
      }
    });
  }

  // ---------- 1080p HD / Remastered Hızlı Alternatif Bulucu ----------
  function getCurrentAnimeInfo() {
    let title = '';
    let ep = 1;

    // 1. Önce aktif seçili anime veya son izlenen
    if (state.discover && state.discover.selectedAnime) {
      const a = state.discover.selectedAnime;
      title = a.title || a.titleEnglish || a.titleRomaji;
    }

    // 2. Sayfa URL'sinden veya oynatılan video başlığından ayıkla
    const pageUrl = (state.nav && state.nav.url) || $('addressInput')?.value || '';
    const pageTitle = (state.nav && state.nav.title) || $('currentVideoTitle')?.textContent || '';

    if (!title && pageTitle && pageTitle !== 'Henüz bir kaynak oynatılmıyor') {
      title = pageTitle
        .replace(/\s*[-–|]\s*(?:Anizm|Anime|Dizi|Film|HD\s*İzle|İzle|Watch|Online).*$/i, '')
        .replace(/\s*(?:HD\s*)?Türkçe\s*(?:Altyazılı|Dublajlı)?\s*İzle.*$/i, '')
        .replace(/\s+HD\s*İzle.*$/i, '')
        .replace(/\s+İzle\s*$/i, '')
        .trim();
    }

    // Bölüm numarasını çıkar (örn: 1-bolum, 1. Bölüm, ep=1)
    const combinedStr = `${pageTitle} ${pageUrl}`;
    const epMatch = combinedStr.match(/(?:(\d+)\s*\.\s*[Bb]ölüm|[Bb]ölüm\s*(\d+)|[Ee]pisode\s*(\d+)|(\d+)[-_]?(?:bolum|episode))/i);
    if (epMatch) {
      ep = parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4], 10) || 1;
    }

    if (title) {
      title = title.replace(/(?:\d+\s*\.\s*[Bb]ölüm|[Bb]ölüm\s*\d+|[Ee]pisode\s*\d+).*$/i, '').trim();
    }

    return { title: title || 'Dragon Ball', episodeNumber: ep };
  }

  async function openProviderForCurrentAnime(providerId) {
    const { title, episodeNumber } = getCurrentAnimeInfo();
    const fakeAnime = { title, titleRomaji: title, titleEnglish: title };
    const targetUrl = window.MKDiscover.buildProviderUrl(providerId, fakeAnime, episodeNumber);

    if (mk && typeof mk.setCapture === 'function') {
      try { await mk.setCapture(true); } catch (_) {}
    }

    state.autoPlayNextSource = {
      active: true,
      ignoreIds: new Set((state.sources || []).map((s) => s.id)),
    };

    setLayout('split');
    const addrInput = $('addressInput');
    if (addrInput) addrInput.value = targetUrl;

    if (mk && typeof mk.go === 'function') {
      await mk.go(targetUrl);
    }

    const quickMenu = $('quick1080pMenu');
    if (quickMenu) quickMenu.classList.add('hidden');

    const providerNames = {
      web_1080p: 'Web 1080p Remaster',
      animecix: 'Animecix (1080p)',
      turkanime: 'TürkAnime (Fansub)',
      dizigom: 'Dizigom (HD)',
    };
    showToast(`${providerNames[providerId] || '1080p'}: ${title} - ${episodeNumber}. Bölüm aranıyor…`);
  }

  const btnFind1080p = $('btnFind1080p');
  const quick1080pMenu = $('quick1080pMenu');
  if (btnFind1080p && quick1080pMenu) {
    btnFind1080p.addEventListener('click', (e) => {
      e.stopPropagation();
      quick1080pMenu.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
      if (!quick1080pMenu.contains(e.target) && e.target !== btnFind1080p && !btnFind1080p.contains(e.target)) {
        quick1080pMenu.classList.add('hidden');
      }
    });

    const btnAltWeb1080p = $('btnAltWeb1080p');
    if (btnAltWeb1080p) btnAltWeb1080p.addEventListener('click', () => openProviderForCurrentAnime('web_1080p'));

    const btnAltAnimecix = $('btnAltAnimecix');
    if (btnAltAnimecix) btnAltAnimecix.addEventListener('click', () => openProviderForCurrentAnime('animecix'));

    const btnAltTurkanime = $('btnAltTurkanime');
    if (btnAltTurkanime) btnAltTurkanime.addEventListener('click', () => openProviderForCurrentAnime('turkanime'));

    const btnAltDizigom = $('btnAltDizigom');
    if (btnAltDizigom) btnAltDizigom.addEventListener('click', () => openProviderForCurrentAnime('dizigom'));
  }

  $('btnDismissError').addEventListener('click', hideError);
  $('btnRetry').addEventListener('click', () => { hideError(); if (player.reload()) player.play(); });
  $('btnBackToPage').addEventListener('click', () => {
    hideError();
    if (state.lastPageUrl && mk) {
      mk.go(state.lastPageUrl);
      setLayout('split');
    } else {
      setLayout('browser');
    }
  });

  // ---------- geçmiş ve ayarlar kontrolleri ----------
  let searchTimer = null;
  const searchInput = $('historySearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.historyQuery = e.target.value;
        loadHistory();
      }, 250);
    });
  }

  function setHistoryFilter(mode) {
    state.historyFilter = mode;
    const btns = [
      ['filterAll', 'all'],
      ['filterInProgress', 'in_progress'],
      ['filterCompleted', 'completed'],
    ];
    for (const [id, m] of btns) {
      const b = $(id);
      if (b) {
        b.classList.toggle('bg-brand-600', m === mode);
        b.classList.toggle('text-white', m === mode);
        b.classList.toggle('font-medium', m === mode);
        b.classList.toggle('bg-slate-800', m !== mode);
        b.classList.toggle('text-slate-300', m !== mode);
      }
    }
    loadHistory();
  }

  const fAll = $('filterAll'); if (fAll) fAll.addEventListener('click', () => setHistoryFilter('all'));
  const fInProg = $('filterInProgress'); if (fInProg) fInProg.addEventListener('click', () => setHistoryFilter('in_progress'));
  const fComp = $('filterCompleted'); if (fComp) fComp.addEventListener('click', () => setHistoryFilter('completed'));

  const btnClearHist = $('btnClearHistory');
  if (btnClearHist) {
    btnClearHist.addEventListener('click', async () => {
      if (!mk) return;
      if (window.confirm('Tüm izleme geçmişini silmek istediğinize emin misiniz?\n(Web oturumunuz ve girişleriniz silinmez)')) {
        await mk.clearHistory();
        showToast('İzleme geçmişi temizlendi');
        loadHistory();
      }
    });
  }

  function toggleHistoryPanel() {
    state.historyCollapsed = !state.historyCollapsed;
    const content = $('historyContent');
    const toggleBtn = $('btnToggleHistory');
    if (content) content.classList.toggle('hidden', state.historyCollapsed);
    if (toggleBtn) {
      toggleBtn.innerHTML = state.historyCollapsed
        ? '<svg class="icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 15l7-7 7 7"/></svg>'
        : '<svg class="icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>';
    }
    syncBounds();
  }
  const btnToggleHist = $('btnToggleHistory'); if (btnToggleHist) btnToggleHist.addEventListener('click', toggleHistoryPanel);
  const histHeader = $('historyTitleHeader'); if (histHeader) histHeader.addEventListener('click', toggleHistoryPanel);

  // Settings modal
  const settingsModal = $('settingsModal');
  const btnSettings = $('btnSettings');
  const btnCloseSettings = $('btnCloseSettings');
  const btnDismissSettings = $('btnDismissSettings');

  async function loadSettings() {
    if (!mk || !mk.getSettings) return;
    try {
      const s = await mk.getSettings();
      if (s && typeof s === 'object') {
        state.settings = { ...state.settings, ...s };
        if (state.settings.defaultLayout) {
          setLayout(state.settings.defaultLayout);
        }
        applySettingsToApp();
      }
    } catch (_) {}
  }

  function applySettingsToApp() {
    const step = state.settings.seekStep || 10;
    const rBtn = $('btnRewind10');
    if (rBtn) {
      rBtn.title = `${step} sn Geri (Sol Yön Tuşu)`;
      rBtn.setAttribute('aria-label', `${step} saniye geri`);
    }
    const fBtn = $('btnForward10');
    if (fBtn) {
      fBtn.title = `${step} sn İleri (Sağ Yön Tuşu)`;
      fBtn.setAttribute('aria-label', `${step} saniye ileri`);
    }

    if (state.settings.rememberVolume) {
      if (state.settings.lastVolume !== undefined && Number.isFinite(state.settings.lastVolume)) {
        player.setVolume(state.settings.lastVolume);
        const slider = $('volumeSlider');
        if (slider) slider.value = String(state.settings.lastVolume);
      }
      if (state.settings.lastMuted !== undefined) {
        video.muted = !!state.settings.lastMuted;
      }
      volIcons();
    }

    if (state.settings.defaultSpeed) {
      player.setRate(state.settings.defaultSpeed);
      const sp = $('speedSelector');
      if (sp) sp.value = String(state.settings.defaultSpeed);
    }

    const intro = state.settings.introSkipSeconds || 85;
    const lSkip = $('labelSkipIntro'); if (lSkip) lSkip.textContent = `+${intro}s`;
    const fSkip = $('floatingSkipIntroText'); if (fSkip) fSkip.textContent = `İntroyu Atla (+${intro}s)`;

    if (state.settings.audioBoost) {
      player.setAudioBoost(state.settings.audioBoost);
      const ab = $('audioBoostSelector'); if (ab) ab.value = String(state.settings.audioBoost);
    }

    if (state.settings.bufferMode) {
      player.setBufferMode(state.settings.bufferMode);
    }

    // Aktif seviyeler varsa kalite tercihini uygula
    if (state.currentLevels && state.currentLevels.length > 0) {
      applyQualityPreference((state.settings && state.settings.defaultQuality) || 'auto');
    }
  }

  function syncSettingsInputs() {
    const s = state.settings;
    const qEl = $('settingDefaultQuality'); if (qEl) qEl.value = s.defaultQuality || 'auto';
    const spEl = $('settingDefaultSpeed'); if (spEl) spEl.value = String(s.defaultSpeed || 1.0);
    const stEl = $('settingSeekStep'); if (stEl) stEl.value = String(s.seekStep || 10);
    const layEl = $('settingDefaultLayout'); if (layEl) layEl.value = s.defaultLayout || 'discover';
    const apEl = $('settingAutoplay'); if (apEl) apEl.checked = !!s.autoplay;
    const rvEl = $('settingRememberVolume'); if (rvEl) rvEl.checked = !!s.rememberVolume;
    const rwEl = $('settingRememberWindow'); if (rwEl) rwEl.checked = !!s.rememberWindowBounds;
    const rlpEl = $('settingRestoreLastPage'); if (rlpEl) rlpEl.checked = s.restoreLastPage !== false;
    const iskEl = $('settingIntroSkip'); if (iskEl) iskEl.value = String(s.introSkipSeconds || 85);
    const bufEl = $('settingBufferMode'); if (bufEl) bufEl.value = s.bufferMode || 'balanced';
    const aneEl = $('settingAutoNextEpisode'); if (aneEl) aneEl.checked = s.autoNextEpisode !== false;
    const sidEl = $('settingSmartIntroDetection'); if (sidEl) sidEl.checked = s.smartIntroDetection !== false;
    const asiEl = $('settingAutoSkipIntro'); if (asiEl) asiEl.checked = !!s.autoSkipIntro;
  }

  async function onSettingChange(e) {
    if (!mk || !mk.updateSettings) return;
    try {
      const qEl = $('settingDefaultQuality');
      const spEl = $('settingDefaultSpeed');
      const stEl = $('settingSeekStep');
      const layEl = $('settingDefaultLayout');
      const apEl = $('settingAutoplay');
      const rvEl = $('settingRememberVolume');
      const rwEl = $('settingRememberWindow');
      const rlpEl = $('settingRestoreLastPage');
      const iskEl = $('settingIntroSkip');
      const bufEl = $('settingBufferMode');
      const aneEl = $('settingAutoNextEpisode');
      const sidEl = $('settingSmartIntroDetection');
      const asiEl = $('settingAutoSkipIntro');

      const payload = {
        defaultQuality: qEl ? qEl.value : 'auto',
        defaultSpeed: spEl ? parseFloat(spEl.value) : 1.0,
        seekStep: stEl ? parseInt(stEl.value, 10) : 10,
        defaultLayout: layEl ? layEl.value : 'discover',
        autoplay: apEl ? apEl.checked : true,
        rememberVolume: rvEl ? rvEl.checked : true,
        rememberWindowBounds: rwEl ? rwEl.checked : true,
        restoreLastPage: rlpEl ? rlpEl.checked : true,
        introSkipSeconds: iskEl ? parseInt(iskEl.value, 10) : 85,
        bufferMode: bufEl ? bufEl.value : 'balanced',
        autoNextEpisode: aneEl ? aneEl.checked : true,
        smartIntroDetection: sidEl ? sidEl.checked : true,
        autoSkipIntro: asiEl ? asiEl.checked : false,
      };

      const updated = await mk.updateSettings(payload);
      if (updated) {
        state.settings = { ...state.settings, ...updated };
        applySettingsToApp();
        if (e && e.target && e.target.id === 'settingDefaultLayout' && layEl) {
          setLayout(layEl.value);
        }
        showToast('Ayar kaydedildi', 1500);
      }
    } catch (err) {
      console.error('Ayar güncelleme hatası:', err);
    }
  }

  // Ayarlar modalındaki girdilerin dinleyicileri (hem change hem input)
  ['settingDefaultQuality', 'settingDefaultSpeed', 'settingSeekStep', 'settingDefaultLayout',
   'settingAutoplay', 'settingRememberVolume', 'settingRememberWindow', 'settingRestoreLastPage',
   'settingIntroSkip', 'settingBufferMode', 'settingAutoNextEpisode',
   'settingSmartIntroDetection', 'settingAutoSkipIntro'].forEach((id) => {
    const el = $(id);
    if (el) {
      el.addEventListener('change', onSettingChange);
      el.addEventListener('input', onSettingChange);
    }
  });

  const btnResetSettings = $('btnResetSettings');
  if (btnResetSettings) {
    btnResetSettings.addEventListener('click', async () => {
      if (!mk || !mk.resetSettings) return;
      if (window.confirm('Tüm ayarları varsayılan değerlerine sıfırlamak istiyor musunuz?')) {
        const reset = await mk.resetSettings();
        if (reset) {
          state.settings = { ...state.settings, ...reset };
          syncSettingsInputs();
          applySettingsToApp();
          showToast('Ayarlar varsayılanlara sıfırlandı');
        }
      }
    });
  }

  async function openSettings() {
    if (!settingsModal) return;
    settingsModal.classList.remove('hidden');
    // WebContentsView native katmanı modalin üstüne bindiği ve tıklamaları engellediği için
    // ayarlar modalı açıkken gömülü tarayıcı görünürlüğünü gizle
    if (mk && typeof mk.setBrowserVisible === 'function') {
      mk.setBrowserVisible(false);
    }
    syncBounds();
    syncSettingsInputs();
    if (mk) {
      const info = await mk.getSessionInfo();
      const badge = $('sessionStatusBadge');
      if (badge && info) {
        badge.textContent = `${info.partition} (${info.persistent ? 'Kalıcı' : 'Geçici'})`;
      }
      const items = await mk.getHistory();
      const countEl = $('settingsHistoryCount');
      if (countEl) countEl.textContent = `${(items || []).length} kayıt`;

      if (mk.getHistoryEncryptionStatus) {
        try {
          const enc = await mk.getHistoryEncryptionStatus();
          const encBadge = $('settingsEncryptionBadge');
          if (encBadge && enc) {
            encBadge.textContent = enc.mode === 'safeStorage' ? 'safeStorage Şifreli' : 'AES-256 Şifreli';
          }
        } catch (_) {}
      }
    }
  }

  function closeSettings() {
    if (settingsModal) settingsModal.classList.add('hidden');
    syncBounds();
  }

  if (btnSettings) btnSettings.addEventListener('click', openSettings);
  const btnPlayerSettings = $('btnPlayerSettings');
  if (btnPlayerSettings) btnPlayerSettings.addEventListener('click', openSettings);
  if (btnCloseSettings) btnCloseSettings.addEventListener('click', closeSettings);
  if (btnDismissSettings) btnDismissSettings.addEventListener('click', closeSettings);
  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) closeSettings();
    });
  }

  const btnClearSite = $('btnSettingsClearSite');
  if (btnClearSite) {
    btnClearSite.addEventListener('click', async () => {
      if (!mk) return;
      const target = (state.nav && state.nav.url) || '';
      if (!target) {
        showToast('Açık bir web sayfası bulunmuyor');
        return;
      }
      await mk.clearSiteSession(target);
      showToast('Mevcut sitenin çerezleri ve verileri temizlendi');
    });
  }

  const btnClearAllSes = $('btnSettingsClearAll');
  if (btnClearAllSes) {
    btnClearAllSes.addEventListener('click', async () => {
      if (!mk) return;
      if (window.confirm('Tüm web oturumu, site çerezleri ve depolama sıfırlanacak.\n(İzleme geçmişiniz korunur). Devam edilsin mi?')) {
        await mk.clearAllSession();
        showToast('Web oturumu tamamen sıfırlandı');
      }
    });
  }

  const btnClearHistFromSettings = $('btnSettingsClearHistory');
  if (btnClearHistFromSettings) {
    btnClearHistFromSettings.addEventListener('click', async () => {
      if (!mk) return;
      if (window.confirm('Tüm izleme geçmişini silmek istediğinize emin misiniz?')) {
        await mk.clearHistory();
        showToast('İzleme geçmişi temizlendi');
        loadHistory();
        const countEl = $('settingsHistoryCount');
        if (countEl) countEl.textContent = '0 kayıt';
      }
    });
  }

  // ---------- oynatıcı kontrolleri ----------
  const iconPlay = $('iconPlay'); const iconPause = $('iconPause'); const overlay = $('centerPlayOverlay');
  let lastProgressSave = 0;

  // YouTube stili ilerleme çubuğu: yuvarlağın gerisini birebir aynı kırmızı (#ef4444) renk yap,
  // önünde tamponu (#64748b) ve kalan koyu alanı (#334155) göster (Screenshot 2 ile birebir uyumlu)
  function updateProgressBarUI(pct, bufferedPct = null) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    let b = (bufferedPct !== null)
      ? Number(bufferedPct)
      : (player && typeof player.getBufferProgress === 'function' ? player.getBufferProgress() : 0);
    b = Math.max(p, Math.min(100, Number(b) || 0));
    progressBar.value = p;
    progressBar.style.background = `linear-gradient(to right, #ef4444 0%, #ef4444 ${p}%, #64748b ${p}%, #64748b ${b}%, #334155 ${b}%, #334155 100%)`;
    const bufBar = $('bufferBar');
    if (bufBar) bufBar.style.width = `${b}%`;
  }

  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    updateProgressBarUI(pct);
    $('timeDisplay').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    syncMediaSessionPosition();

    // Kademe 2: Yerel Ses Parmak İzi Örneklemesi (İlk 210 saniye boyunca 500 ms'de bir)
    const ct = video.currentTime;
    const nowTs = Date.now();
    if (!video.paused && ct >= 1 && ct <= 210 && nowTs - (state.lastEnergySampleTime || 0) >= 480) {
      state.lastEnergySampleTime = nowTs;
      if (player && typeof player.getAudioEnergy === 'function') {
        const energy = player.getAudioEnergy();
        if (Number.isFinite(energy) && energy > 0.001) {
          if (!Array.isArray(state.energySamples)) state.energySamples = [];
          state.energySamples.push(Math.round(energy * 1000) / 1000);

          // AniSkip bulamadıysa ve 60 saniyelik enerji örneği toplandıysa yerel analizi dene
          if (state.energySamples.length >= 60 && (!state.currentIntro || !state.currentIntro.found)) {
            if (mk && typeof mk.detectIntro === 'function' && !state._localDetectAttempted) {
              state._localDetectAttempted = true;
              mk.detectIntro({
                pageTitle: (state.nav && state.nav.title) || document.title,
                pageUrl: state.lastPageUrl || (state.nav && state.nav.url) || '',
                streamTitle: $('currentVideoTitle').textContent || '',
                duration: video.duration || 0,
                energySamples: state.energySamples,
                sampleRate: 2,
              }).then((localRes) => {
                if (localRes && localRes.found) {
                  state.currentIntro = localRes;
                }
              }).catch(() => {});
            }
          }
        }
      }
    }

    // 200 saniyeye gelindiğinde parmak izini sonraki bölümler için kaydet
    if (ct >= 200 && !state._fingerprintSaved && state.energySamples && state.energySamples.length >= 60) {
      state._fingerprintSaved = true;
      if (mk && typeof mk.saveFingerprint === 'function') {
        mk.saveFingerprint({
          seriesKey: (state.currentIntro && state.currentIntro.title) || (state.nav && state.nav.title) || document.title,
          episode: (state.currentIntro && state.currentIntro.episode) || 1,
          samples: state.energySamples,
          sampleRate: 2,
        }).catch(() => {});
      }
    }

    // Akıllı İntroyu Atla Yüzen Butonu
    const fSkip = $('btnFloatingSkipIntro');
    if (fSkip) {
      if (state.currentIntro && state.currentIntro.found && state.currentIntro.intro) {
        const intro = state.currentIntro.intro;
        const insideIntro = ct >= intro.start && ct < intro.end;
        fSkip.classList.toggle('hidden', !insideIntro);
        if (insideIntro) {
          const rem = Math.max(1, Math.ceil(intro.end - ct));
          const fText = $('floatingSkipIntroText');
          if (fText) fText.textContent = `İntroyu Atla (${rem}s)`;
          const fBadge = $('floatingSkipIntroBadge');
          if (fBadge) {
            fBadge.classList.remove('hidden');
            fBadge.textContent = state.currentIntro.source === 'aniskip' ? 'AniSkip' : 'Akıllı İntro';
          }
          // Otomatik İntro Atlama (Ayar açıksa tek seferlik atla)
          if (state.settings && state.settings.autoSkipIntro && !state.introSkipped) {
            state.introSkipped = true;
            player.seekTo(intro.end);
            const tag = state.currentIntro.source === 'aniskip' ? 'AniSkip' : 'Akıllı İntro';
            showToast(`İntro otomatik atlandı (${tag})`);
          }
        }
      } else {
        // Kademe 3: Sezgisel Yedek (Heuristic)
        const introSec = (state.settings && state.settings.introSkipSeconds) || 85;
        const showFloating = !video.paused && ct > 2 && ct < introSec + 25;
        fSkip.classList.toggle('hidden', !showFloating);
        const fText = $('floatingSkipIntroText');
        if (fText) fText.textContent = `İntroyu Atla (+${introSec}s)`;
        const fBadge = $('floatingSkipIntroBadge');
        if (fBadge) fBadge.classList.add('hidden');
      }
    }

    // Akıllı Outroyu Atla / Sonraki Bölüm Yüzen Butonu
    const fOutro = $('btnFloatingSkipOutro');
    if (fOutro) {
      if (state.currentIntro && state.currentIntro.found && state.currentIntro.outro) {
        const outro = state.currentIntro.outro;
        const insideOutro = ct >= outro.start && ct < (video.duration || outro.end + 5);
        fOutro.classList.toggle('hidden', !insideOutro);
      } else {
        fOutro.classList.add('hidden');
      }
    }

    const now = Date.now();
    if (now - lastProgressSave > 2500) {
      lastProgressSave = now;
      saveWatchProgress();
    }
  });

  // Otomatik Sonraki Bölüm Geri Sayımı
  let nextEpTimer = null;
  let nextEpCountdown = 5;

  function cancelNextEpisodeCountdown() {
    if (nextEpTimer) {
      clearInterval(nextEpTimer);
      nextEpTimer = null;
    }
    const ov = $('nextEpisodeOverlay');
    if (ov) ov.classList.add('hidden');
  }

  function startAutoNextEpisodeCountdown() {
    cancelNextEpisodeCountdown();
    nextEpCountdown = 5;
    const ov = $('nextEpisodeOverlay');
    const text = $('nextEpisodeCountdownText');
    if (ov) ov.classList.remove('hidden');
    if (text) text.textContent = `${nextEpCountdown} saniye içinde sonraki bölüme geçiliyor…`;

    nextEpTimer = setInterval(() => {
      nextEpCountdown -= 1;
      if (nextEpCountdown <= 0) {
        cancelNextEpisodeCountdown();
        goNextEpisode();
      } else if (text) {
        text.textContent = `${nextEpCountdown} saniye içinde sonraki bölüme geçiliyor…`;
      }
    }, 1000);
  }

  const btnCancelNext = $('btnCancelNextEp');
  if (btnCancelNext) btnCancelNext.addEventListener('click', cancelNextEpisodeCountdown);
  const btnProceedNext = $('btnProceedNextEp');
  if (btnProceedNext) btnProceedNext.addEventListener('click', () => {
    cancelNextEpisodeCountdown();
    goNextEpisode();
  });

  let autoPlayNextTimer = null;

  async function goNextEpisode() {
    if (!mk) return;
    cancelNextEpisodeCountdown();
    showToast('Sonraki bölüm arka planda aranıyor…');
    const ignoreIds = new Set(state.sources.map((s) => s.id));
    state.autoPlayNextSource = { active: true, ignoreIds };
    clearTimeout(autoPlayNextTimer);
    autoPlayNextTimer = setTimeout(() => {
      if (state.autoPlayNextSource && state.autoPlayNextSource.active) {
        state.autoPlayNextSource = null;
        if (mk && typeof mk.setCapture === 'function') {
          mk.setCapture(false).catch(() => {});
        }
        showToast('Sonraki bölüm akışı bulunamadı (Gerekirse İkili moda geçebilirsiniz)', 5000);
      }
    }, 15000);

    // Kaynak algılamayı başlat
    if (typeof mk.setCapture === 'function') {
      await mk.setCapture(true);
    }

    const fallbackUrl = state.lastPageUrl || (state.nav && state.nav.url) || ($('addressInput') ? $('addressInput').value : null);
    const res = await mk.nextEpisode(fallbackUrl);
    if (res && res.ok === false) {
      state.autoPlayNextSource = null;
      clearTimeout(autoPlayNextTimer);
      if (typeof mk.setCapture === 'function') {
        mk.setCapture(false).catch(() => {});
      }
      showToast('Sonraki bölüm bağlantısı bulunamadı');
    }
  }

  async function goPrevEpisode() {
    if (!mk) return;
    cancelNextEpisodeCountdown();
    showToast('Önceki bölüm arka planda aranıyor…');
    const ignoreIds = new Set(state.sources.map((s) => s.id));
    state.autoPlayNextSource = { active: true, ignoreIds };
    clearTimeout(autoPlayNextTimer);
    autoPlayNextTimer = setTimeout(() => {
      if (state.autoPlayNextSource && state.autoPlayNextSource.active) {
        state.autoPlayNextSource = null;
        if (mk && typeof mk.setCapture === 'function') {
          mk.setCapture(false).catch(() => {});
        }
        showToast('Önceki bölüm akışı bulunamadı (Gerekirse İkili moda geçebilirsiniz)', 5000);
      }
    }, 15000);

    // Kaynak algılamayı başlat
    if (typeof mk.setCapture === 'function') {
      await mk.setCapture(true);
    }

    const fallbackUrl = state.lastPageUrl || (state.nav && state.nav.url) || ($('addressInput') ? $('addressInput').value : null);
    const res = await mk.prevEpisode(fallbackUrl);
    if (res && res.ok === false) {
      state.autoPlayNextSource = null;
      clearTimeout(autoPlayNextTimer);
      if (typeof mk.setCapture === 'function') {
        mk.setCapture(false).catch(() => {});
      }
      showToast('Önceki bölüm bağlantısı bulunamadı');
    }
  }

  const btnNextEp = $('btnNextEpisode');
  if (btnNextEp) btnNextEp.addEventListener('click', goNextEpisode);
  const btnPrevEp = $('btnPrevEpisode');
  if (btnPrevEp) btnPrevEp.addEventListener('click', goPrevEpisode);
  const btnSkipIntroBar = $('btnSkipIntroBar');
  if (btnSkipIntroBar) btnSkipIntroBar.addEventListener('click', doSkipIntro);

  // İntroyu Atla
  function doSkipIntro() {
    if (state.currentIntro && state.currentIntro.found && state.currentIntro.intro && video.currentTime < state.currentIntro.intro.end) {
      player.seekTo(state.currentIntro.intro.end);
      const tag = state.currentIntro.source === 'aniskip' ? ' (AniSkip)' : ' (Akıllı Analiz)';
      showToast(`İntro Atlandı${tag}`);
    } else {
      const s = (state.settings && state.settings.introSkipSeconds) || 85;
      player.skipIntro(s);
      showToast(`İntro Atlandı (+${s} sn)`);
    }
    const fSkip = $('btnFloatingSkipIntro');
    if (fSkip) fSkip.classList.add('hidden');
  }

  const btnSkipIntro = $('btnSkipIntro');
  if (btnSkipIntro) btnSkipIntro.addEventListener('click', doSkipIntro);
  const btnFloatingSkip = $('btnFloatingSkipIntro');
  if (btnFloatingSkip) btnFloatingSkip.addEventListener('click', doSkipIntro);

  // Outroyu Atla / Sonraki Bölüm
  const btnFloatingSkipOutro = $('btnFloatingSkipOutro');
  if (btnFloatingSkipOutro) {
    btnFloatingSkipOutro.addEventListener('click', () => {
      btnFloatingSkipOutro.classList.add('hidden');
      if (state.currentIntro && state.currentIntro.outro) {
        showToast('Outro Atlandı · Sonraki Bölüm Aranıyor…');
        goNextEpisode();
      }
    });
  }

  // Oynatıcı Hızlı Ayarlar Açılır Menüsü (Quick Settings)
  const btnPlayerQuickSettings = $('btnPlayerQuickSettings');
  const btnCloseQuickSettings = $('btnCloseQuickSettings');
  const btnPlayerOpenFullSettings = $('btnPlayerOpenFullSettings');
  const quickBufferModeSelector = $('quickBufferModeSelector');

  function toggleQuickSettings(show) {
    if (!quickSettingsMenu) return;
    const isHidden = quickSettingsMenu.classList.contains('hidden');
    const shouldOpen = show !== undefined ? show : isHidden;
    quickSettingsMenu.classList.toggle('hidden', !shouldOpen);
    if (shouldOpen) {
      if (quickBufferModeSelector && state.settings) {
        quickBufferModeSelector.value = state.settings.bufferMode || 'balanced';
      }
    }
  }

  if (btnPlayerQuickSettings) {
    btnPlayerQuickSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQuickSettings();
    });
  }
  if (btnCloseQuickSettings) {
    btnCloseQuickSettings.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleQuickSettings(false);
    });
  }
  if (btnPlayerOpenFullSettings) {
    btnPlayerOpenFullSettings.addEventListener('click', () => {
      toggleQuickSettings(false);
      openSettings();
    });
  }
  if (quickBufferModeSelector) {
    quickBufferModeSelector.addEventListener('change', async (e) => {
      const mode = e.target.value;
      player.setBufferMode(mode);
      state.settings.bufferMode = mode;
      const sBuf = $('settingBufferMode');
      if (sBuf) sBuf.value = mode;
      if (mk && mk.updateSettings) {
        await mk.updateSettings({ bufferMode: mode });
      }
      showToast(`Tampon profili: ${mode === 'aggressive' ? 'Agresif (180s)' : (mode === 'normal' ? 'Normal (30s)' : 'Dengeli (60s)')}`);
    });
  }

  // ---------- MediaSession API Entegrasyonu (Donanım Medya Tuşları & Windows Medya Kartı) ----------
  function updateMediaSession(meta = {}) {
    if (!('mediaSession' in navigator)) return;
    try {
      const bestTitle = meta.title || $('currentVideoTitle')?.textContent || 'Video';
      const anime = state.discover && state.discover.selectedAnime;
      const artwork = (anime && anime.cover) ? [{ src: anime.cover, sizes: '512x512', type: 'image/jpeg' }] : [];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: bestTitle,
        artist: anime ? (anime.titleRomaji || anime.title) : 'MK VideoPlayer',
        album: anime ? `${anime.title} · MK Player` : 'MK VideoPlayer',
        artwork: artwork,
      });

      navigator.mediaSession.setActionHandler('play', () => player.play());
      navigator.mediaSession.setActionHandler('pause', () => player.pause());
      navigator.mediaSession.setActionHandler('seekbackward', () => {
        const s = getSeekStep();
        player.seekBy(-s);
        showToast(`-${s} sn`);
      });
      navigator.mediaSession.setActionHandler('seekforward', () => {
        const s = getSeekStep();
        player.seekBy(s);
        showToast(`+${s} sn`);
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => goPrevEpisode());
      navigator.mediaSession.setActionHandler('nexttrack', () => goNextEpisode());
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details && typeof details.seekTime === 'number') {
          player.seekTo(details.seekTime);
        }
      });
    } catch (_) {}
  }

  function syncMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: video.duration,
        playbackRate: video.playbackRate || 1,
        position: Math.min(video.duration, Math.max(0, video.currentTime || 0)),
      });
    } catch (_) {}
  }

  video.addEventListener('durationchange', syncMediaSessionPosition);
  video.addEventListener('play', syncMediaSessionPosition);
  video.addEventListener('pause', syncMediaSessionPosition);
  video.addEventListener('ratechange', syncMediaSessionPosition);

  // ---------- Altyazı ve Senkronizasyon Sistemi ----------
  let currentSubtitleBlobUrl = null;
  let subtitleOffsetSeconds = 0;
  let hlsSubtitleTracks = [];
  let customSubtitleName = null;

  const btnSubtitles = $('btnSubtitles');
  const subtitlesMenu = $('subtitlesMenu');
  const btnCloseSubtitlesMenu = $('btnCloseSubtitlesMenu');
  const subtitleTrackSelect = $('subtitleTrackSelect');
  const subtitleFileInput = $('subtitleFileInput');
  const btnUploadSubtitleFile = $('btnUploadSubtitleFile');
  const btnSubSyncMinus = $('btnSubSyncMinus');
  const btnSubSyncReset = $('btnSubSyncReset');
  const btnSubSyncPlus = $('btnSubSyncPlus');
  const subtitleSizeSelect = $('subtitleSizeSelect');

  function toggleSubtitlesMenu(show) {
    if (!subtitlesMenu) return;
    const isHidden = subtitlesMenu.classList.contains('hidden');
    const shouldOpen = show !== undefined ? show : isHidden;
    subtitlesMenu.classList.toggle('hidden', !shouldOpen);
  }

  if (btnSubtitles) {
    btnSubtitles.addEventListener('click', (e) => {
      e.stopPropagation();
      if (quickSettingsMenu) quickSettingsMenu.classList.add('hidden');
      if (modeMenu) modeMenu.classList.add('hidden');
      toggleSubtitlesMenu();
    });
  }
  if (btnCloseSubtitlesMenu) {
    btnCloseSubtitlesMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSubtitlesMenu(false);
    });
  }

  function clearCustomSubtitles() {
    const existing = video.querySelectorAll('track');
    existing.forEach((t) => t.remove());
    if (currentSubtitleBlobUrl) {
      try { URL.revokeObjectURL(currentSubtitleBlobUrl); } catch (_) {}
      currentSubtitleBlobUrl = null;
    }
    customSubtitleName = null;
  }

  function updateSubtitleTracksUI() {
    if (!subtitleTrackSelect) return;
    const opts = [new Option('Kapalı', 'off')];

    if (customSubtitleName) {
      opts.push(new Option(`Yerel: ${customSubtitleName}`, 'custom'));
    }

    if (hlsSubtitleTracks && hlsSubtitleTracks.length > 0) {
      hlsSubtitleTracks.forEach((t) => {
        opts.push(new Option(`Dahili: ${t.name || t.lang || `Kanal ${t.index + 1}`}`, `hls_${t.index}`));
      });
    }

    subtitleTrackSelect.replaceChildren(...opts);
    subtitleTrackSelect.value = state.subtitles ? state.subtitles.currentTrack : 'off';
  }

  function loadSubtitleContent(content, label = 'Yerel Altyazı') {
    clearCustomSubtitles();
    subtitleOffsetSeconds = 0;
    updateSubtitleOffsetUI();

    let vttText = '';
    if (window.MKPlayer && typeof window.MKPlayer.srtToVtt === 'function') {
      vttText = window.MKPlayer.srtToVtt(content);
    } else {
      vttText = 'WEBVTT\n\n' + content.replace(/\r\n|\r/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    }

    const blob = new Blob([vttText], { type: 'text/vtt' });
    currentSubtitleBlobUrl = URL.createObjectURL(blob);
    customSubtitleName = label;

    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = label;
    track.srclang = 'tr';
    track.src = currentSubtitleBlobUrl;
    track.default = true;

    video.appendChild(track);

    if (state.subtitles) state.subtitles.currentTrack = 'custom';
    updateSubtitleTracksUI();

    setTimeout(() => {
      if (video.textTracks && video.textTracks.length > 0) {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode = 'showing';
        }
      }
    }, 150);

    showToast(`Altyazı yüklendi: ${label}`);
  }

  function handleSubtitleFile(file) {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (!name.endsWith('.srt') && !name.endsWith('.vtt') && !name.endsWith('.txt')) {
      showToast('Yalnızca .srt veya .vtt uzantılı altyazı dosyaları desteklenir', 3500);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      loadSubtitleContent(e.target.result, file.name);
    };
    reader.readAsText(file, 'utf-8');
  }

  if (btnUploadSubtitleFile && subtitleFileInput) {
    btnUploadSubtitleFile.addEventListener('click', () => {
      subtitleFileInput.click();
    });
    subtitleFileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleSubtitleFile(e.target.files[0]);
      }
    });
  }

  // Sürükle & Bırak ile Altyazı Ekleme
  playerContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    playerContainer.classList.add('ring-2', 'ring-brand-500');
  });
  playerContainer.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    playerContainer.classList.remove('ring-2', 'ring-brand-500');
  });
  playerContainer.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    playerContainer.classList.remove('ring-2', 'ring-brand-500');
    const files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 0) {
      handleSubtitleFile(files[0]);
    }
  });

  function updateSubtitleOffsetUI() {
    const disp = $('subtitleOffsetDisplay');
    if (disp) {
      disp.textContent = `${subtitleOffsetSeconds > 0 ? '+' : ''}${subtitleOffsetSeconds.toFixed(1)} sn`;
    }
  }

  function adjustSubtitleOffset(delta) {
    subtitleOffsetSeconds = Math.round((subtitleOffsetSeconds + delta) * 10) / 10;
    updateSubtitleOffsetUI();

    if (video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i];
        if (track && track.cues) {
          for (let j = 0; j < track.cues.length; j++) {
            const cue = track.cues[j];
            cue.startTime = Math.max(0, cue.startTime + delta);
            cue.endTime = Math.max(0, cue.endTime + delta);
          }
        }
      }
    }
    showToast(`Altyazı senkronu: ${subtitleOffsetSeconds > 0 ? '+' : ''}${subtitleOffsetSeconds.toFixed(1)} sn`);
  }

  if (btnSubSyncMinus) btnSubSyncMinus.addEventListener('click', () => adjustSubtitleOffset(-0.5));
  if (btnSubSyncReset) btnSubSyncReset.addEventListener('click', () => adjustSubtitleOffset(-subtitleOffsetSeconds));
  if (btnSubSyncPlus) btnSubSyncPlus.addEventListener('click', () => adjustSubtitleOffset(0.5));

  function setSubtitleSize(size) {
    if (state.subtitles) state.subtitles.size = size;
    playerContainer.classList.remove('sub-size-sm', 'sub-size-md', 'sub-size-lg');
    playerContainer.classList.add(`sub-size-${size}`);
  }
  if (subtitleSizeSelect) {
    subtitleSizeSelect.addEventListener('change', (e) => setSubtitleSize(e.target.value));
  }

  function setSubtitleTrackSelection(val) {
    if (state.subtitles) state.subtitles.currentTrack = val;
    if (subtitleTrackSelect) subtitleTrackSelect.value = val;

    if (val === 'off') {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode = 'disabled';
        }
      }
      player.setSubtitleTrack(-1);
      showToast('Altyazı: Kapalı');
    } else if (val === 'custom') {
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode = 'showing';
        }
      }
      player.setSubtitleTrack(-1);
      showToast(`Altyazı: ${customSubtitleName || 'Yerel Altyazı'}`);
    } else if (val.startsWith('hls_')) {
      const idx = parseInt(val.replace('hls_', ''), 10);
      if (video.textTracks) {
        for (let i = 0; i < video.textTracks.length; i++) {
          video.textTracks[i].mode = 'disabled';
        }
      }
      player.setSubtitleTrack(idx);
      const t = hlsSubtitleTracks.find((x) => x.index === idx);
      showToast(`Altyazı: ${t ? (t.name || t.lang) : 'Dahili Altyazı'}`);
    }
  }

  if (subtitleTrackSelect) {
    subtitleTrackSelect.addEventListener('change', (e) => {
      setSubtitleTrackSelection(e.target.value);
    });
  }

  function toggleSubtitles() {
    if (state.subtitles && state.subtitles.currentTrack === 'off') {
      if (customSubtitleName) {
        setSubtitleTrackSelection('custom');
      } else if (hlsSubtitleTracks.length > 0) {
        setSubtitleTrackSelection('hls_0');
      } else {
        showToast('Henüz altyazı yüklenmedi (C tuşu veya Altyazı menüsünden yükleyin)');
      }
    } else {
      setSubtitleTrackSelection('off');
    }
  }

  // ---------- Anime Görüntü İyileştirici & En-Boy Oranı ----------
  function setEnhancerMode(mode) {
    if (state.enhancer) state.enhancer.mode = mode;
    video.classList.remove('enhance-anime-hd', 'enhance-anime-smooth', 'enhance-anime-vivid', 'enhance-anime-ultra');
    if (mode && mode !== 'none') {
      video.classList.add(`enhance-${mode}`);
    }
    const sel = $('videoEnhanceSelector');
    if (sel) sel.value = mode;

    const labels = {
      'none': 'Filtresiz (Orijinal)',
      'anime-hd': 'Anime HD (Çizgi Kurtarma & Deblock)',
      'anime-smooth': 'Pürüzsüz (Piksel & Çamur Eritici)',
      'anime-vivid': 'Canlı Renk & Derin Siyah',
      'anime-ultra': 'Ultra Restorasyon (Eski Anime)',
    };
    showToast(`Görüntü: ${labels[mode] || mode}`);
  }

  function cycleEnhancerMode() {
    const modes = ['none', 'anime-hd', 'anime-smooth', 'anime-vivid', 'anime-ultra'];
    const cur = (state.enhancer && state.enhancer.mode) || 'none';
    const curIdx = modes.indexOf(cur);
    const nextMode = modes[(curIdx + 1) % modes.length];
    setEnhancerMode(nextMode);
  }

  function setAspectRatio(ratio) {
    if (state.enhancer) state.enhancer.aspectRatio = ratio;
    video.classList.remove('aspect-16-9', 'aspect-4-3', 'aspect-cover');
    if (ratio === '16-9') {
      video.classList.add('aspect-16-9');
    } else if (ratio === '4-3') {
      video.classList.add('aspect-4-3');
    } else if (ratio === 'cover') {
      video.classList.add('aspect-cover');
    }
    const sel = $('aspectRatioSelector');
    if (sel) sel.value = ratio;

    const labels = {
      'auto': 'Otomatik (Orijinal)',
      '16-9': '16:9 Geniş Ekran',
      '4-3': '4:3 Klasik TV',
      'cover': '16:9 Doldur (Siyah Barsız)',
    };
    showToast(`En-Boy: ${labels[ratio] || ratio}`);
  }

  function cycleAspectRatio() {
    const ratios = ['auto', '16-9', '4-3', 'cover'];
    const cur = (state.enhancer && state.enhancer.aspectRatio) || 'auto';
    const curIdx = ratios.indexOf(cur);
    const nextRatio = ratios[(curIdx + 1) % ratios.length];
    setAspectRatio(nextRatio);
  }

  const videoEnhanceSelector = $('videoEnhanceSelector');
  if (videoEnhanceSelector) {
    videoEnhanceSelector.addEventListener('change', (e) => {
      setEnhancerMode(e.target.value);
    });
  }

  const aspectRatioSelector = $('aspectRatioSelector');
  if (aspectRatioSelector) {
    aspectRatioSelector.addEventListener('change', (e) => {
      setAspectRatio(e.target.value);
    });
  }

  window.addEventListener('click', (e) => {
    if (quickSettingsMenu && !quickSettingsMenu.classList.contains('hidden')) {
      if (!quickSettingsMenu.contains(e.target) && e.target !== btnPlayerQuickSettings && !btnPlayerQuickSettings?.contains(e.target)) {
        quickSettingsMenu.classList.add('hidden');
      }
    }
    if (subtitlesMenu && !subtitlesMenu.classList.contains('hidden')) {
      if (!subtitlesMenu.contains(e.target) && e.target !== btnSubtitles && !btnSubtitles?.contains(e.target)) {
        subtitlesMenu.classList.add('hidden');
      }
    }
  });

  playerContainer.classList.add('paused');
  let controlsIdleTimer = null;
  let lastMouseX = -1;
  let lastMouseY = -1;

  function hideControlsNow() {
    if (video.paused) return;
    const isMenuOpen = (quickSettingsMenu && !quickSettingsMenu.classList.contains('hidden')) ||
                       (subtitlesMenu && !subtitlesMenu.classList.contains('hidden')) ||
                       (modeMenu && !modeMenu.classList.contains('hidden'));
    if (isMenuOpen) return;
    playerContainer.classList.add('controls-hidden');
  }

  function resetControlsIdleTimer() {
    clearTimeout(controlsIdleTimer);
    if (!video.paused) {
      controlsIdleTimer = setTimeout(hideControlsNow, 2500);
    }
  }

  function showControls() {
    playerContainer.classList.remove('controls-hidden');
    resetControlsIdleTimer();
  }

  function onPointerActivity(e) {
    if (e && e.type === 'mousemove') {
      // Sentetik Chromium mousemove (timeupdate kaynaklı aynı koordinat) olaylarını filtrele
      if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
        if (e.clientX === lastMouseX && e.clientY === lastMouseY) {
          return;
        }
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
      }
    }
    showControls();
  }

  playerContainer.addEventListener('mousemove', onPointerActivity);
  playerContainer.addEventListener('mousedown', onPointerActivity);
  playerContainer.addEventListener('click', onPointerActivity);

  playerContainer.addEventListener('mouseleave', () => {
    lastMouseX = -1;
    lastMouseY = -1;
    if (!video.paused) {
      const isMenuOpen = (quickSettingsMenu && !quickSettingsMenu.classList.contains('hidden')) ||
                         (modeMenu && !modeMenu.classList.contains('hidden'));
      if (!isMenuOpen) {
        clearTimeout(controlsIdleTimer);
        playerContainer.classList.add('controls-hidden');
      }
    }
  });

  video.addEventListener('play', () => {
    playerContainer.classList.remove('paused');
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    overlay.classList.replace('opacity-100', 'opacity-0');
    cancelNextEpisodeCountdown();
    showControls();
  });
  video.addEventListener('pause', () => {
    playerContainer.classList.add('paused');
    playerContainer.classList.remove('controls-hidden');
    clearTimeout(controlsIdleTimer);
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    overlay.classList.replace('opacity-0', 'opacity-100');
    saveWatchProgress();
  });
  video.addEventListener('ended', () => {
    playerContainer.classList.add('paused');
    saveWatchProgress();
    loadHistory();
    if (state.settings && state.settings.autoNextEpisode !== false) {
      startAutoNextEpisodeCountdown();
    }
  });
  window.addEventListener('beforeunload', () => { saveWatchProgress(); });
  $('btnPlayPause').addEventListener('click', () => player.togglePlay());
  video.addEventListener('click', () => player.togglePlay());
  progressBar.addEventListener('input', (e) => {
    const val = Number(e.target.value) || 0;
    updateProgressBarUI(val);
    if (video.duration) player.seekTo((val / 100) * video.duration);
  });
  const getSeekStep = () => (state.settings && state.settings.seekStep) || 10;
  $('btnRewind10').addEventListener('click', () => { const s = getSeekStep(); player.seekBy(-s); showToast(`-${s} sn`); });
  $('btnForward10').addEventListener('click', () => { const s = getSeekStep(); player.seekBy(s); showToast(`+${s} sn`); });

  // Ses Yükseltici (%100 - %300 Boost)
  const boostSelector = $('audioBoostSelector');
  if (boostSelector) {
    boostSelector.addEventListener('change', async (e) => {
      const val = parseInt(e.target.value, 10);
      player.setAudioBoost(val);
      state.settings.audioBoost = val;
      if (mk && mk.updateSettings) {
        await mk.updateSettings({ audioBoost: val });
      }
      showToast(`Ses Yükseltici: %${val}`);
    });
  }

  // Favoriler (Bookmarks) Yönetimi
  async function updateBookmarkButton() {
    if (!mk || !mk.hasBookmark) return;
    const target = state.lastPageUrl || (state.nav && state.nav.url) || '';
    const isBm = await mk.hasBookmark(target);
    const outline = $('iconBookmarkOutline');
    const filled = $('iconBookmarkFilled');
    const btn = $('btnToggleBookmark');
    if (outline) outline.classList.toggle('hidden', isBm);
    if (filled) filled.classList.toggle('hidden', !isBm);
    if (btn) {
      btn.classList.toggle('text-amber-400', isBm);
      btn.title = isBm ? 'Favorilerden Kaldır' : 'Favorilere Ekle';
    }
  }

  async function toggleBookmark() {
    if (!mk) return;
    const target = state.lastPageUrl || (state.nav && state.nav.url) || '';
    if (!target) {
      showToast('Favorilere eklenecek geçerli bir video veya sayfa yok');
      return;
    }
    const title = $('currentVideoTitle').textContent || (state.nav && state.nav.title) || 'Video';
    let host = '';
    try { host = new URL(target).host; } catch (_) {}
    const res = await mk.toggleBookmark({
      title,
      pageUrl: target,
      streamUrl: player.current ? player.current.url : '',
      host,
    });
    if (res && res.added) {
      showToast('Favorilere eklendi');
    } else {
      showToast('Favorilerden kaldırıldı');
    }
    updateBookmarkButton();
    loadBookmarks();
  }

  const btnBm = $('btnToggleBookmark');
  if (btnBm) btnBm.addEventListener('click', toggleBookmark);

  async function loadBookmarks() {
    if (!mk || !mk.getBookmarks) return;
    try {
      const items = await mk.getBookmarks(state.bookmarkQuery);
      state.bookmarks = items || [];
      const countBadge = $('bookmarkCountBadge');
      if (countBadge) countBadge.textContent = String(state.bookmarks.length);
      const emptyEl = $('bookmarksEmpty');
      if (emptyEl) emptyEl.classList.toggle('hidden', state.bookmarks.length > 0);
      const listEl = $('bookmarksList');
      if (listEl) {
        window.MKRender.renderBookmarks(listEl, state.bookmarks, {
          onOpen: (item) => {
            if (item.pageUrl) {
              mk.go(item.pageUrl);
              setLayout('split');
            }
          },
          onDelete: async (item) => {
            await mk.removeBookmark(item.id);
            showToast('Favorilerden silindi');
            updateBookmarkButton();
            loadBookmarks();
          },
        });
      }
    } catch (_) {}
  }

  const bmSearch = $('bookmarkSearchInput');
  if (bmSearch) {
    let bmSearchTimer = null;
    bmSearch.addEventListener('input', (e) => {
      clearTimeout(bmSearchTimer);
      bmSearchTimer = setTimeout(() => {
        state.bookmarkQuery = e.target.value;
        loadBookmarks();
      }, 250);
    });
  }

  // Video İndirme ve Çevrimdışı İzleme Yönetimi
  async function startCurrentDownload() {
    if (!mk || !mk.startDownload) return;
    if (!player.current || !player.current.url) {
      showToast('İndirilecek aktif bir video akışı bulunmuyor');
      return;
    }
    const title = $('currentVideoTitle').textContent || 'Video';
    const kind = player.current.kind || 'mp4';
    const proxyUrl = player.current.url;
    await mk.startDownload({
      title,
      streamUrl: proxyUrl,
      proxyUrl,
      kind,
      pageUrl: state.lastPageUrl,
    });
    showToast('Bölüm indirilmeye başlandı (MP4)');
    setSideTab('downloads');
    loadDownloads();
  }

  const btnDl = $('btnDownloadStream');
  if (btnDl) btnDl.addEventListener('click', startCurrentDownload);

  async function loadDownloads() {
    if (!mk || !mk.getDownloads) return;
    try {
      const items = await mk.getDownloads();
      state.downloads = items || [];
      const countBadge = $('downloadCountBadge');
      if (countBadge) countBadge.textContent = String(state.downloads.length);
      const emptyEl = $('downloadsEmpty');
      if (emptyEl) emptyEl.classList.toggle('hidden', state.downloads.length > 0);
      const listEl = $('downloadsList');
      if (listEl) {
        window.MKRender.renderDownloads(listEl, state.downloads, {
          onPlay: async (item) => {
            const res = await mk.playOfflineDownload(item.id);
            if (res && res.ok) {
              playResult(res, { resumeUrl: res.proxyUrl });
              showToast('Çevrimdışı video oynatılıyor');
            } else {
              showToast('Yerel dosya açılamadı');
            }
          },
          onCancel: async (item) => {
            await mk.cancelDownload(item.id);
            showToast('İndirme iptal edildi');
            loadDownloads();
          },
          onDelete: async (item) => {
            await mk.deleteDownload(item.id);
            showToast('İndirilen dosya silindi');
            loadDownloads();
          },
        });
      }
    } catch (_) {}
  }

  // Yan Panel Sekme Geçişleri (Kaynaklar / Favoriler / İndirilenler / Engellenenler)
  function setSideTab(tabName) {
    state.activeTab = tabName;
    const tabs = [
      ['tabBtnStreams', 'tabContentStreams', 'streams'],
      ['tabBtnBookmarks', 'tabContentBookmarks', 'bookmarks'],
      ['tabBtnDownloads', 'tabContentDownloads', 'downloads'],
      ['tabBtnPopups', 'tabContentPopups', 'popups'],
    ];
    for (const [btnId, contentId, name] of tabs) {
      const btn = $(btnId);
      const content = $(contentId);
      const active = name === tabName;
      if (btn) {
        btn.classList.toggle('border-brand-500', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('border-transparent', !active);
        btn.classList.toggle('text-slate-400', !active);
      }
      if (content) {
        content.classList.toggle('hidden', !active);
      }
    }
    if (tabName === 'bookmarks') loadBookmarks();
    if (tabName === 'downloads') loadDownloads();
  }

  const tStreams = $('tabBtnStreams'); if (tStreams) tStreams.addEventListener('click', () => setSideTab('streams'));
  const tBookmarks = $('tabBtnBookmarks'); if (tBookmarks) tBookmarks.addEventListener('click', () => setSideTab('bookmarks'));
  const tDownloads = $('tabBtnDownloads'); if (tDownloads) tDownloads.addEventListener('click', () => setSideTab('downloads'));
  const tPopups = $('tabBtnPopups'); if (tPopups) tPopups.addEventListener('click', () => setSideTab('popups'));

  let volSaveTimer = null;
  function persistVolumeSettings() {
    if (!mk || !mk.updateSettings || !state.settings || !state.settings.rememberVolume) return;
    clearTimeout(volSaveTimer);
    volSaveTimer = setTimeout(() => {
      mk.updateSettings({
        lastVolume: video.volume,
        lastMuted: video.muted,
      });
    }, 800);
  }

  const volIcons = () => {
    const muted = video.muted || video.volume === 0;
    $('iconVolHigh').classList.toggle('hidden', muted);
    $('iconVolMuted').classList.toggle('hidden', !muted);
  };
  $('volumeSlider').addEventListener('input', (e) => { player.setVolume(parseFloat(e.target.value)); volIcons(); persistVolumeSettings(); });
  $('btnMute').addEventListener('click', () => { player.toggleMute(); volIcons(); persistVolumeSettings(); });
  $('fitSelector').addEventListener('change', (e) => {
    video.classList.remove('object-contain', 'object-cover', 'object-fill');
    video.classList.add(`object-${e.target.value}`);
  });
  $('speedSelector').addEventListener('change', (e) => { player.setRate(parseFloat(e.target.value)); showToast(`Hız: ${e.target.value}x`); });
  qualitySelector.addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val === 'highest' || val === 'lowest') {
      if (mk && mk.updateSettings) {
        await mk.updateSettings({ defaultQuality: val });
        state.settings.defaultQuality = val;
      }
      applyQualityPreference(val);
    } else if (val === '-1' || val === 'auto') {
      player.setQuality(-1);
      if (mk && mk.updateSettings) {
        await mk.updateSettings({ defaultQuality: 'auto' });
        state.settings.defaultQuality = 'auto';
      }
      showToast('Kalite: Otomatik');
    } else {
      const lvl = parseInt(val, 10);
      player.setQuality(lvl);
      const l = (state.currentLevels || []).find((x) => x.index === lvl);
      if (l && l.height && mk && mk.updateSettings) {
        await mk.updateSettings({ defaultQuality: String(l.height) });
        state.settings.defaultQuality = String(l.height);
      }
      showToast(lvl === -1 ? 'Kalite: Otomatik' : `Kalite sabitlendi: ${e.target.selectedOptions[0].textContent}`);
    }
    const qEl = $('settingDefaultQuality');
    if (qEl && state.settings) qEl.value = state.settings.defaultQuality;
  });

  // ---------- Görüntüleme Modları (Fullscreen, In Window, PiP) ----------
  const btnFs = $('btnFullscreen');
  const detachedOverlay = $('detachedOverlay');
  const btnReturnDetached = $('btnReturnFromDetached');

  function updateModeCheckmarks() {
    const isFs = !!document.fullscreenElement || state.displayMode === 'fullscreen';
    const isInWin = state.displayMode === 'in_window';
    const isPip = (document.pictureInPictureElement && document.pictureInPictureElement === video) || state.displayMode === 'pip';

    const checkFs = $('checkFullscreen');
    if (checkFs) checkFs.classList.toggle('hidden', !isFs);

    const checkInWin = $('checkInWindow');
    if (checkInWin) checkInWin.classList.toggle('hidden', !isInWin);

    const checkPip = $('checkPiP');
    if (checkPip) checkPip.classList.toggle('hidden', !isPip);
  }

  async function setDisplayMode(mode) {
    const prevMode = state.displayMode;

    // Aynı moda tekrar tıklanırsa (Fullscreen, In Window veya PiP) normal moda döner (toggle)
    if (mode === prevMode) {
      if (mode === 'in_window' || mode === 'fullscreen' || mode === 'pip') {
        mode = 'normal';
      } else {
        return;
      }
    }

    // Önceki moddan güvenli çıkış
    if (prevMode === 'fullscreen' && document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch (_) {}
    }
    if (prevMode === 'in_window' && mode !== 'in_window') {
      playerContainer.classList.remove('in-window-mode');
      if (mk && typeof mk.setBrowserVisible === 'function') {
        mk.setBrowserVisible(true);
      }
      syncBounds();
      if (detachedOverlay) detachedOverlay.classList.add('hidden');
    }
    if (prevMode === 'pip' && mode !== 'pip') {
      if (document.pictureInPictureElement) {
        try { await document.exitPictureInPicture(); } catch (_) {}
      }
      if (mk && typeof mk.closeInWindow === 'function') {
        mk.closeInWindow();
      }
      if (detachedOverlay) detachedOverlay.classList.add('hidden');
    }

    state.displayMode = mode;
    updateModeCheckmarks();

    switch (mode) {
      case 'fullscreen':
        if (detachedOverlay) detachedOverlay.classList.add('hidden');
        if (!document.fullscreenElement) {
          playerContainer.requestFullscreen().catch(() => {});
        }
        break;

      case 'in_window':
        if (detachedOverlay) detachedOverlay.classList.add('hidden');
        playerContainer.classList.add('in-window-mode');
        if (mk && typeof mk.setBrowserVisible === 'function') {
          mk.setBrowserVisible(false);
        }
        break;

      case 'pip':
        if (!player.current || !player.current.url) {
          showToast('Oynatılan bir video bulunmuyor');
          state.displayMode = 'normal';
          updateModeCheckmarks();
          return;
        }
        // 1. Gerçek yerel PiP API dene
        if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
          try {
            await video.requestPictureInPicture();
            state.displayMode = 'pip';
            updateModeCheckmarks();
            return;
          } catch (_) {
            /* Yerel PiP başarısız veya kısıtlıysa Electron yedek penceresine geç */
          }
        }
        // 2. Uygulama seviyesi PiP yedeği
        saveWatchProgress();
        player.pause();
        if (detachedOverlay) detachedOverlay.classList.remove('hidden');
        showToast('PiP penceresi açılıyor');
        if (mk && typeof mk.openPipFallback === 'function') {
          mk.openPipFallback({
            proxyUrl: player.current.url,
            kind: player.current.kind,
            currentTime: video.currentTime || 0,
            duration: video.duration || null,
            paused: false,
            volume: video.volume,
            muted: video.muted,
            playbackRate: video.playbackRate,
            title: $('currentVideoTitle').textContent || 'Video',
            historyId: state.activeHistoryId,
          });
        }
        break;

      case 'normal':
      default:
        state.displayMode = 'normal';
        updateModeCheckmarks();
        break;
    }
  }

  // Menü açma / kapama
  if (btnFs && modeMenu) {
    btnFs.addEventListener('click', (e) => {
      e.stopPropagation();
      modeMenu.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!modeMenu.contains(e.target) && e.target !== btnFs) {
        modeMenu.classList.add('hidden');
      }
    });
  }

  const mFs = $('modeFullscreen'); if (mFs) mFs.addEventListener('click', () => { modeMenu.classList.add('hidden'); setDisplayMode('fullscreen'); });
  const mInWin = $('modeInWindow'); if (mInWin) mInWin.addEventListener('click', () => { modeMenu.classList.add('hidden'); setDisplayMode('in_window'); });
  const mPip = $('modePiP'); if (mPip) mPip.addEventListener('click', () => { modeMenu.classList.add('hidden'); setDisplayMode('pip'); });

  if (btnReturnDetached) {
    btnReturnDetached.addEventListener('click', () => setDisplayMode('normal'));
  }

  // Ayrı pencereden geri dönüş dinleyicisi
  if (mk && typeof mk.onReturnToWindowed === 'function') {
    mk.onReturnToWindowed((detachedState) => {
      if (detachedOverlay) detachedOverlay.classList.add('hidden');
      state.displayMode = 'normal';
      updateModeCheckmarks();
      if (detachedState && Number.isFinite(detachedState.currentTime)) {
        player.seekTo(detachedState.currentTime);
        if (detachedState.volume !== undefined) player.setVolume(detachedState.volume);
        if (detachedState.playbackRate) player.setRate(detachedState.playbackRate);
        if (detachedState.muted !== undefined) {
          video.muted = !!detachedState.muted;
          volIcons();
        }
        saveWatchProgress();
        if (!detachedState.paused) player.play();
      }
    });
  }

  video.addEventListener('enterpictureinpicture', () => {
    state.displayMode = 'pip';
    updateModeCheckmarks();
  });

  video.addEventListener('leavepictureinpicture', () => {
    saveWatchProgress();
    if (state.displayMode === 'pip') {
      state.displayMode = 'normal';
      updateModeCheckmarks();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const isFs = !!document.fullscreenElement;
    $('iconEnterFs').classList.toggle('hidden', isFs);
    $('iconExitFs').classList.toggle('hidden', !isFs);
    if (isFs) {
      state.displayMode = 'fullscreen';
    } else {
      if (state.displayMode === 'fullscreen') {
        state.displayMode = 'normal';
      }
    }
    updateModeCheckmarks();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      const addr = $('addressInput');
      if (addr) {
        addr.focus();
        addr.select();
      }
      return;
    }
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName)) return;
    switch (e.code) {
      case 'Space': case 'KeyK': e.preventDefault(); player.togglePlay(); break;
      case 'ArrowLeft': case 'KeyJ': e.preventDefault(); { const s = getSeekStep(); player.seekBy(-s); showToast(`-${s} sn`); } break;
      case 'ArrowRight': case 'KeyL': e.preventDefault(); { const s = getSeekStep(); player.seekBy(s); showToast(`+${s} sn`); } break;
      case 'ArrowUp': e.preventDefault(); player.setVolume(video.volume + 0.1); video.muted = false; $('volumeSlider').value = video.volume; volIcons(); persistVolumeSettings(); showToast(`Ses: %${Math.round(video.volume * 100)}`); break;
      case 'ArrowDown': e.preventDefault(); player.setVolume(video.volume - 0.1); $('volumeSlider').value = video.volume; volIcons(); persistVolumeSettings(); showToast(`Ses: %${Math.round(video.volume * 100)}`); break;
      case 'KeyF': e.preventDefault(); setDisplayMode(state.displayMode === 'fullscreen' ? 'normal' : 'fullscreen'); break;
      case 'KeyI': e.preventDefault(); setDisplayMode(state.displayMode === 'pip' ? 'normal' : 'pip'); break;
      case 'KeyM': e.preventDefault(); player.toggleMute(); volIcons(); persistVolumeSettings(); showToast(video.muted ? 'Sessiz' : 'Ses açık'); break;
      case 'Slash':
        if (e.shiftKey || e.key === '?') {
          e.preventDefault();
          if (shortcutsModalEl && !shortcutsModalEl.classList.contains('hidden')) {
            closeShortcutsModal();
          } else {
            openShortcutsModal();
          }
        }
        break;
      case 'KeyS':
        e.preventDefault();
        if (e.shiftKey) {
          const out = (state.settings && state.settings.outroSkipSeconds) || 85;
          player.skipOutro(out);
          showToast(`Outro Atlandı (+${out} sn)`);
        } else {
          doSkipIntro();
        }
        break;
      case 'KeyC':
        e.preventDefault();
        toggleSubtitles();
        break;
      case 'KeyV':
        e.preventDefault();
        cycleEnhancerMode();
        break;
      case 'KeyA':
        e.preventDefault();
        cycleAspectRatio();
        break;
      case 'KeyN': e.preventDefault(); goNextEpisode(); break;
      case 'KeyP': e.preventDefault(); goPrevEpisode(); break;
      case 'BracketLeft': {
        e.preventDefault();
        const cur = video.playbackRate;
        const next = Math.max(0.25, Math.round((cur - 0.1) * 10) / 10);
        player.setRate(next);
        const sp = $('speedSelector');
        if (sp) {
          let opt = Array.from(sp.options).find((o) => Math.abs(parseFloat(o.value) - next) < 0.01);
          if (!opt) {
            opt = new Option(`${next.toFixed(1)}x`, String(next));
            sp.add(opt);
          }
          sp.value = opt.value;
        }
        showToast(`Hız: ${next.toFixed(1)}x`);
        break;
      }
      case 'BracketRight': {
        e.preventDefault();
        const cur = video.playbackRate;
        const next = Math.min(3.0, Math.round((cur + 0.1) * 10) / 10);
        player.setRate(next);
        const sp = $('speedSelector');
        if (sp) {
          let opt = Array.from(sp.options).find((o) => Math.abs(parseFloat(o.value) - next) < 0.01);
          if (!opt) {
            opt = new Option(`${next.toFixed(1)}x`, String(next));
            sp.add(opt);
          }
          sp.value = opt.value;
        }
        showToast(`Hız: ${next.toFixed(1)}x`);
        break;
      }
      case 'Backslash': {
        e.preventDefault();
        player.setRate(1.0);
        const sp = $('speedSelector');
        if (sp) sp.value = '1';
        showToast('Hız: 1.0x (Normal)');
        break;
      }
      case 'Escape':
        if (subtitlesMenu && !subtitlesMenu.classList.contains('hidden')) {
          subtitlesMenu.classList.add('hidden');
        } else if (quickSettingsMenu && !quickSettingsMenu.classList.contains('hidden')) {
          quickSettingsMenu.classList.add('hidden');
        } else if (shortcutsModalEl && !shortcutsModalEl.classList.contains('hidden')) {
          closeShortcutsModal();
        } else if (animeModalEl && !animeModalEl.classList.contains('hidden')) {
          closeAnimeModal();
        } else if (settingsModal && !settingsModal.classList.contains('hidden')) {
          closeSettings();
        } else if (modeMenu && !modeMenu.classList.contains('hidden')) {
          modeMenu.classList.add('hidden');
        } else if (state.displayMode !== 'normal') {
          setDisplayMode('normal');
        }
        break;
      default:
    }
  });

  // ---------- başlangıç ----------
  renderSources();
  if (!mk) {
    $('desktopWarning').classList.remove('hidden');
    loadTrendingAnime();
    return;
  }
  loadSettings();
  if (mk.onSettings) {
    mk.onSettings((s) => {
      if (s) {
        state.settings = { ...state.settings, ...s };
        syncSettingsInputs();
        applySettingsToApp();
      }
    });
  }
  mk.onNav((n) => {
    applyNav(n);
    updateBookmarkButton();
  });
  mk.onCapture(applyCapture);
  mk.onPopups(applyPopups);
  if (mk.onHistory) mk.onHistory(loadHistory);
  if (mk.onBookmarks) mk.onBookmarks(loadBookmarks);
  if (mk.onDownloads) mk.onDownloads(loadDownloads);
  if (mk.onDownloadProgress) mk.onDownloadProgress(() => loadDownloads());
  loadHistory();
  loadBookmarks();
  loadDownloads();
  mk.getState().then((s) => {
    applyNav(s.nav);
    applyPopups(s.popups);
    applyCapture(s.capture);
    syncBounds();
    updateBookmarkButton();
    if (state.layout === 'discover') {
      loadTrendingAnime();
    }
  });
})();
