'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { IntroDetector } = require('../../electron/lib/intro-detector.js');

test('IntroDetector: extractEpisodeInfo başlık ve URL üzerinden dizi ve bölüm bilgilerini ayıklar', () => {
  const detector = new IntroDetector();

  const case1 = detector.extractEpisodeInfo({
    pageTitle: 'Sousou no Frieren 5. Bölüm HD İzle - Anizm',
    pageUrl: 'https://anizm.net/sousou-no-frieren-5-bolum',
  });
  assert.equal(case1.title.toLowerCase(), 'sousou no frieren');
  assert.equal(case1.episodeNumber, 5);

  const case2 = detector.extractEpisodeInfo({
    pageTitle: 'One Piece 1085. Bölüm Türkçe Altyazılı İzle',
    pageUrl: 'https://site.com/watch?v=123',
  });
  assert.equal(case2.title.toLowerCase(), 'one piece');
  assert.equal(case2.episodeNumber, 1085);

  const case3 = detector.extractEpisodeInfo({
    pageTitle: 'Jujutsu Kaisen 2. Sezon 4. Bölüm HD İzle',
    pageUrl: 'https://site.com/jujutsu-kaisen-2-sezon-4-bolum',
  });
  assert.ok(case3.title.toLowerCase().includes('jujutsu kaisen'));
  assert.equal(case3.episodeNumber, 4);

  const case4 = detector.extractEpisodeInfo({
    pageTitle: 'Attack on Titan S04E15 Full HD',
  });
  assert.ok(case4.title.toLowerCase().includes('attack on titan'));
  assert.equal(case4.episodeNumber, 15);

  const case5 = detector.extractEpisodeInfo({
    pageTitle: 'Animeci.net',
    pageUrl: 'https://animeci.net/anime/demon-slayer-episode-26',
  });
  assert.ok(case5.title.toLowerCase().includes('demon slayer'));
  assert.equal(case5.episodeNumber, 26);

  const case6 = detector.extractEpisodeInfo({
    pageTitle: 'Dragon Ball 31. Bölüm izle | Türkçe Altyazılı Anime İzle',
    pageUrl: 'https://anizm.net/dragon-ball-31-bolum-izle',
  });
  assert.equal(case6.title.toLowerCase(), 'dragon ball');
  assert.equal(case6.episodeNumber, 31);
});

test('IntroDetector: correlateEnergySignatures bölümler arası birebir intro müziğini tespit eder', () => {
  const detector = new IntroDetector();
  const sampleRate = 2; // 2 Hz (örnek başına 0.5 saniye)
  const totalSamples = 300; // 150 saniye

  // 85 saniyelik karakteristik müzik deseni (170 örnek)
  const introPattern = [];
  for (let i = 0; i < 170; i++) {
    introPattern.push(0.6 + 0.3 * Math.sin(i * 0.4));
  }

  // Bölüm 1: 15. saniyede (30. örnekte) başlayan intro, öncesinde Ep1 diyaloğu
  const sigEp1 = Array.from({ length: totalSamples }, () => 0.1 + Math.random() * 0.05);
  for (let i = 0; i < introPattern.length; i++) {
    sigEp1[30 + i] = introPattern[i];
  }

  // Bölüm 2: 30. saniyede (60. örnekte) başlayan aynı intro, öncesinde farklı Ep2 diyaloğu
  const sigEp2 = Array.from({ length: totalSamples }, () => 0.1 + Math.random() * 0.05);
  for (let i = 0; i < introPattern.length; i++) {
    sigEp2[60 + i] = introPattern[i];
  }

  const result = detector.correlateEnergySignatures(sigEp1, sigEp2, sampleRate);
  assert.equal(result.matched, true);
  assert.ok(result.confidence >= 0.85, `Korelasyon en az 0.85 olmalı: ${result.confidence}`);
  assert.ok(Math.abs(result.start - 15) <= 2, `Bölüm 1 intro başlangıcı yaklaşık 15s olmalı: ${result.start}`);
  assert.ok(Math.abs(result.matchStartB - 30) <= 2, `Bölüm 2 intro başlangıcı yaklaşık 30s olmalı: ${result.matchStartB}`);
});

test('IntroDetector: correlateEnergySignatures alakasız gürültülerde eşleşme üretmez', () => {
  const detector = new IntroDetector();
  const sigA = Array.from({ length: 200 }, () => Math.random() * 0.2);
  const sigB = Array.from({ length: 200 }, () => Math.random() * 0.2);

  const result = detector.correlateEnergySignatures(sigA, sigB, 2);
  assert.equal(result.matched, false);
});

test('IntroDetector: detectIntroFromEnergy tek bölümde akustik enerji platosunu bulur', () => {
  const detector = new IntroDetector();
  const sampleRate = 2;
  const samples = new Array(300).fill(0.02);

  // 20. saniyeden 105. saniyeye kadar süren (85 sn) yüksek enerjili müzik platosu
  for (let i = 40; i < 210; i++) {
    samples[i] = 0.5 + 0.05 * Math.sin(i);
  }

  const res = detector.detectIntroFromEnergy(samples, sampleRate);
  assert.equal(res.matched, true);
  assert.ok(Math.abs(res.start - 20) <= 3, `Başlangıç yaklaşık 20s olmalı: ${res.start}`);
  assert.ok(res.confidence > 0.5);
});

