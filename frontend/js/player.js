/* MK VideoPlayer oynatıcı denetleyicisi (UMD). DOM kimliklerinden bağımsızdır; test edilebilir.
 * - HLS: HLS.js (yoksa/desteklenmiyorsa yerel HLS, o da yoksa anlaşılır hata)
 * - MP4/WebM: HTML5 video (Range istekleri tarayıcı tarafından yapılır)
 * - Kurtarma denemeleri sınırlıdır; yeni kaynakta eski durum tamamen temizlenir. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MKPlayer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_NETWORK_RETRIES = 3;
  const MAX_MEDIA_RECOVERIES = 2;

  function hlsErrorCode(data, Hls) {
    const d = (data && data.details) || '';
    const status = data && data.response && data.response.code;
    if (status && status >= 400) return `upstream_${status}`;
    if (/key/i.test(d)) return 'hls_key';
    if (/manifest|playlist|level.*load/i.test(d)) return 'hls_manifest';
    if (data && Hls && data.type === Hls.ErrorTypes.NETWORK_ERROR) return 'hls_network';
    if (data && Hls && data.type === Hls.ErrorTypes.MEDIA_ERROR) return 'hls_media';
    return 'playback_failed';
  }

  function mediaErrorCode(err) {
    switch (err && err.code) {
      case 1: return 'media_aborted';
      case 2: return 'media_network';
      case 3: return 'media_decode';
      case 4: return 'media_not_supported';
      default: return 'playback_failed';
    }
  }

  function srtToVtt(srtText) {
    if (!srtText || typeof srtText !== 'string') return 'WEBVTT\n\n';
    const clean = srtText.replace(/\r\n|\r/g, '\n').trim();
    if (clean.startsWith('WEBVTT')) return clean;

    const vtt = 'WEBVTT\n\n' + clean
      .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return vtt;
  }

  function createPlayer({ video, Hls, onError, onToast, onQualities, onSubtitleTracks, onState, onReady, bufferMode = 'balanced' }) {
    const HlsClass = Hls || null;
    let hls = null;
    let current = null; // { url, kind }
    let networkRetries = 0;
    let mediaRecoveries = 0;
    let generation = 0;
    let currentBufferMode = bufferMode || 'balanced';

    // Web Audio API & Audio Boost (%100 - %300)
    let audioCtx = null;
    let sourceNode = null;
    let gainNode = null;
    let compressorNode = null;
    let analyserNode = null;
    let analyserData = null;
    let audioBoostMultiplier = 1.0;

    function ensureAudioNodes() {
      if (audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        return;
      }
      try {
        const AudioContextClass = (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
        if (!AudioContextClass) return;
        audioCtx = new AudioContextClass();
        sourceNode = audioCtx.createMediaElementSource(video);
        gainNode = audioCtx.createGain();
        gainNode.gain.setValueAtTime(audioBoostMultiplier, audioCtx.currentTime);

        compressorNode = audioCtx.createDynamicsCompressor();
        compressorNode.threshold.setValueAtTime(-12, audioCtx.currentTime);
        compressorNode.knee.setValueAtTime(30, audioCtx.currentTime);
        compressorNode.ratio.setValueAtTime(12, audioCtx.currentTime);
        compressorNode.attack.setValueAtTime(0.003, audioCtx.currentTime);
        compressorNode.release.setValueAtTime(0.25, audioCtx.currentTime);

        analyserNode = audioCtx.createAnalyser();
        analyserNode.fftSize = 256;
        analyserData = new Uint8Array(analyserNode.frequencyBinCount);

        sourceNode.connect(gainNode);
        gainNode.connect(compressorNode);
        compressorNode.connect(audioCtx.destination);
        gainNode.connect(analyserNode);

        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
      } catch (_) {
        // Test veya desteklenmeyen tarayıcı ortamlarında sessizce yoksay
      }
    }

    function resumeAudioIfNeeded() {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }
    }

    function getAudioEnergy() {
      if (!analyserNode) {
        ensureAudioNodes();
      }
      if (!analyserNode || !analyserData) return 0;
      analyserNode.getByteFrequencyData(analyserData);
      let sum = 0;
      for (let i = 0; i < analyserData.length; i++) {
        sum += analyserData[i];
      }
      return sum / (analyserData.length * 255);
    }

    function setAudioBoost(percent) {
      const pct = Math.max(100, Math.min(300, Number(percent) || 100));
      audioBoostMultiplier = pct / 100;
      // Normal ses seviyesinde (%100) yerel donanım ses hattını koru;
      // Yalnızca kullanıcı yükseltme istediğinde (> %100) Web Audio düğümlerini bağla.
      if (pct > 100) {
        ensureAudioNodes();
        if (gainNode && audioCtx) {
          resumeAudioIfNeeded();
          gainNode.gain.setValueAtTime(audioBoostMultiplier, audioCtx.currentTime);
        }
      } else if (gainNode && audioCtx) {
        gainNode.gain.setValueAtTime(1.0, audioCtx.currentTime);
      }
      return pct;
    }

    const toast = (m) => { if (onToast) onToast(m); };
    const fail = (code, extra) => {
      generation += 1; // yok edilen motordan gelen gecikmiş olaylar yok sayılsın
      destroyEngine();
      if (onError) onError({ code, ...(extra || {}) });
    };

    function destroyEngine() {
      if (hls) {
        try { hls.destroy(); } catch (_) { /* yoksay */ }
        hls = null;
      }
    }

    function clearVideo() {
      try { video.pause(); } catch (_) { /* yoksay */ }
      try {
        video.removeAttribute('src');
        if (typeof video.load === 'function') video.load();
      } catch (_) { /* yoksay */ }
    }

    function reset() {
      generation += 1;
      destroyEngine();
      clearVideo();
      networkRetries = 0;
      mediaRecoveries = 0;
      if (onQualities) onQualities([]);
      if (onSubtitleTracks) onSubtitleTracks([]);
    }

    let stallCheckTimer = null;
    video.addEventListener('error', () => {
      if (!current || hls) return; // HLS.js hatalarını kendi işleyicisi yönetir
      fail(mediaErrorCode(video.error));
    });

    video.addEventListener('waiting', () => {
      clearTimeout(stallCheckTimer);
      stallCheckTimer = setTimeout(() => {
        if (!video.paused && !video.ended && video.readyState < 3) {
          if (hls && typeof hls.startLoad === 'function') {
            hls.startLoad();
          }
          if (video.buffered && video.buffered.length > 0) {
            const cur = video.currentTime;
            for (let i = 0; i < video.buffered.length; i++) {
              if (video.buffered.start(i) <= cur + 0.6 && cur < video.buffered.end(i)) {
                video.currentTime = Math.min(video.buffered.end(i) - 0.05, cur + 0.15);
                break;
              }
            }
          }
        }
      }, 1500);
    });

    video.addEventListener('playing', () => {
      clearTimeout(stallCheckTimer);
      resumeAudioIfNeeded();
    });
    video.addEventListener('play', resumeAudioIfNeeded);

    const bufferProfiles = {
      normal: { maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 60 * 1024 * 1024, backBufferLength: 30 },
      balanced: { maxBufferLength: 60, maxMaxBufferLength: 120, maxBufferSize: 120 * 1024 * 1024, backBufferLength: 60 },
      aggressive: { maxBufferLength: 180, maxMaxBufferLength: 300, maxBufferSize: 250 * 1024 * 1024, backBufferLength: 90 },
    };

    function startHls(url, generationAtStart, startTime) {
      const bufConf = bufferProfiles[currentBufferMode] || bufferProfiles.balanced;
      hls = new HlsClass({
        capLevelToPlayerSize: false,
        maxBufferLength: bufConf.maxBufferLength,
        maxMaxBufferLength: bufConf.maxMaxBufferLength,
        maxBufferSize: bufConf.maxBufferSize,
        backBufferLength: bufConf.backBufferLength,
        autoStartLoad: true,
        startPosition: startTime || -1,
        progressive: true,
        enableWorker: true,
        lowLatencyMode: false,
        startFragPrefetch: true,
        maxBufferHole: 1.5,
        maxSeekHole: 2.0,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 8,
        fragLoadingTimeOut: 20000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 500,
        fragLoadingMaxRetryTimeout: 4000,
        manifestLoadingTimeOut: 15000,
        manifestLoadingMaxRetry: 4,
        levelLoadingTimeOut: 15000,
        levelLoadingMaxRetry: 4,
        abrBandWidthFactor: 0.85,
        abrBandWidthUpFactor: 0.7,
      });
      const engine = hls;

      let seekApplied = false;
      const applyStartTime = () => {
        if (seekApplied || !startTime || startTime <= 0) return;
        if (generationAtStart !== generation) return;
        try {
          if (Math.abs(video.currentTime - startTime) > 1.0) {
            video.currentTime = startTime;
          }
          seekApplied = true;
        } catch (_) {}
      };

      engine.on(HlsClass.Events.MANIFEST_PARSED, (_e, data) => {
        if (generationAtStart !== generation) return;
        const levels = (data.levels || []).map((l, i) => ({ index: i, height: l.height || null, bitrate: l.bitrate || null }));
        if (onQualities) onQualities(levels);
        if (onSubtitleTracks && engine.subtitleTracks) {
          const tracks = (engine.subtitleTracks || []).map((t, i) => ({
            index: i,
            id: t.id !== undefined ? t.id : i,
            name: t.name || t.lang || `Altyazı ${i + 1}`,
            lang: t.lang || '',
          }));
          onSubtitleTracks(tracks);
        }
        if (startTime && startTime > 0) {
          if (typeof engine.startLoad === 'function') {
            engine.startLoad(startTime);
          }
          if (video.readyState >= 1) {
            applyStartTime();
          } else {
            video.addEventListener('loadedmetadata', applyStartTime, { once: true });
          }
        }
        if (onReady) onReady();
      });

      if (HlsClass.Events && HlsClass.Events.SUBTITLE_TRACKS_UPDATED) {
        engine.on(HlsClass.Events.SUBTITLE_TRACKS_UPDATED, (_e, data) => {
          if (generationAtStart !== generation) return;
          const tracks = (data.subtitleTracks || engine.subtitleTracks || []).map((t, i) => ({
            index: i,
            id: t.id !== undefined ? t.id : i,
            name: t.name || t.lang || `Altyazı ${i + 1}`,
            lang: t.lang || '',
          }));
          if (onSubtitleTracks) onSubtitleTracks(tracks);
        });
      }

      engine.on(HlsClass.Events.LEVEL_LOADED, () => {
        if (startTime && startTime > 0 && !seekApplied) {
          applyStartTime();
        }
      });

      engine.on(HlsClass.Events.FRAG_BUFFERED, () => {
        if (startTime && startTime > 0 && !seekApplied) {
          applyStartTime();
        }
      });

      video.addEventListener('canplay', applyStartTime, { once: true });
      engine.on(HlsClass.Events.LEVEL_SWITCHED, (_e, data) => {
        const l = engine.levels && engine.levels[data.level];
        if (l && l.height) toast(`Çözünürlük: ${l.height}p`);
      });
      engine.on(HlsClass.Events.ERROR, (_e, data) => {
        if (generationAtStart !== generation || !data) return;

        // Donma / Takılma (Stall) durumunda otomatik tampon kurtarma
        if (data.details === 'bufferStalledError') {
          if (!video.paused && video.readyState >= 2) {
            video.currentTime += 0.1;
          }
          if (typeof engine.startLoad === 'function') {
            engine.startLoad();
          }
          return;
        }

        if (!data.fatal) return;
        if (data.type === HlsClass.ErrorTypes.NETWORK_ERROR) {
          const status = data.response && data.response.code;
          const permanent = status === 401 || status === 403 || status === 404 || status === 410;
          if (!permanent && networkRetries < MAX_NETWORK_RETRIES) {
            networkRetries += 1;
            toast(`Ağ hatası, yeniden deneniyor (${networkRetries}/${MAX_NETWORK_RETRIES})`);
            engine.startLoad();
            return;
          }
        } else if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR) {
          if (mediaRecoveries < MAX_MEDIA_RECOVERIES) {
            mediaRecoveries += 1;
            if (mediaRecoveries === 2 && typeof engine.swapAudioCodec === 'function') engine.swapAudioCodec();
            engine.recoverMediaError();
            return;
          }
        }
        fail(hlsErrorCode(data, HlsClass));
      });
      engine.loadSource(url);
      engine.attachMedia(video);
    }

    function load({ url, kind, startTime }) {
      reset();
      if (!url) { fail('no_source'); return false; }
      current = { url, kind };
      const g = generation;
      if (kind === 'hls') {
        if (HlsClass && typeof HlsClass.isSupported === 'function' && HlsClass.isSupported()) {
          startHls(url, g, startTime);
          return true;
        }
        if (typeof video.canPlayType === 'function' && video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = url;
          if (onReady) onReady();
          return true;
        }
        fail(HlsClass ? 'hls_unsupported' : 'hls_unavailable');
        return false;
      }
      if (kind === 'mp4' || kind === 'webm') {
        video.src = url;
        if (startTime && startTime > 0) {
          if (video.readyState >= 1) {
            try { video.currentTime = startTime; } catch (_) {}
          } else {
            video.addEventListener('loadedmetadata', () => {
              try { video.currentTime = startTime; } catch (_) {}
            }, { once: true });
          }
        }
        if (onReady) onReady();
        return true;
      }
      fail('media_not_supported');
      return false;
    }

    /** Hata sonrası aynı kaynağı, mümkünse kaldığı yerden yeniden yükler. */
    function reload() {
      if (!current) return false;
      const t = Number.isFinite(video.currentTime) ? video.currentTime : 0;
      return load({ ...current, startTime: t > 5 ? t : 0 });
    }

    function play() {
      resumeAudioIfNeeded();
      const p = video.play();
      if (p && p.catch) p.catch(() => {});
    }
    function pause() { video.pause(); }
    function togglePlay() { if (video.paused || video.ended) play(); else pause(); }
    function seekTo(t) {
      const d = Number.isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.max(0, Math.min(d, t));
    }
    function seekBy(delta) { seekTo((video.currentTime || 0) + delta); }
    function skipIntro(seconds = 85) {
      const s = Math.max(1, Number(seconds) || 85);
      seekBy(s);
      return s;
    }
    function skipOutro(seconds = 85) {
      const s = Math.max(1, Number(seconds) || 85);
      seekBy(s);
      return s;
    }
    function setRate(r) {
      const rate = Math.max(0.25, Math.min(3.0, Number(r) || 1.0));
      video.preservesPitch = true;
      if ('mozPreservesPitch' in video) video.mozPreservesPitch = true;
      if ('webkitPreservesPitch' in video) video.webkitPreservesPitch = true;
      video.playbackRate = rate;
      return rate;
    }
    function setVolume(v) { video.volume = Math.max(0, Math.min(1, v)); video.muted = video.volume === 0; }
    function toggleMute() { video.muted = !video.muted; }
    function setBufferMode(mode) {
      if (bufferProfiles[mode]) {
        currentBufferMode = mode;
        return true;
      }
      return false;
    }
    function getBufferProgress() {
      if (!video.buffered || video.buffered.length === 0 || !video.duration) return 0;
      const cur = video.currentTime || 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= cur && cur <= video.buffered.end(i)) {
          return Math.min(100, (video.buffered.end(i) / video.duration) * 100);
        }
      }
      return Math.min(100, (video.buffered.end(video.buffered.length - 1) / video.duration) * 100);
    }
    function setQuality(index) {
      if (!hls) return false;
      // nextLevel ile pürüzsüz geçiş: Video tamponu boşaltılmaz; mevcut kareler akmaya devam ederken
      // sonraki parçalar yeni çözünürlükten indirilir, böylece 1-2 saniyelik görüntü donması engellenir.
      if ('nextLevel' in hls) {
        hls.nextLevel = index;
      } else {
        hls.currentLevel = index;
      }
      return true;
    }
    function setSubtitleTrack(index) {
      if (!hls) return false;
      const idx = Number(index);
      if (typeof hls.subtitleTrack !== 'undefined') {
        hls.subtitleTrack = idx;
        return true;
      }
      return false;
    }

    function getSubtitleTracks() {
      if (!hls || !hls.subtitleTracks) return [];
      return hls.subtitleTracks.map((t, i) => ({
        index: i,
        id: t.id !== undefined ? t.id : i,
        name: t.name || t.lang || `Altyazı ${i + 1}`,
        lang: t.lang || '',
      }));
    }

    function destroy() {
      reset();
      if (audioCtx && typeof audioCtx.close === 'function') {
        try { audioCtx.close().catch(() => {}); } catch (_) {}
        audioCtx = null;
      }
      current = null;
    }

    return {
      load, reload, destroy, play, pause, togglePlay, seekTo, seekBy, skipIntro, skipOutro,
      setRate, setVolume, toggleMute, setQuality, setAudioBoost, setBufferMode, getBufferProgress,
      getAudioEnergy, ensureAudioNodes, setSubtitleTrack, getSubtitleTracks,
      get current() { return current; },
      get engine() { return hls; },
      get retries() { return { network: networkRetries, media: mediaRecoveries }; },
    };
  }

  return { createPlayer, srtToVtt, hlsErrorCode, mediaErrorCode, MAX_NETWORK_RETRIES, MAX_MEDIA_RECOVERIES };
});
