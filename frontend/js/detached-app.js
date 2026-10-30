'use strict';
/**
 * MK VideoPlayer - Ayrı Pencere (In Window) Oynatıcı Mantığı
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const mk = window.mk || null;

  const video = $('videoElement');
  const playerContainer = $('playerContainer');
  const progressBar = $('progressBar');
  const toastEl = $('playerToast');
  const iconPlay = $('iconPlay');
  const iconPause = $('iconPause');
  const overlay = $('centerPlayOverlay');

  let activeState = null;
  let toastTimer = null;

  function showToast(msg, ms = 3000) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  }

  function setQualities(levels) {
    activeState.levels = levels || [];
    const sel = $('qualitySelector');
    if (!sel) return;
    const opts = [new Option('Kalite: Otomatik', '-1')];
    if (levels && levels.length > 0) {
      opts.push(new Option('En Yüksek', 'highest'));
      opts.push(new Option('En Düşük', 'lowest'));
      levels.forEach((l) => opts.push(new Option(`${l.height || '?'}p`, String(l.index))));
    }
    sel.replaceChildren(...opts);
  }

  const player = window.MKPlayer.createPlayer({
    video,
    Hls: window.Hls || null,
    onToast: showToast,
    onQualities: setQualities,
    onError: ({ code }) => showToast(`Oynatma hatası: ${code}`),
  });

  // State senkronizasyonu
  function getCurrentState() {
    return {
      currentTime: video.currentTime || 0,
      duration: video.duration || null,
      paused: video.paused,
      volume: video.volume,
      muted: video.muted,
      playbackRate: video.playbackRate,
    };
  }

  function saveWatchProgress() {
    if (!mk || !activeState || !activeState.historyId) return;
    const cur = video.currentTime;
    const dur = video.duration;
    if (!Number.isFinite(cur) || cur < 0) return;
    const isCompleted = video.ended || (Number.isFinite(dur) && dur > 10 && cur >= dur - 15);
    mk.saveProgress({
      id: activeState.historyId,
      currentTime: cur,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null,
      completed: isCompleted,
    });
    if (typeof mk.reportDetachedState === 'function') {
      mk.reportDetachedState(getCurrentState());
    }
  }

  setInterval(() => {
    if (!video.paused && !video.ended) {
      saveWatchProgress();
    }
  }, 2500);

  function returnToWindowed() {
    saveWatchProgress();
    if (mk && typeof mk.closeInWindow === 'function') {
      mk.closeInWindow(getCurrentState());
    } else {
      window.close();
    }
  }

  $('btnReturnToMain').addEventListener('click', returnToWindowed);
  window.addEventListener('beforeunload', () => {
    saveWatchProgress();
    if (mk && typeof mk.reportDetachedState === 'function') {
      mk.reportDetachedState(getCurrentState());
    }
  });

  // Oynatıcı kontrolleri
  let lastProgressSave = 0;

  // YouTube stili ilerleme çubuğu: yuvarlağın gerisini birebir aynı kırmızı (#ef4444) renk yap,
  // önünde tampon ve koyu kalan alanı göster (Screenshot 2 ile birebir uyumlu)
  function updateProgressBarUI(pct) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    progressBar.value = p;
    progressBar.style.background = `linear-gradient(to right, #ef4444 0%, #ef4444 ${p}%, #334155 ${p}%, #334155 100%)`;
  }

  // Oynatıcı kontrolleri ve imleç otomatik gizleme
  let controlsIdleTimer = null;
  let lastMouseX = -1;
  let lastMouseY = -1;

  function hideControlsNow() {
    if (video.paused) return;
    const modeMenu = $('displayModeMenu');
    if (modeMenu && !modeMenu.classList.contains('hidden')) return;
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
      const modeMenu = $('displayModeMenu');
      if (!modeMenu || modeMenu.classList.contains('hidden')) {
        clearTimeout(controlsIdleTimer);
        playerContainer.classList.add('controls-hidden');
      }
    }
  });

  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    updateProgressBarUI(pct);
    $('timeDisplay').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    const now = Date.now();
    if (now - lastProgressSave > 2500) {
      lastProgressSave = now;
      saveWatchProgress();
    }
  });
  video.addEventListener('play', () => {
    playerContainer.classList.remove('paused');
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    overlay.classList.replace('opacity-100', 'opacity-0');
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
  });

  let cachedSeekStep = 10;
  if (mk && mk.getSettings) {
    mk.getSettings().then((s) => {
      if (s && s.seekStep) {
        cachedSeekStep = s.seekStep;
        const r = $('btnRewind10'); if (r) { r.title = `${s.seekStep} sn geri`; r.setAttribute('aria-label', `${s.seekStep} saniye geri`); }
        const f = $('btnForward10'); if (f) { f.title = `${s.seekStep} sn ileri`; f.setAttribute('aria-label', `${s.seekStep} saniye ileri`); }
      }
    }).catch(() => {});
  }

  $('btnPlayPause').addEventListener('click', () => player.togglePlay());
  video.addEventListener('click', () => player.togglePlay());
  progressBar.addEventListener('input', (e) => {
    const val = Number(e.target.value) || 0;
    updateProgressBarUI(val);
    if (video.duration) player.seekTo((val / 100) * video.duration);
  });
  $('btnRewind10').addEventListener('click', () => { player.seekBy(-cachedSeekStep); showToast(`-${cachedSeekStep} sn`); });
  $('btnForward10').addEventListener('click', () => { player.seekBy(cachedSeekStep); showToast(`+${cachedSeekStep} sn`); });

  $('volumeSlider').addEventListener('input', (e) => player.setVolume(parseFloat(e.target.value)));
  $('btnMute').addEventListener('click', () => player.toggleMute());
  $('speedSelector').addEventListener('change', (e) => player.setRate(parseFloat(e.target.value)));
  $('qualitySelector').addEventListener('change', (e) => {
    const val = e.target.value;
    if (val === 'highest' || val === 'lowest') {
      const targetLvl = (window.MKClassify && typeof window.MKClassify.selectLevelByPreference === 'function')
        ? window.MKClassify.selectLevelByPreference(activeState.levels || [], val)
        : -1;
      player.setQuality(targetLvl);
    } else {
      player.setQuality(parseInt(val, 10));
    }
  });

  // Menü kontrolleri
  const menu = $('displayModeMenu');
  const btnMenu = $('btnFullscreenMenu');
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target) && e.target !== btnMenu) menu.classList.add('hidden');
  });

  $('optFullscreen').addEventListener('click', () => {
    menu.classList.add('hidden');
    if (!document.fullscreenElement) playerContainer.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  });
  $('optInWindow').addEventListener('click', () => {
    menu.classList.add('hidden');
  });
  $('optWindowed').addEventListener('click', () => {
    menu.classList.add('hidden');
    returnToWindowed();
  });
  $('optPiP').addEventListener('click', async () => {
    menu.classList.add('hidden');
    if (document.pictureInPictureEnabled && !video.disablePictureInPicture) {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await video.requestPictureInPicture();
      } catch (_) {}
    }
  });

  // Klavye kısayolları
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) return;
    switch (e.code) {
      case 'Space': case 'KeyK': e.preventDefault(); player.togglePlay(); break;
      case 'ArrowLeft': case 'KeyJ': e.preventDefault(); player.seekBy(-cachedSeekStep); break;
      case 'ArrowRight': case 'KeyL': e.preventDefault(); player.seekBy(cachedSeekStep); break;
      case 'KeyF': e.preventDefault();
        if (!document.fullscreenElement) playerContainer.requestFullscreen().catch(() => {});
        else document.exitFullscreen().catch(() => {});
        break;
      case 'KeyM': e.preventDefault(); player.toggleMute(); break;
      case 'Escape':
        menu.classList.add('hidden');
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        break;
      default:
    }
  });

  // Başlangıç verisi alma
  if (mk && typeof mk.onDetachedInit === 'function') {
    mk.onDetachedInit((data) => {
      if (!data || !data.proxyUrl) return;
      activeState = data;
      if (data.title) document.title = `${data.title} - MK VideoPlayer`;
      player.load({
        url: data.proxyUrl,
        kind: data.kind || 'hls',
        startTime: data.currentTime || 0,
      });
      if (data.volume !== undefined) {
        player.setVolume(data.volume);
        const vs = $('volumeSlider'); if (vs) vs.value = String(data.volume);
      }
      if (data.muted !== undefined) {
        video.muted = !!data.muted;
        const iconVolHigh = $('iconVolHigh');
        const iconVolMuted = $('iconVolMuted');
        if (iconVolHigh && iconVolMuted) {
          iconVolHigh.classList.toggle('hidden', video.muted);
          iconVolMuted.classList.toggle('hidden', !video.muted);
        }
      }
      if (data.playbackRate) {
        player.setRate(data.playbackRate);
        const ss = $('speedSelector'); if (ss) ss.value = String(data.playbackRate);
      }
      if (!data.paused) player.play();
    });
  }
})();
