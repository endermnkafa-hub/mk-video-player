'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { BookmarkStore } = require('../../electron/lib/bookmarks.js');

test('BookmarkStore: ekleme, listeleme, arama ve silme', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-bm-test-'));
  const filePath = path.join(tmpDir, 'bookmarks.json');

  const store = new BookmarkStore({ storagePath: filePath });
  assert.equal(store.list().length, 0);

  // Ekleme
  const bm1 = store.add({
    title: 'Dragon Ball 27. Bölüm',
    pageUrl: 'https://anizm.net/dragon-ball-27-bolum-izle',
    host: 'anizm.net',
  });
  assert.ok(bm1 && bm1.id);
  assert.equal(store.has('https://anizm.net/dragon-ball-27-bolum-izle'), true);
  assert.equal(store.has('https://anizm.net/naruto-1-bolum'), false);

  // Mükerrer ekleme güncelleme yapmalı
  const bm1Updated = store.add({
    title: 'Dragon Ball 27. Bölüm (HD)',
    pageUrl: 'https://anizm.net/dragon-ball-27-bolum-izle',
  });
  assert.equal(bm1Updated.id, bm1.id);
  assert.equal(bm1Updated.title, 'Dragon Ball 27. Bölüm (HD)');
  assert.equal(store.list().length, 1);

  // İkinci öğe
  store.add({
    title: 'One Piece 1000. Bölüm',
    pageUrl: 'https://anizm.net/one-piece-1000-bolum-izle',
    host: 'anizm.net',
  });
  assert.equal(store.list().length, 2);

  // Arama filtresi
  assert.equal(store.list('dragon').length, 1);
  assert.equal(store.list('one piece').length, 1);
  assert.equal(store.list('olmayan').length, 0);

  // Toggle (var olanı siler)
  const toggled = store.toggle({ pageUrl: 'https://anizm.net/one-piece-1000-bolum-izle' });
  assert.equal(toggled.added, false);
  assert.equal(store.list().length, 1);

  // Diske kaydedildiğini ve yeni örnekte korunduğunu doğrula
  const store2 = new BookmarkStore({ storagePath: filePath });
  assert.equal(store2.list().length, 1);
  assert.equal(store2.list()[0].title, 'Dragon Ball 27. Bölüm (HD)');

  // Silme
  assert.equal(store2.remove(bm1.id), true);
  assert.equal(store2.list().length, 0);
});
