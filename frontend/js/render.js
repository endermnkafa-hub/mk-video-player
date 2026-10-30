/* Güvenli DOM üretimi (UMD). Uzak sayfalardan gelen metinler (host, etiket, URL...) YALNIZCA
 * textContent / setAttribute ile eklenir; innerHTML kullanılmaz. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MKRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KIND_LABEL = { hls: 'HLS', mp4: 'MP4', webm: 'WEBM', dash: 'DASH' };
  const AVAIL_LABEL = {
    detected: 'Algılandı',
    checking: 'Doğrulanıyor…',
    verified: 'Doğrulandı',
    unsupported: 'Desteklenmiyor',
    failed: 'Doğrulanamadı',
  };
  const REASON_LABEL = {
    dash_unsupported: 'DASH desteklenmiyor',
    drm_protected: 'DRM korumalı',
    invalid_manifest: 'Geçersiz manifest',
    timeout: 'Zaman aşımı',
    network_error: 'Ağ hatası',
    manifest_too_large: 'Manifest çok büyük',
  };

  function el(doc, tag, className, text) {
    const e = doc.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function formatResolution(s) {
    if (s.maxHeight) {
      const hs = [...new Set((s.variants || []).map((v) => v.height).filter(Boolean))].sort((a, b) => b - a);
      return hs.length > 1 ? `${hs.map((h) => h + 'p').join(' / ')}` : `${s.maxHeight}p`;
    }
    if (s.resolutionHint) return `~${s.resolutionHint}p`;
    return '—';
  }

  function formatStatus(s) {
    if (s.playability === 'playable') return 'Oynatılabilir';
    if (s.playability === 'failed') return 'Oynatılamadı';
    let t = AVAIL_LABEL[s.availability] || String(s.availability);
    if (s.reason) {
      const http = /^http_(\d+)$/.exec(String(s.reason));
      t += ` (${REASON_LABEL[s.reason] || (http ? 'HTTP ' + http[1] : s.reason)})`;
    }
    return t;
  }

  function shortPath(url) {
    try { const u = new URL(url); return (u.pathname.length > 40 ? '…' + u.pathname.slice(-38) : u.pathname); } catch (_) { return ''; }
  }

  function sourceRow(doc, s, { onPlay, activeId }) {
    const row = el(doc, 'div', 'source-row p-3 rounded-lg border flex items-center justify-between gap-2 transition-colors '
      + (s.id === activeId ? 'bg-brand-600/20 border-brand-500' : 'bg-slate-950/80 border-slate-800 hover:bg-slate-800/80'));
    row.dataset.sourceId = String(s.id);
    const info = el(doc, 'div', 'flex-1 min-w-0');
    const top = el(doc, 'div', 'flex items-center gap-1.5');
    top.appendChild(el(doc, 'span', 'kind-badge px-1.5 py-0.5 rounded text-[10px] font-bold '
      + (s.kind === 'hls' ? 'bg-indigo-900/80 text-indigo-300' : 'bg-emerald-900/80 text-emerald-300'),
    KIND_LABEL[s.kind] || String(s.kind).toUpperCase()));
    top.appendChild(el(doc, 'span', 'host text-xs font-medium text-slate-200 truncate', s.host || '?'));
    info.appendChild(top);
    const meta = el(doc, 'p', 'meta text-[11px] text-slate-400 truncate mt-0.5',
      `Çözünürlük: ${formatResolution(s)} · ${s.live ? 'Canlı · ' : ''}${s.encryption === 'aes-128' ? 'AES-128 · ' : ''}${formatStatus(s)}`);
    info.appendChild(meta);
    const path = el(doc, 'p', 'path text-[10px] text-slate-600 truncate', shortPath(s.url));
    path.setAttribute('title', s.host || '');
    info.appendChild(path);
    row.appendChild(info);

    const btn = el(doc, 'button', 'play-btn shrink-0 px-2.5 py-1.5 rounded text-xs font-medium shadow transition-all '
      + (s.availability === 'unsupported' || s.availability === 'failed'
        ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-brand-600 hover:bg-brand-500 text-white'),
    'Oynat');
    btn.type = 'button';
    if (s.availability === 'unsupported' || s.availability === 'failed') btn.disabled = true;
    btn.addEventListener('click', () => onPlay && onPlay(s));
    row.appendChild(btn);
    return row;
  }

  function renderDiagnostics(container, capture) {
    if (!container) return;
    const doc = container.ownerDocument;
    const diag = (capture && capture.diagnostics) || {};
    const act = (capture && capture.activity) || {};
    const rej = diag.rejections || {};

    const wrap = el(doc, 'div', 'diagnostics-box text-[11px] space-y-2');

    // Durum mesajı
    const statusMsg = el(doc, 'div', 'p-2 rounded bg-slate-950/80 border border-slate-800 flex items-center justify-between');
    statusMsg.appendChild(el(doc, 'span', 'text-slate-300', diag.statusText || 'Yakalama hazır.'));
    const badge = el(doc, 'span', 'px-1.5 py-0.5 rounded text-[10px] '
      + (diag.interacted ? 'bg-emerald-950 text-emerald-400 border border-emerald-800' : 'bg-slate-800 text-slate-400'),
      diag.interacted ? 'Etkileşim Var' : 'Etkileşim Bekleniyor');
    statusMsg.appendChild(badge);
    wrap.appendChild(statusMsg);

    // İstatistikler ızgarası
    const grid = el(doc, 'div', 'grid grid-cols-4 gap-1.5 text-center text-[10px]');
    const addStat = (label, val, color = 'text-slate-200') => {
      const box = el(doc, 'div', 'p-1.5 rounded bg-slate-950 border border-slate-800/80');
      box.appendChild(el(doc, 'div', `font-bold text-xs ${color}`, String(val || 0)));
      box.appendChild(el(doc, 'div', 'text-slate-500 truncate', label));
      grid.appendChild(box);
    };
    addStat('İstek', act.requests);
    addStat('Medya', act.mediaRequests, 'text-emerald-400');
    addStat('Segment', act.segments, 'text-indigo-400');
    addStat('Elenen', (act.ignored || 0), 'text-amber-400');
    wrap.appendChild(grid);

    // İpucu veya ayrıntı (varsa)
    if (rej.ad_host > 0 || rej.noise_resource_type > 0) {
      const note = el(doc, 'p', 'text-[10px] text-slate-500 px-1',
        `Filtrelenen istekler: ${rej.ad_host || 0} reklam, ${rej.noise_resource_type || 0} resim/stil.`);
      wrap.appendChild(note);
    }

    container.replaceChildren(wrap);
  }

  function renderSources(container, sources, { onPlay, activeId, emptyText, capture } = {}) {
    const doc = container.ownerDocument;
    const nodes = sources.map((s) => sourceRow(doc, s, { onPlay, activeId }));
    if (!nodes.length) {
      const emptyBox = el(doc, 'div', 'p-3 rounded-lg border border-slate-800/80 bg-slate-950/40 space-y-2');
      emptyBox.appendChild(el(doc, 'p', 'text-xs text-slate-400 text-center font-medium', emptyText || 'Henüz kaynak bulunamadı.'));
      if (capture) {
        const diagArea = el(doc, 'div', 'mt-2 pt-2 border-t border-slate-800');
        renderDiagnostics(diagArea, capture);
        emptyBox.appendChild(diagArea);
      }
      nodes.push(emptyBox);
    }
    container.replaceChildren(...nodes);
  }

  function renderPopups(container, blocked, { onOpen } = {}) {
    const doc = container.ownerDocument;
    const nodes = blocked.map((b) => {
      const row = el(doc, 'div', 'popup-row flex items-center justify-between gap-2 text-[11px]');
      row.appendChild(el(doc, 'span', 'text-slate-400 truncate flex-1', b.host || '?'));
      const btn = el(doc, 'button', 'text-brand-400 underline', 'Aç');
      btn.type = 'button';
      btn.addEventListener('click', () => onOpen && onOpen(b));
      row.appendChild(btn);
      return row;
    });
    container.replaceChildren(...nodes);
  }

  function formatSec(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(r)}` : `${p(m)}:${p(r)}`;
  }

  function renderHistory(container, items, { onResume, onRestart, onDelete, onOpenPage } = {}) {
    const doc = container.ownerDocument;
    if (!items || items.length === 0) {
      container.replaceChildren();
      return;
    }

    const cards = items.map((item) => {
      const card = el(doc, 'div', 'history-card shrink-0 w-64 bg-slate-950/80 border border-slate-800 hover:border-slate-700 rounded-lg p-2.5 flex flex-col justify-between gap-2 shadow-sm transition-all');
      card.dataset.historyId = String(item.id);

      const top = el(doc, 'div', 'flex items-start justify-between gap-1');
      const titleBox = el(doc, 'div', 'flex-1 min-w-0');
      if (item.episode) {
        const epBadge = el(doc, 'span', 'inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-brand-950 border border-brand-800 text-brand-300 mr-1 mb-0.5', item.episode);
        titleBox.appendChild(epBadge);
      }
      const titleText = el(doc, 'h4', 'text-xs font-semibold text-white truncate', item.title || 'Video');
      titleText.title = item.title || 'Video';
      titleBox.appendChild(titleText);

      const delBtn = el(doc, 'button', 'text-slate-500 hover:text-red-400 p-0.5 rounded transition-colors');
      delBtn.type = 'button';
      delBtn.title = 'Geçmişten sil';
      delBtn.innerHTML = '<svg class="icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onDelete && onDelete(item);
      });
      top.appendChild(titleBox);
      top.appendChild(delBtn);
      card.appendChild(top);

      const mid = el(doc, 'div', 'space-y-1.5 my-0.5');
      const metaRow = el(doc, 'div', 'flex items-center justify-between text-[10px] text-slate-400');
      metaRow.appendChild(el(doc, 'span', 'truncate max-w-[120px]', `${item.provider || 'Web'} · ${String(item.kind || 'HLS').toUpperCase()}`));

      const timeText = item.duration && item.duration > 0
        ? `${formatSec(item.currentTime)} / ${formatSec(item.duration)}`
        : (item.currentTime > 0 ? formatSec(item.currentTime) : 'İzleniyor');

      if (item.completed) {
        const compBadge = el(doc, 'span', 'text-emerald-400 font-medium', 'Tamamlandı');
        metaRow.appendChild(compBadge);
      } else if (item.progressPercent !== null && item.progressPercent !== undefined) {
        metaRow.appendChild(el(doc, 'span', 'font-mono text-slate-300', `%${Math.round(item.progressPercent)}`));
      } else {
        metaRow.appendChild(el(doc, 'span', 'text-slate-500', '—'));
      }
      mid.appendChild(metaRow);

      const progTrack = el(doc, 'div', 'w-full h-1 bg-slate-800 rounded-full overflow-hidden');
      const pct = item.completed ? 100 : (item.progressPercent || 0);
      const progBar = el(doc, 'div', `h-full ${item.completed ? 'bg-emerald-500' : 'bg-brand-500'} transition-all`);
      progBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
      progTrack.appendChild(progBar);
      mid.appendChild(progTrack);

      const timeSub = el(doc, 'div', 'text-[10px] text-slate-500 font-mono text-right', timeText);
      mid.appendChild(timeSub);
      card.appendChild(mid);

      const actions = el(doc, 'div', 'flex items-center gap-1.5 pt-1 border-t border-slate-900');
      const btnResume = el(doc, 'button', 'flex-1 bg-brand-600 hover:bg-brand-500 text-white font-semibold py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors');
      btnResume.type = 'button';
      btnResume.textContent = item.currentTime > 5 && !item.completed ? 'Devam Et' : 'Oynat';
      btnResume.addEventListener('click', () => onResume && onResume(item));
      actions.appendChild(btnResume);

      if (item.currentTime > 5 || item.completed) {
        const btnRestart = el(doc, 'button', 'bg-slate-800 hover:bg-slate-700 text-slate-200 py-1 px-1.5 rounded text-[11px] transition-colors', 'Baştan');
        btnRestart.type = 'button';
        btnRestart.title = 'Baştan başlat';
        btnRestart.addEventListener('click', () => onRestart && onRestart(item));
        actions.appendChild(btnRestart);
      }

      if (item.pageUrl) {
        const btnPage = el(doc, 'button', 'bg-slate-800 hover:bg-slate-700 text-slate-300 py-1 px-1.5 rounded text-[11px] transition-colors', 'Sayfa');
        btnPage.type = 'button';
        btnPage.title = 'Orijinal web sayfasını aç';
        btnPage.addEventListener('click', () => onOpenPage && onOpenPage(item));
        actions.appendChild(btnPage);
      }

      card.appendChild(actions);
      return card;
    });

    container.replaceChildren(...cards);
  }

  function renderBookmarks(container, items, { onOpen, onDelete }) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!items || items.length === 0) {
      container.replaceChildren();
      return;
    }

    const cards = items.map((item) => {
      const card = el(doc, 'div', 'bookmark-card p-3 rounded-lg border bg-slate-950/80 border-slate-800 space-y-2 hover:border-slate-700 transition-colors');
      const top = el(doc, 'div', 'flex items-start justify-between gap-1');
      const titleBox = el(doc, 'div', 'flex-1 min-w-0');
      const titleText = el(doc, 'h4', 'text-xs font-semibold text-white truncate', item.title || 'Video');
      titleText.title = item.title || 'Video';
      titleBox.appendChild(titleText);

      const delBtn = el(doc, 'button', 'text-slate-500 hover:text-red-400 p-0.5 rounded transition-colors');
      delBtn.type = 'button';
      delBtn.title = 'Favorilerden kaldır';
      delBtn.innerHTML = '<svg class="icon-xs" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onDelete && onDelete(item);
      });
      top.appendChild(titleBox);
      top.appendChild(delBtn);
      card.appendChild(top);

      const metaRow = el(doc, 'div', 'flex items-center justify-between text-[10px] text-slate-400');
      metaRow.appendChild(el(doc, 'span', 'truncate text-brand-300 font-medium', item.host || 'Web'));
      const d = item.createdAt ? new Date(item.createdAt).toLocaleDateString('tr-TR') : '';
      metaRow.appendChild(el(doc, 'span', 'text-slate-500 font-mono', d));
      card.appendChild(metaRow);

      const actions = el(doc, 'div', 'flex items-center gap-1.5 pt-1 border-t border-slate-900');
      const btnOpen = el(doc, 'button', 'flex-1 bg-brand-600 hover:bg-brand-500 text-white font-semibold py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors');
      btnOpen.type = 'button';
      btnOpen.textContent = 'Sayfayı Aç';
      btnOpen.addEventListener('click', () => onOpen && onOpen(item));
      actions.appendChild(btnOpen);

      card.appendChild(actions);
      return card;
    });

    container.replaceChildren(...cards);
  }

  function renderDownloads(container, items, { onPlay, onCancel, onDelete }) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!items || items.length === 0) {
      container.replaceChildren();
      return;
    }

    const cards = items.map((item) => {
      const card = el(doc, 'div', 'download-card p-3 rounded-lg border bg-slate-950/80 border-slate-800 space-y-2 hover:border-slate-700 transition-colors');
      const top = el(doc, 'div', 'flex items-start justify-between gap-1');
      const titleBox = el(doc, 'div', 'flex-1 min-w-0');
      const titleText = el(doc, 'h4', 'text-xs font-semibold text-white truncate', item.title || item.filename || 'Video');
      titleText.title = item.title || item.filename || 'Video';
      titleBox.appendChild(titleText);

      const delBtn = el(doc, 'button', 'text-slate-500 hover:text-red-400 p-0.5 rounded text-xs transition-colors', 'Sil');
      delBtn.type = 'button';
      delBtn.title = 'İndirilen dosyayı ve kaydı sil';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onDelete && onDelete(item);
      });
      top.appendChild(titleBox);
      top.appendChild(delBtn);
      card.appendChild(top);

      const metaRow = el(doc, 'div', 'flex items-center justify-between text-[10px] text-slate-400');
      let statusLabel = 'İndiriliyor…';
      let statusClass = 'text-amber-400';
      if (item.status === 'completed') {
        statusLabel = 'Tamamlandı';
        statusClass = 'text-emerald-400';
      } else if (item.status === 'error') {
        statusLabel = item.error || 'Hata oluştu';
        statusClass = 'text-red-400';
      } else if (item.status === 'cancelled') {
        statusLabel = 'İptal Edildi';
        statusClass = 'text-slate-500';
      }

      metaRow.appendChild(el(doc, 'span', `font-medium ${statusClass}`, statusLabel));

      let sizeText = '';
      if (item.totalBytes && item.totalBytes > 0) {
        sizeText = `${(item.totalBytes / (1024 * 1024)).toFixed(1)} MB`;
      } else if (item.downloadedBytes && item.downloadedBytes > 0) {
        sizeText = `${(item.downloadedBytes / (1024 * 1024)).toFixed(1)} MB`;
      }
      metaRow.appendChild(el(doc, 'span', 'text-slate-500 font-mono', sizeText));
      card.appendChild(metaRow);

      if (item.status === 'downloading') {
        const progTrack = el(doc, 'div', 'w-full h-1.5 bg-slate-800 rounded-full overflow-hidden');
        const progBar = el(doc, 'div', 'h-full bg-brand-500 transition-all');
        progBar.style.width = `${Math.min(100, Math.max(0, item.progress || 0))}%`;
        progTrack.appendChild(progBar);
        card.appendChild(progTrack);
      }

      const actions = el(doc, 'div', 'flex items-center gap-1.5 pt-1 border-t border-slate-900');
      if (item.status === 'completed') {
        const btnPlay = el(doc, 'button', 'flex-1 bg-brand-600 hover:bg-brand-500 text-white font-semibold py-1 px-2 rounded text-[11px] flex items-center justify-center gap-1 transition-colors');
        btnPlay.type = 'button';
        btnPlay.textContent = 'Çevrimdışı Oynat';
        btnPlay.addEventListener('click', () => onPlay && onPlay(item));
        actions.appendChild(btnPlay);
      } else if (item.status === 'downloading') {
        const btnCancel = el(doc, 'button', 'flex-1 bg-slate-800 hover:bg-red-900/60 text-slate-200 hover:text-red-200 font-semibold py-1 px-2 rounded text-[11px] transition-colors');
        btnCancel.type = 'button';
        btnCancel.textContent = 'İptal Et';
        btnCancel.addEventListener('click', () => onCancel && onCancel(item));
        actions.appendChild(btnCancel);
      }

      card.appendChild(actions);
      return card;
    });

    container.replaceChildren(...cards);
  }

  function renderFormatChips(container, formats, activeFormat, onSelect) {
    if (!container) return;
    const doc = container.ownerDocument;
    const nodes = (formats || []).map((f) => {
      const active = f.id === activeFormat;
      const chip = el(doc, 'button', 'px-2.5 py-0.5 rounded-md text-[11px] font-medium transition-colors shrink-0 '
        + (active
          ? 'bg-brand-600 text-white shadow-sm'
          : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700/60'));
      chip.type = 'button';
      chip.textContent = f.label;
      chip.addEventListener('click', () => onSelect && onSelect(f.id));
      return chip;
    });
    container.replaceChildren(...nodes);
  }

  function renderGenreChips(container, genres, activeGenre, onSelect) {
    if (!container) return;
    const doc = container.ownerDocument;
    const nodes = (genres || []).map((g) => {
      const active = g.id === activeGenre;
      const chip = el(doc, 'button', 'px-2.5 py-1 rounded-full whitespace-nowrap transition-colors font-medium text-[11px] '
        + (active
          ? 'bg-brand-600 text-white shadow-sm'
          : 'bg-slate-800/80 hover:bg-slate-700 text-slate-300 border border-slate-700/60'));
      chip.type = 'button';
      chip.textContent = g.label;
      chip.addEventListener('click', () => onSelect && onSelect(g.id));
      return chip;
    });
    container.replaceChildren(...nodes);
  }

  function renderAnimeCards(container, list, onSelect) {
    if (!container) return;
    const doc = container.ownerDocument;
    if (!list || list.length === 0) {
      container.replaceChildren();
      return;
    }

    const cards = list.map((item) => {
      const card = el(doc, 'div', 'group relative bg-slate-900 border border-slate-800 hover:border-brand-500 rounded-xl overflow-hidden cursor-pointer shadow-md hover:shadow-brand-500/10 transition-all duration-200 flex flex-col');
      card.dataset.animeId = String(item.id);

      // Afiş alanı
      const imgWrap = el(doc, 'div', 'relative aspect-[3/4] w-full overflow-hidden bg-slate-800');
      if (item.cover) {
        const img = doc.createElement('img');
        img.className = 'w-full h-full object-cover group-hover:scale-105 transition-transform duration-300';
        img.src = item.cover;
        img.alt = item.title;
        img.loading = 'lazy';
        imgWrap.appendChild(img);
      } else {
        const placeholder = el(doc, 'div', 'w-full h-full flex items-center justify-center text-slate-600 text-xs', 'Afiş Yok');
        imgWrap.appendChild(placeholder);
      }

      // Puan Rozeti
      if (item.score) {
        const scoreBadge = el(doc, 'div', 'absolute top-1.5 left-1.5 bg-black/75 backdrop-blur border border-amber-500/40 text-amber-300 font-bold text-[10px] px-1.5 py-0.5 rounded-md flex items-center gap-0.5');
        scoreBadge.innerHTML = '<svg class="w-2.5 h-2.5 text-amber-400 fill-current" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>';
        scoreBadge.appendChild(el(doc, 'span', null, item.score));
        imgWrap.appendChild(scoreBadge);
      }

      // Bölüm Sayısı Rozeti
      if (item.episodes) {
        const epBadge = el(doc, 'div', 'absolute bottom-1.5 right-1.5 bg-black/75 backdrop-blur text-slate-200 font-medium text-[10px] px-1.5 py-0.5 rounded border border-slate-700/60', `${item.episodes} Bölüm`);
        imgWrap.appendChild(epBadge);
      }

      // Hover Oynat İkonu Katmanı
      const hoverOverlay = el(doc, 'div', 'absolute inset-0 bg-brand-600/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center');
      hoverOverlay.innerHTML = '<div class="w-10 h-10 rounded-full bg-brand-600 text-white flex items-center justify-center shadow-lg shadow-brand-500/30 transform scale-90 group-hover:scale-100 transition-transform"><svg class="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div>';
      imgWrap.appendChild(hoverOverlay);

      card.appendChild(imgWrap);

      // Başlık & Detay
      const info = el(doc, 'div', 'p-2 flex flex-col justify-between flex-1');
      const titleEl = el(doc, 'h4', 'text-xs font-bold text-white line-clamp-1 group-hover:text-brand-400 transition-colors', item.title);
      titleEl.title = item.title;
      info.appendChild(titleEl);

      const subMeta = el(doc, 'div', 'flex items-center justify-between text-[10px] text-slate-400 mt-1');
      subMeta.appendChild(el(doc, 'span', null, item.year ? String(item.year) : 'Anime'));
      const statusText = item.status === 'FINISHED' ? 'Bitti' : (item.status === 'RELEASING' ? 'Devam Ediyor' : '');
      if (statusText) {
        subMeta.appendChild(el(doc, 'span', item.status === 'RELEASING' ? 'text-brand-300' : 'text-slate-500', statusText));
      }
      info.appendChild(subMeta);

      card.appendChild(info);

      card.addEventListener('click', () => onSelect && onSelect(item));
      return card;
    });

    container.replaceChildren(...cards);
  }

  function renderEpisodeTabs(container, totalEpisodes, activeRange, onSelectRange) {
    if (!container) return;
    const doc = container.ownerDocument;
    const total = Math.max(1, Math.min(1000, Number(totalEpisodes) || 12));
    if (total <= 30) {
      container.replaceChildren();
      return;
    }

    const pageSize = 50;
    const ranges = [];
    for (let s = 1; s <= total; s += pageSize) {
      const e = Math.min(total, s + pageSize - 1);
      ranges.push({ id: `${s}-${e}`, start: s, end: e, label: `${s}-${e}` });
    }
    if (ranges.length > 1) {
      ranges.push({ id: 'all', start: 1, end: total, label: 'Tümü' });
    }

    const currentId = (activeRange && activeRange.id) || ranges[0].id;

    const nodes = ranges.map((r) => {
      const isActive = r.id === currentId;
      const tab = el(doc, 'button', 'px-2 py-0.5 rounded text-[11px] font-medium transition-colors shrink-0 '
        + (isActive
          ? 'bg-brand-600 text-white shadow-sm'
          : 'bg-slate-800 hover:bg-slate-700 text-slate-300'));
      tab.type = 'button';
      tab.textContent = r.label;
      tab.addEventListener('click', () => onSelectRange && onSelectRange(r));
      return tab;
    });

    container.replaceChildren(...nodes);
  }

  function renderEpisodeButtons(container, totalEpisodes, watchedEpisodesSet, onSelectEpisode, options = {}) {
    if (!container) return;
    const doc = container.ownerDocument;
    const total = Math.max(1, Math.min(1000, Number(totalEpisodes) || 12));
    const start = Math.max(1, Math.min(total, (options && options.start) || 1));
    const end = Math.max(start, Math.min(total, (options && options.end) || total));
    const nodes = [];

    for (let ep = start; ep <= end; ep++) {
      const isWatched = watchedEpisodesSet && watchedEpisodesSet.has(ep);
      const btn = el(doc, 'button', 'py-2 px-1 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all border '
        + (isWatched
          ? 'bg-slate-900/90 border-emerald-800 text-emerald-300 hover:bg-slate-800'
          : 'bg-slate-800/90 border-slate-700/80 text-white hover:bg-brand-600 hover:border-brand-500 hover:shadow-md'));
      btn.type = 'button';
      btn.dataset.ep = String(ep);
      btn.textContent = `${ep}. Bölüm`;
      if (isWatched) {
        btn.title = `${ep}. Bölüm (Daha önce izlendi)`;
        const checkIcon = el(doc, 'span', 'text-emerald-400 text-[10px]', '✓');
        btn.appendChild(checkIcon);
      } else {
        btn.title = `${ep}. Bölümü Başlat`;
      }
      btn.addEventListener('click', () => onSelectEpisode && onSelectEpisode(ep));
      nodes.push(btn);
    }

    container.replaceChildren(...nodes);
  }

  return {
    renderSources, renderPopups, renderDiagnostics, renderHistory, renderBookmarks,
    renderDownloads, renderFormatChips, renderGenreChips, renderAnimeCards, renderEpisodeTabs, renderEpisodeButtons,
    sourceRow, formatResolution, formatStatus, formatSec,
  };
});
