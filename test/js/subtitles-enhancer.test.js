const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createPlayer, srtToVtt } = require('../../frontend/js/player.js');

test('srtToVtt: SRT biçimindeki altyazıları standart WebVTT biçimine dönüştürür', () => {
  const srtSample = `1
00:00:01,200 --> 00:00:04,500
Naruto: Ben Hokage olacağım!

2
00:00:05,100 --> 00:00:08,900
Sasuke: Çok konuşma aptal.`;

  const vtt = srtToVtt(srtSample);
  assert.ok(vtt.startsWith('WEBVTT'));
  // Virgüllü zaman damgaları noktaya dönüşmeli
  assert.ok(vtt.includes('00:00:01.200 --> 00:00:04.500'));
  assert.ok(vtt.includes('00:00:05.100 --> 00:00:08.900'));
  assert.ok(vtt.includes('Naruto: Ben Hokage olacağım!'));

  // Zaten WebVTT ise tekrar bozmamalı
  const alreadyVtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTest';
  assert.equal(srtToVtt(alreadyVtt), alreadyVtt);

  // Boş veya geçersiz girdi
  assert.equal(srtToVtt(''), 'WEBVTT\n\n');
  assert.equal(srtToVtt(null), 'WEBVTT\n\n');
});

test('HLS altyazı parçaları: onSubtitleTracks ve setSubtitleTrack çalışır', () => {
  class MockHls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'mp', SUBTITLE_TRACKS_UPDATED: 'stu' };
    constructor() {
      this.handlers = {};
      this.subtitleTracks = [
        { id: 0, name: 'Türkçe', lang: 'tr' },
        { id: 1, name: 'English', lang: 'en' },
      ];
      this._subTrack = -1;
    }
    get subtitleTrack() { return this._subTrack; }
    set subtitleTrack(v) { this._subTrack = v; }
    on(ev, fn) { this.handlers[ev] = fn; }
    emit(ev, data) { if (this.handlers[ev]) this.handlers[ev](ev, data); }
    loadSource() {}
    attachMedia() {}
    destroy() {}
  }

  const dom = new JSDOM('<!DOCTYPE html><video></video>');
  const video = dom.window.document.querySelector('video');
  video.pause = () => {};
  video.load = () => {};

  let receivedTracks = [];
  const player = createPlayer({
    video,
    Hls: MockHls,
    onSubtitleTracks: (t) => { receivedTracks = t; },
  });

  player.load({ url: 'http://test/anime.m3u8', kind: 'hls' });

  // Manifest yüklendiğinde altyazılar iletilmeli
  const engine = player.engine;
  assert.ok(engine);
  engine.emit('mp', { levels: [] });

  assert.equal(receivedTracks.length, 2);
  assert.equal(receivedTracks[0].name, 'Türkçe');
  assert.equal(receivedTracks[1].name, 'English');

  // getSubtitleTracks
  const tracks = player.getSubtitleTracks();
  assert.equal(tracks.length, 2);

  // setSubtitleTrack
  const ok = player.setSubtitleTrack(0);
  assert.ok(ok);
  assert.equal(engine.subtitleTrack, 0);

  // Altyazıyı kapat
  player.setSubtitleTrack(-1);
  assert.equal(engine.subtitleTrack, -1);
});

test('Anime Görüntü İyileştirici ve En-Boy Oranı CSS ve SVG varlığı', () => {
  const fs = require('fs');
  const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '../../frontend/index.html'), 'utf8');

  // Donanım hızlandırmalı SVG filtre tanımları
  assert.ok(html.includes('id="anime-restore-hd"'));
  assert.ok(html.includes('id="anime-smooth-cel"'));
  assert.ok(html.includes('id="anime-ultra-edge"'));
  assert.ok(html.includes('feGaussianBlur'));
  assert.ok(html.includes('feComposite'));
  assert.ok(html.includes('operator="arithmetic"'));

  // CSS sınıfları
  assert.ok(html.includes('.enhance-anime-hd'));
  assert.ok(html.includes('.enhance-anime-smooth'));
  assert.ok(html.includes('.enhance-anime-vivid'));
  assert.ok(html.includes('.enhance-anime-ultra'));
  assert.ok(html.includes('.aspect-16-9'));
  assert.ok(html.includes('.aspect-4-3'));
  assert.ok(html.includes('.aspect-cover'));

  // Altyazı ve Hızlı Ayarlar kontrolleri
  assert.ok(html.includes('id="btnSubtitles"'));
  assert.ok(html.includes('id="subtitlesMenu"'));
  assert.ok(html.includes('id="videoEnhanceSelector"'));
  assert.ok(html.includes('id="aspectRatioSelector"'));
});
