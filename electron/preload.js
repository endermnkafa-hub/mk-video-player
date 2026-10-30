'use strict';
// Kabuk (shell) arayüzü için dar, açık bir köprü. Web içeriği (gömülü sayfa) bu preload'u almaz.
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('mk', {
  isDesktop: true,
  getState: () => ipcRenderer.invoke('app:state'),
  go: (input) => ipcRenderer.invoke('browser:go', String(input)),
  back: () => ipcRenderer.invoke('browser:back'),
  forward: () => ipcRenderer.invoke('browser:forward'),
  reload: () => ipcRenderer.invoke('browser:reload'),
  stop: () => ipcRenderer.invoke('browser:stop'),
  setBounds: (b) => ipcRenderer.invoke('browser:bounds', b),
  setBrowserVisible: (v) => ipcRenderer.invoke('browser:visible', !!v),
  setCapture: (on_) => ipcRenderer.invoke('capture:set', !!on_),
  setPopupMode: (mode) => ipcRenderer.invoke('popups:mode', String(mode)),
  openBlockedPopup: (id) => ipcRenderer.invoke('popups:open', Number(id)),
  playSource: (id) => ipcRenderer.invoke('source:play', String(id)),
  playDirect: (url) => ipcRenderer.invoke('source:playDirect', String(url)),
  reportPlayback: (id, ok, code) => ipcRenderer.invoke('source:report', { id: String(id), ok: !!ok, code: String(code || '') }),
  releaseSession: (sid) => ipcRenderer.invoke('source:release', String(sid)),
  // İzleme geçmişi API'leri
  getHistory: (filter) => ipcRenderer.invoke('history:list', filter),
  getHistoryEncryptionStatus: () => ipcRenderer.invoke('history:encryptionStatus'),
  startWatch: (data) => ipcRenderer.invoke('history:startWatch', data),
  saveProgress: (data) => ipcRenderer.invoke('history:progress', data),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  playHistory: ({ id, restart }) => ipcRenderer.invoke('history:play', { id: String(id), restart: !!restart }),
  // Ayarlar API'leri
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (data) => ipcRenderer.invoke('settings:update', data),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  // Favoriler (Bookmarks) API'leri
  getBookmarks: (query) => ipcRenderer.invoke('bookmarks:list', query),
  addBookmark: (data) => ipcRenderer.invoke('bookmarks:add', data),
  removeBookmark: (id) => ipcRenderer.invoke('bookmarks:remove', id),
  toggleBookmark: (data) => ipcRenderer.invoke('bookmarks:toggle', data),
  hasBookmark: (url) => ipcRenderer.invoke('bookmarks:has', url),
  // Video İndirme ve Çevrimdışı İzleme API'leri
  getDownloads: () => ipcRenderer.invoke('downloads:list'),
  startDownload: (data) => ipcRenderer.invoke('downloads:start', data),
  cancelDownload: (id) => ipcRenderer.invoke('downloads:cancel', id),
  deleteDownload: (id) => ipcRenderer.invoke('downloads:delete', id),
  playOfflineDownload: (id) => ipcRenderer.invoke('downloads:playOffline', id),
  // Bölüm Gezinme API'leri
  getEpisodeNav: (fallbackUrl) => ipcRenderer.invoke('browser:getEpisodes', fallbackUrl),
  nextEpisode: (fallbackUrl) => ipcRenderer.invoke('browser:nextEpisode', fallbackUrl),
  prevEpisode: (fallbackUrl) => ipcRenderer.invoke('browser:prevEpisode', fallbackUrl),
  // Akıllı İntro ve Outro Algılama API'leri (AniSkip + Yerel Parmak İzi)
  detectIntro: (meta) => ipcRenderer.invoke('intro:detect', meta),
  saveFingerprint: (data) => ipcRenderer.invoke('intro:saveFingerprint', data),
  clearIntroCache: () => ipcRenderer.invoke('intro:clearCache'),
  // Oturum yönetimi API'leri
  getSessionInfo: () => ipcRenderer.invoke('session:info'),
  clearSiteSession: (target) => ipcRenderer.invoke('session:clearSite', target),
  clearAllSession: () => ipcRenderer.invoke('session:clearAll'),
  // Görüntüleme modları API'leri (Fullscreen, In Window, Windowed, PiP)
  openInWindow: (state) => ipcRenderer.invoke('display:openInWindow', state),
  closeInWindow: (state) => ipcRenderer.invoke('display:closeInWindow', state),
  reportDetachedState: (state) => ipcRenderer.invoke('display:reportDetachedState', state),
  openPipFallback: (state) => ipcRenderer.invoke('display:pipFallback', state),
  onNav: on('nav:update'),
  onCapture: on('capture:update'),
  onPopups: on('popups:update'),
  onHistory: on('history:update'),
  onSettings: on('settings:update'),
  onBookmarks: on('bookmarks:update'),
  onDownloads: on('downloads:update'),
  onDownloadProgress: on('downloads:progress'),
  onDetachedInit: on('detached:init'),
  onReturnToWindowed: on('display:returnToWindowed'),
});
