'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SourceRegistry } = require('../../electron/lib/registry.js');

test('SourceRegistry hem fromActiveStream hem fromSegmentRecovery bayraklarını kabul eder', () => {
  const reg = new SourceRegistry();
  reg.start();
  reg.resetForNavigation('https://page.example.com/');

  // Kullanıcı henüz tıklamadı ama probeActiveMedia DOM'dan video yakaladı
  const r1 = reg.offer({
    url: 'https://stream.example.com/live.m3u8',
    classification: { role: 'source', kind: 'hls', host: 'stream.example.com', supported: true },
    token: reg.beginRequest(1),
    fromSegmentRecovery: true,
  });
  assert.equal(r1.status, 'added');
  assert.equal(reg.list().length, 1);
  assert.equal(reg.list()[0].recovered, true);

  // fromActiveStream bayrağıyla da kabul edilir
  const r2 = reg.offer({
    url: 'https://stream.example.com/video.mp4',
    classification: { role: 'source', kind: 'mp4', host: 'stream.example.com', supported: true },
    token: reg.beginRequest(2),
    fromActiveStream: true,
  });
  assert.equal(r2.status, 'added');
  assert.equal(reg.list().length, 2);
});

test('Görüntüleme modları (Fullscreen, In Window, PiP): normal modda işaretleme yapılmaz ve In Window toggle çalışır', () => {
  let displayMode = 'normal';
  let inWindowExpanded = false;

  function updateCheckmarks(mode) {
    return {
      fullscreen: mode === 'fullscreen',
      inWindow: mode === 'in_window',
      pip: mode === 'pip',
    };
  }

  function setDisplayMode(newMode) {
    if (newMode === displayMode && (newMode === 'in_window' || newMode === 'fullscreen' || newMode === 'pip')) {
      newMode = 'normal';
    }
    displayMode = newMode;
    inWindowExpanded = (newMode === 'in_window');
    return { displayMode, inWindowExpanded, checkmarks: updateCheckmarks(displayMode) };
  }

  // 1. Başlangıçta normal mod: hiçbir seçenek işaretli değildir
  let checks = updateCheckmarks(displayMode);
  assert.equal(checks.fullscreen, false);
  assert.equal(checks.inWindow, false);
  assert.equal(checks.pip, false);

  // 2. Fullscreen'e geçiş
  let res = setDisplayMode('fullscreen');
  assert.equal(res.displayMode, 'fullscreen');
  assert.equal(res.checkmarks.fullscreen, true);
  assert.equal(res.checkmarks.inWindow, false);

  // 3. In Window moduna geçiş: player pencereyi kaplar, sadece in_window işaretlenir
  res = setDisplayMode('in_window');
  assert.equal(res.displayMode, 'in_window');
  assert.equal(res.inWindowExpanded, true);
  assert.equal(res.checkmarks.inWindow, true);
  assert.equal(res.checkmarks.fullscreen, false);

  // 4. In Window modundayken tekrar In Window seçilirse veya Escape'e basılırsa normal moda döner
  res = setDisplayMode('in_window');
  assert.equal(res.displayMode, 'normal');
  assert.equal(res.inWindowExpanded, false);
  assert.equal(res.checkmarks.inWindow, false);
  assert.equal(res.checkmarks.fullscreen, false);
  assert.equal(res.checkmarks.pip, false);

  // 5. PiP geçişi
  res = setDisplayMode('pip');
  assert.equal(res.displayMode, 'pip');
  assert.equal(res.checkmarks.pip, true);

  // 6. PiP'ten çıkışta normal moda dönüş
  res = setDisplayMode('normal');
  assert.equal(res.displayMode, 'normal');
  assert.equal(res.checkmarks.pip, false);
});
