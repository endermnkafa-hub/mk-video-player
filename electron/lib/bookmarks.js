'use strict';
/**
 * MK VideoPlayer - Favoriler / İzleme Listesi Deposu (BookmarkStore)
 *
 * - Kullanıcının beğendiği veya daha sonra izlemek istediği içerikleri saklar.
 * - Atomik dosya yazımıyla diske kaydedilir.
 * - Mükerrer kayıtları sayfa adresi veya başlık üzerinden eler.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class BookmarkStore {
  constructor({ storagePath, onChange }) {
    this.storagePath = storagePath;
    this.onChange = onChange;
    this.items = [];
    this._load();
  }

  _load() {
    if (!this.storagePath) return;
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.items = parsed.filter((it) => it && typeof it === 'object' && it.id);
        }
      }
    } catch (e) {
      this.items = [];
    }
  }

  _save() {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${this.storagePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), 'utf8');
      fs.renameSync(tmp, this.storagePath);
      if (this.onChange) this.onChange(this.list());
    } catch (e) {
      console.error('BookmarkStore kaydetme hatası:', e);
    }
  }

  list(query = '') {
    const q = (query || '').trim().toLowerCase();
    const sorted = [...this.items].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!q) return sorted;
    return sorted.filter((it) => {
      const title = (it.title || '').toLowerCase();
      const pageUrl = (it.pageUrl || '').toLowerCase();
      const host = (it.host || '').toLowerCase();
      return title.includes(q) || pageUrl.includes(q) || host.includes(q);
    });
  }

  has(pageUrl) {
    if (!pageUrl) return false;
    const clean = String(pageUrl).split('#')[0].trim();
    return this.items.some((it) => it.pageUrl && it.pageUrl.split('#')[0].trim() === clean);
  }

  get(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  add({ title, pageUrl, streamUrl, host, meta = {} }) {
    if (!pageUrl && !streamUrl) return null;
    const cleanPage = pageUrl ? String(pageUrl).trim() : '';
    // Varsa güncelle
    const existing = this.items.find((it) => (cleanPage && it.pageUrl === cleanPage));
    const now = Date.now();
    if (existing) {
      if (title) existing.title = title;
      if (streamUrl) existing.streamUrl = streamUrl;
      if (host) existing.host = host;
      existing.updatedAt = now;
      this._save();
      return existing;
    }

    const item = {
      id: crypto.randomUUID ? crypto.randomUUID() : `bm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: title || 'İsimsiz Video',
      pageUrl: cleanPage,
      streamUrl: streamUrl || '',
      host: host || '',
      meta: meta || {},
      createdAt: now,
      updatedAt: now,
    };

    this.items.unshift(item);
    this._save();
    return item;
  }

  remove(idOrPageUrl) {
    if (!idOrPageUrl) return false;
    const clean = String(idOrPageUrl).split('#')[0].trim();
    const prevLen = this.items.length;
    this.items = this.items.filter((it) => it.id !== idOrPageUrl && it.pageUrl !== idOrPageUrl && (!it.pageUrl || it.pageUrl.split('#')[0].trim() !== clean));
    if (this.items.length !== prevLen) {
      this._save();
      return true;
    }
    return false;
  }

  toggle({ title, pageUrl, streamUrl, host, meta }) {
    if (this.has(pageUrl)) {
      this.remove(pageUrl);
      return { added: false };
    }
    const item = this.add({ title, pageUrl, streamUrl, host, meta });
    return { added: true, item };
  }

  clear() {
    this.items = [];
    this._save();
  }
}

module.exports = { BookmarkStore };
