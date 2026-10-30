'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { startBackend } = require('./backend.js');
const { createBrowser, isHttpUrl } = require('./browser-view.js');
const { SourceRegistry } = require('./lib/registry.js');
const { WatchHistoryStore, extractMediaMetadata } = require('./lib/history.js');
const { SettingsStore, validateBounds } = require('./lib/settings.js');
const { BookmarkStore } = require('./lib/bookmarks.js');
const { DownloadManager } = require('./lib/downloads.js');
const { IntroDetector } = require('./lib/intro-detector.js');
const { preparePlayback, prepareFromHistory, prepareDirect } = require('./source-session.js');

let backend = null;
let win = null;
let browser = null;
let registry = null;
let historyStore = null;
let settingsStore = null;
let bookmarkStore = null;
let downloadManager = null;
let introDetector = null;
let detachedWin = null;
let pipWin = null;
let currentDetachedState = null;

const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

function clampBounds(b) {
  const n = (v) => Math.max(0, Math.min(20000, Math.round(Number(v) || 0)));
  return { x: n(b && b.x), y: n(b && b.y), width: n(b && b.width), height: n(b && b.height) };
}

async function createWindow() {
  registry = new SourceRegistry({ onChange: (snap) => send('capture:update', snap) });
  historyStore = new WatchHistoryStore({
    storagePath: path.join(app.getPath('userData'), 'watch_history.json'),
    onChange: (items) => send('history:update', items),
  });
  settingsStore = new SettingsStore({
    storagePath: path.join(app.getPath('userData'), 'settings.json'),
    onChange: (s) => send('settings:update', s),
  });
  bookmarkStore = new BookmarkStore({
    storagePath: path.join(app.getPath('userData'), 'bookmarks.json'),
    onChange: (items) => send('bookmarks:update', items),
  });
  downloadManager = new DownloadManager({
    downloadDir: path.join(app.getPath('userData'), 'downloads'),
    metadataPath: path.join(app.getPath('userData'), 'downloads.json'),
    onProgress: (p) => send('downloads:progress', p),
    onListChange: (items) => send('downloads:update', items),
  });
  introDetector = new IntroDetector({
    cacheDir: app.getPath('userData'),
  });

  browser = createBrowser({
    registry,
    backendPort: backend.port,
    onState: (s) => {
      send('nav:update', s);
      // Geçerli bir web sayfasına gidildiyse son adresi kaydet
      if (s && s.url && isHttpUrl(s.url) && !s.url.startsWith(backend.origin + '/')) {
        if (settingsStore && settingsStore.get('restoreLastPage') !== false) {
          settingsStore.update({ lastPageUrl: s.url }, false, false);
        }
      }
    },
    onPopups: (p) => send('popups:update', p),
  });

  const { screen } = require('electron');
  const remember = settingsStore.get('rememberWindowBounds');
  const savedBounds = settingsStore.get('windowBounds');
  const validBounds = remember
    ? validateBounds(savedBounds, screen ? screen.getAllDisplays() : null)
    : validateBounds(null);

  const winOpts = {
    width: validBounds.width,
    height: validBounds.height,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#020617',
    title: 'MK VideoPlayer',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  };

  if (remember && validBounds.x !== null && validBounds.y !== null) {
    winOpts.x = validBounds.x;
    winOpts.y = validBounds.y;
  }

  let isReady = false;
  let isClosing = false;
  let isMaximizedState = !!(remember && validBounds.isMaximized);

  win = new BrowserWindow(winOpts);
  if (remember && validBounds.isMaximized) {
    try { win.maximize(); } catch (_) {}
  }

  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed()) return;
    if (remember && validBounds.isMaximized) {
      try { win.maximize(); } catch (_) {}
      isMaximizedState = true;
    }
    win.show();
    setTimeout(() => {
      isReady = true;
      if (win && !win.isDestroyed()) {
        isMaximizedState = win.isMaximized();
      }
    }, 400);
  });

  let boundsTimer = null;
  const saveWindowBounds = (immediate = false) => {
    if (!win || win.isDestroyed() || !settingsStore) return;
    if (!settingsStore.get('rememberWindowBounds')) return;
    if (win.isMinimized()) return; // Minimize durumunda bozuk bounds kaydetme

    const doSave = () => {
      if (!win || win.isDestroyed()) return;
      const maximized = win.isMaximized() || isMaximizedState;
      if (maximized) {
        const prev = settingsStore.get('windowBounds') || {};
        settingsStore.update({
          windowBounds: {
            ...prev,
            isMaximized: true,
          },
        }, true, false); // notifyRenderer = false (renderer'ı meşgul etme)
        return;
      }
      let b = null;
      try {
        b = (typeof win.getNormalBounds === 'function') ? win.getNormalBounds() : win.getBounds();
      } catch (_) {
        try { b = win.getBounds(); } catch (__) {}
      }
      if (!b || !Number.isFinite(b.width) || b.width < 500 || b.height < 400) return;

      settingsStore.update({
        windowBounds: {
          x: Math.round(b.x),
          y: Math.round(b.y),
          width: Math.round(b.width),
          height: Math.round(b.height),
          isMaximized: false,
        },
      }, true, false); // notifyRenderer = false
    };

    if (immediate) {
      clearTimeout(boundsTimer);
      doSave();
    } else {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(doSave, 350);
    }
  };

  win.on('resize', () => {
    if (!isReady || isClosing || !win || win.isDestroyed()) return;
    if (win.isMaximized()) {
      isMaximizedState = true;
      saveWindowBounds(true);
    } else if (!win.isMinimized()) {
      isMaximizedState = false;
      saveWindowBounds(false);
    }
  });
  win.on('move', () => {
    if (!isReady || isClosing || !win || win.isDestroyed()) return;
    if (!win.isMinimized() && !win.isMaximized()) {
      isMaximizedState = false;
      saveWindowBounds(false);
    }
  });
  win.on('maximize', () => {
    isMaximizedState = true;
    saveWindowBounds(true);
  });
  win.on('unmaximize', () => {
    if (!isReady || isClosing || !win || win.isDestroyed()) return;
    isMaximizedState = false;
    saveWindowBounds(false);
  });

  win.contentView.addChildView(browser.view);
  browser.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });

  // Kabuk yalnızca kendi arka ucumuzda kalabilir.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(backend.origin + '/')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('close', () => {
    isClosing = true;
    clearTimeout(boundsTimer);
    const isMax = isMaximizedState || (win && !win.isDestroyed() && win.isMaximized());
    if (isMax) {
      const prev = settingsStore.get('windowBounds') || {};
      settingsStore.update({
        windowBounds: {
          ...prev,
          isMaximized: true,
        },
      }, true, false);
    } else {
      saveWindowBounds(true);
    }
    if (historyStore) historyStore.flush();
    if (settingsStore) settingsStore.flush();
  });
  win.on('closed', () => { win = null; });

  win.webContents.once('did-finish-load', () => {
    // Son açık olan web sayfasını geri yükle (eğer ayar açıksa)
    if (settingsStore && settingsStore.get('restoreLastPage') !== false) {
      let lastUrl = settingsStore.get('lastPageUrl');
      if (!lastUrl && historyStore) {
        const items = historyStore.list();
        if (items && items.length > 0 && items[0].pageUrl) {
          lastUrl = items[0].pageUrl;
        }
      }
      if (lastUrl && isHttpUrl(lastUrl) && !lastUrl.startsWith(backend.origin + '/')) {
        browser.go(lastUrl);
      }
    }
  });

  try {
    await win.loadURL(backend.origin + '/');
  } catch (err) {
    if (!win || win.isDestroyed()) return;
    console.error('Ana sayfa yükleme hatası:', err);
  }
}