test('IntroDetector: parmak izi saklama, karşılaştırma ve önbellek kalıcılığı', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-test-'));
  try {
    const detector1 = new IntroDetector({ cacheDir: tmpDir });

    const introSamples = Array.from({ length: 200 }, (_, i) => 0.6 + 0.2 * Math.cos(i * 0.3));
    detector1.saveSeriesFingerprint('Frieren', 1, introSamples, 2);

    // Aynı desene sahip Bölüm 2 karşılaştırıldığında eşleşmeli
    const match = detector1.matchSeriesFingerprint('Frieren', introSamples, 2);
    assert.equal(match.matched, true);
    assert.equal(match.source, 'fingerprint_cross_episode');

    // Yeni örnek başlatıldığında diskteki veriler yüklenmeli
    const detector2 = new IntroDetector({ cacheDir: tmpDir });
    const match2 = detector2.matchSeriesFingerprint('Frieren', introSamples, 2);
    assert.equal(match2.matched, true);

    // Önbellek temizleme
    detector2.clearCache();
    const match3 = detector2.matchSeriesFingerprint('Frieren', introSamples, 2);
    assert.equal(match3.matched, false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('IntroDetector: detectIntro kademeli mimarisi (AniSkip -> Parmak İzi -> Sezgisel)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intro-cascade-'));
  try {
    const detector = new IntroDetector({ cacheDir: tmpDir });

    // 1. Akıllı algılama kapalıysa doğrudan sezgisel dönmeli
    const heuristicRes = await detector.detectIntro(
      { pageTitle: 'One Piece 1. Bölüm' },
      { smartIntroDetection: false, introSkipSeconds: 90 }
    );
    assert.equal(heuristicRes.found, false);
    assert.equal(heuristicRes.source, 'heuristic');
    assert.equal(heuristicRes.intro.end, 90);

    // 2. AniSkip başarılı mock senaryosu
    detector.resolveMalId = async () => 21; // One Piece MAL ID
    detector.fetchAniSkipTimes = async () => ({
      found: true,
      source: 'aniskip',
      intro: { start: 120, end: 210, duration: 90 },
      outro: { start: 1350, end: 1440, duration: 90 },
    });

    const aniSkipRes = await detector.detectIntro(
      { pageTitle: 'One Piece 1. Bölüm' },
      { smartIntroDetection: true }
    );
    assert.equal(aniSkipRes.found, true);
    assert.equal(aniSkipRes.source, 'aniskip');
    assert.equal(aniSkipRes.intro.start, 120);
    assert.equal(aniSkipRes.intro.end, 210);

    // 3. AniSkip bulunamadığında parmak izine (Tier 2) geçiş
    detector.fetchAniSkipTimes = async () => null;

    const energySamples = new Array(300).fill(0.02);
    for (let i = 40; i < 210; i++) {
      energySamples[i] = 0.55 + 0.04 * Math.sin(i);
    }

    const tier2Res = await detector.detectIntro(
      { pageTitle: 'Bilinmeyen Dizi 1. Bölüm', energySamples, sampleRate: 2 },
      { smartIntroDetection: true }
    );
    assert.equal(tier2Res.found, true);
    assert.equal(tier2Res.source, 'fingerprint');

    // 4. Parmak izi de yoksa sezgisel yedeğe (Tier 3) düşüş
    const tier3Res = await detector.detectIntro(
      { pageTitle: 'Bilinmeyen Dizi' },
      { smartIntroDetection: true, introSkipSeconds: 85 }
    );
    assert.equal(tier3Res.found, false);
    assert.equal(tier3Res.source, 'heuristic');
    assert.equal(tier3Res.intro.end, 85);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('IntroDetector: AniSkip spesifik bölüm bulunamadığında serinin 1. bölüm açılışını başarıyla devralır', async () => {
  const detector = new IntroDetector();
  detector.resolveMalId = async () => 223; // Dragon Ball
  detector.fetchAniSkipTimes = async ({ episodeNumber }) => {
    if (episodeNumber === 27) return null; // 27. bölüm etiketlenmemiş
    if (episodeNumber === 1) {
      return {
        found: true,
        source: 'aniskip',
        intro: { start: 2.5, end: 92.5, duration: 90 },
        outro: null,
      };
    }
    return null;
  };

  const res = await detector.detectIntro({
    pageTitle: 'Dragon Ball 27. Bölüm İzle',
    pageUrl: 'https://anizm.net/dragon-ball-27-bolum-izle',
  }, { smartIntroDetection: true });

  assert.equal(res.found, true);
  assert.equal(res.source, 'aniskip');
  assert.equal(res.intro.start, 2.5);
  assert.equal(res.intro.end, 92.5);
});