const fromShell = (e) => {
  const isMain = win && !win.isDestroyed() && e.sender === win.webContents;
  const isDetached = detachedWin && !detachedWin.isDestroyed() && e.sender === detachedWin.webContents;
  const isPip = pipWin && !pipWin.isDestroyed() && e.sender === pipWin.webContents;
  return (isMain || isDetached || isPip) && e.senderFrame && e.senderFrame.url.startsWith(backend.origin + '/');
};

function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromShell(e)) return { ok: false, code: 'forbidden' };
    return fn(...args);
  });
}

function registerIpc() {
  handle('app:state', () => ({
    nav: browser.snapshot(), popups: browser.popupSnapshot(), capture: registry.snapshot(),
    session: browser.getSessionInfo(),
  }));
  handle('browser:go', (input) => {
    const c = browser.navigate(input);
    return { ok: c.type === 'page' || c.type === 'media', type: c.type, kind: c.kind || null, url: c.url || null, supported: c.supported !== false };
  });
  handle('browser:back', () => browser.back());
  handle('browser:forward', () => browser.forward());
  handle('browser:reload', () => browser.reload());
  handle('browser:stop', () => browser.stop());
  handle('browser:bounds', (b) => { browser.view.setBounds(clampBounds(b)); });
  handle('browser:visible', (v) => {
    browser.view.setVisible(!!v);
    if (!v) browser.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  });
  handle('capture:set', (on) => {
    if (on) {
      registry.start();
      if (browser && typeof browser.probeActiveMedia === 'function') {
        browser.probeActiveMedia().catch(() => {});
      }
    } else {
      registry.stop();
    }
    return registry.snapshot();
  });
  handle('popups:mode', (mode) => { browser.setPopupMode(mode); });
  handle('popups:open', (id) => ({ ok: browser.openBlockedPopup(id) }));
  handle('source:play', async (id) => {
    const pageTitle = browser.wc.getTitle();
    const res = await preparePlayback({
      backend, registry, ses: browser.ses, id, pageTitle,
    });
    if (res.ok && historyStore) {
      const meta = extractMediaMetadata({
        pageTitle,
        pageUrl: res.pageUrl || browser.wc.getURL(),
        sourceHost: res.host,
        kind: res.kind,
      });
      const item = historyStore.upsert({
        pageUrl: res.pageUrl || browser.wc.getURL(),
        mediaUrl: res.rawUrl,
        title: meta.title,
        episode: meta.episode,
        provider: meta.provider,
        sourceLabel: meta.sourceLabel,
        kind: res.kind,
        headers: res.headers,
      });
      res.historyId = item.id;
    }
    const safeRes = { ...res };
    delete safeRes.rawUrl;
    return safeRes;
  });
  handle('source:playDirect', async (url) => {
    const res = await prepareDirect({ backend, url });
    if (res.ok && historyStore) {
      const item = historyStore.upsert({
        pageUrl: url,
        mediaUrl: res.rawUrl,
        title: res.title || 'Doğrudan Akış',
        provider: res.host,
        kind: res.kind,
      });
      res.historyId = item.id;
    }
    const safeRes = { ...res };
    delete safeRes.rawUrl;
    return safeRes;
  });
  handle('source:report', ({ id, ok, code }) => {
    if (id) registry.setPlayback(id, ok ? 'playable' : 'failed', ok ? null : code);
    return { ok: true };
  });
  handle('source:release', (sid) => { if (typeof sid === 'string' && sid.length < 100) backend.del(`/api/sessions/${encodeURIComponent(sid)}`); });

  // İzleme geçmişi IPC kanalları
  handle('history:list', (filter) => historyStore ? historyStore.list(filter) : []);
  handle('history:startWatch', (data) => {
    if (!historyStore) return { ok: false };
    const item = historyStore.upsert(data || {});
    return { ok: true, item: historyStore._sanitizeForRenderer(item) };
  });
  handle('history:progress', (data) => {
    if (!historyStore || !data || !data.id) return { ok: false };
    const item = historyStore.updateProgress(data);
    return { ok: !!item, item: item ? historyStore._sanitizeForRenderer(item) : null };
  });
  handle('history:delete', (id) => ({ ok: historyStore ? historyStore.delete(String(id)) : false }));
  handle('history:clear', () => ({ ok: historyStore ? historyStore.clear() : false }));
  handle('history:encryptionStatus', () => (historyStore ? historyStore.getEncryptionStatus() : { available: false, mode: 'none' }));
  handle('history:play', ({ id, restart }) => prepareFromHistory({
    backend, historyStore, ses: browser.ses, id: String(id), restart: !!restart,
  }));

  // Ayarlar IPC kanalları
  handle('settings:get', () => (settingsStore ? settingsStore.getAll() : {}));
  handle('settings:update', (data) => (settingsStore ? settingsStore.update(data) : {}));
  handle('settings:reset', () => (settingsStore ? settingsStore.reset() : {}));

  // Favoriler (Bookmarks) IPC kanalları
  handle('bookmarks:list', (query) => (bookmarkStore ? bookmarkStore.list(query) : []));
  handle('bookmarks:add', (data) => (bookmarkStore ? bookmarkStore.add(data || {}) : null));
  handle('bookmarks:remove', (id) => (bookmarkStore ? bookmarkStore.remove(id) : false));
  handle('bookmarks:toggle', (data) => (bookmarkStore ? bookmarkStore.toggle(data || {}) : { added: false }));
  handle('bookmarks:has', (url) => (bookmarkStore ? bookmarkStore.has(url) : false));

  // Video İndirme ve Çevrimdışı İzleme IPC kanalları
  handle('downloads:list', () => (downloadManager ? downloadManager.list() : []));
  handle('downloads:start', (data) => (downloadManager ? downloadManager.startDownload(data || {}) : null));
  handle('downloads:cancel', (id) => (downloadManager ? downloadManager.cancel(id) : false));
  handle('downloads:delete', (id) => (downloadManager ? downloadManager.delete(id) : false));
  handle('downloads:playOffline', (id) => {
    if (!downloadManager || !backend) return { ok: false, error: 'not_ready' };
    const item = downloadManager.get(id);
    if (!item || !item.filePath) return { ok: false, error: 'not_found' };
    const localUrl = `${backend.origin}/api/local-media?path=${encodeURIComponent(item.filePath)}`;
    return {
      ok: true,
      proxyUrl: localUrl,
      rawUrl: localUrl,
      title: item.title,
      host: 'Yerel Depo (Çevrimdışı)',
      kind: 'mp4',
      sid: null,
      sourceId: null,
      historyId: null,
      startTime: 0,
    };
  });

  // Bölüm Gezinme (Sonraki / Önceki Bölüm) IPC kanalları
  handle('browser:getEpisodes', (fallbackUrl) => (browser ? browser.getEpisodeNav(fallbackUrl) : { prev: null, next: null }));
  handle('browser:nextEpisode', (fallbackUrl) => (browser ? browser.goNextEpisode(fallbackUrl) : { ok: false }));
  handle('browser:prevEpisode', (fallbackUrl) => (browser ? browser.goPrevEpisode(fallbackUrl) : { ok: false }));

  // Akıllı İntro / Outro Algılama IPC kanalları (AniSkip + Yerel Parmak İzi)
  handle('intro:detect', async (meta) => {
    if (!introDetector) return { found: false, source: 'heuristic', intro: { start: 0, end: 85 } };
    const s = settingsStore ? settingsStore.getAll() : {};
    return introDetector.detectIntro(meta, s);
  });
  handle('intro:saveFingerprint', (data) => {
    if (!introDetector || !data) return false;
    return introDetector.saveSeriesFingerprint(data.seriesKey, data.episode, data.samples, data.sampleRate);
  });
  handle('intro:clearCache', () => {
    if (!introDetector) return false;
    introDetector.clearCache();
    return true;
  });

  // Oturum yönetimi IPC kanalları
  handle('session:info', () => (browser ? browser.getSessionInfo() : { persistent: false }));
  handle('session:clearSite', (target) => (browser ? browser.clearSiteData(target) : { ok: false }));
  handle('session:clearAll', () => (browser ? browser.clearAllData() : { ok: false }));

  // Görüntüleme modları (In Window & PiP) IPC kanalları
  handle('display:openInWindow', (state) => openDetachedWindow(state, false));
  handle('display:pipFallback', (state) => openDetachedWindow(state, true));
  handle('display:reportDetachedState', (state) => {
    if (state) {
      currentDetachedState = { ...(currentDetachedState || {}), ...state };
    }
    return { ok: true };
  });
  handle('display:closeInWindow', (state) => {
    if (state) {
      currentDetachedState = { ...(currentDetachedState || {}), ...state };
    }
    if (detachedWin && !detachedWin.isDestroyed()) {
      detachedWin.close();
      detachedWin = null;
    }
    if (pipWin && !pipWin.isDestroyed()) {
      pipWin.close();
      pipWin = null;
    }
    if (win && !win.isDestroyed() && currentDetachedState) {
      win.webContents.send('display:returnToWindowed', currentDetachedState);
      currentDetachedState = null;
    }
    return { ok: true };
  });
}

function openDetachedWindow(state, isPip = false) {
  if (state) currentDetachedState = { ...state };
  if (detachedWin && !detachedWin.isDestroyed()) {
    detachedWin.focus();
    detachedWin.webContents.send('detached:init', state);
    return { ok: true };
  }
  if (pipWin && !pipWin.isDestroyed()) {
    pipWin.focus();
    pipWin.webContents.send('detached:init', state);
    return { ok: true };
  }

  const w = new BrowserWindow({
    width: isPip ? 480 : 854,
    height: isPip ? 270 : 520,
    minWidth: 320,
    minHeight: 180,
    backgroundColor: '#020617',
    title: (state && state.title ? `${state.title} - ` : '') + (isPip ? 'MK VideoPlayer (PiP)' : 'MK VideoPlayer (In Window)'),
    autoHideMenuBar: true,
    alwaysOnTop: !!isPip,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (isPip) pipWin = w;
  else detachedWin = w;

  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(backend.origin + '/')) e.preventDefault();
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  w.webContents.on('did-finish-load', () => {
    w.webContents.send('detached:init', state);
  });

  w.on('closed', () => {
    if (isPip) pipWin = null;
    else detachedWin = null;
    if (win && !win.isDestroyed() && currentDetachedState) {
      win.webContents.send('display:returnToWindowed', currentDetachedState);
      currentDetachedState = null;
    }
  });

  w.loadURL(backend.origin + '/detached.html');
  return { ok: true };
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      backend = await startBackend();
    } catch (e) {
      dialog.showErrorBox('MK VideoPlayer', `Arka uç başlatılamadı:\n${e.message}\n\nPython ve bağımlılıkların kurulu olduğundan emin olun (README).`);
      app.exit(1);
      return;
    }
    registerIpc();
    try {
      await createWindow();
    } catch (err) {
      console.error('Pencere oluşturma hatası:', err);
    }
  });
}

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  // Anime siteleri ve video sunucularındaki CDN sertifika uyumsuzluklarında akışın kopmasını engelle
  event.preventDefault();
  callback(true);
});

app.on('web-contents-created', (_e, contents) => {
  // Hiçbir webContents'in <webview> bağlamasına veya izinsiz gezintiye izni yok.
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (historyStore) historyStore.flush();
  if (settingsStore) settingsStore.flush();
  if (detachedWin && !detachedWin.isDestroyed()) detachedWin.destroy();
  if (pipWin && !pipWin.isDestroyed()) pipWin.destroy();
});
app.on('will-quit', () => {
  if (backend) backend.stop();
  if (historyStore) historyStore.destroy();
  if (settingsStore) settingsStore.destroy();
});

module.exports = { isHttpUrl };
