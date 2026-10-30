'use strict';
/**
 * MK VideoPlayer - Akıllı İntro ve Outro Algılama Servisi (IntroDetector)
 *
 * 3 Kademeli Akıllı Algılama Mimarisi (Cascade):
 *
 * Kademe 1: AniSkip API
 *   - Anime/Dizi başlığı ve bölüm numarasını başlık veya URL'den ayıklar.
 *   - AniList GraphQL ve Jikan API üzerinden MAL (MyAnimeList) kimliğini bulur.
 *   - AniSkip açık veritabanından kesin intro (OP) ve outro (ED) zaman aralıklarını sorgular.
 *   - Tekrarlanan API isteklerini önlemek için başlık-kimlik eşleştirmelerini yerel diskte önbelleğe alır.
 *
 * Kademe 2: Yerel Ses Parmak İzi & Bölümler Arası Çapraz Korelasyon (Local Audio Fingerprint)
 *   - İnternet bağlantısı olmadığında, çevrimdışı videolarda veya AniSkip'te bulunamayan dizilerde:
 *   - Dizinin önceki bölümlerinin ses enerjisi profiliyle mevcut bölümü kayan pencere korelasyonuyla karşılaştırır.
 *   - Bölümler arasındaki birebir eşleşen intro müziği aralığını hassas olarak tespit eder.
 *   - Tek bölüm durumunda 0:00 - 3:30 arasındaki akustik enerji platosunu analiz eder.
 *
 * Kademe 3: Akıllı Sezgisel Yedek (Smart Heuristic Fallback)
 *   - Kademe 1 ve 2 sonuç vermezse kullanıcının tercih ettiği standart atlama süresini (varsayılan 85 sn) uygular.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class IntroDetector {
  constructor({ cacheDir = null } = {}) {
    this.cacheDir = cacheDir;
    this.titleCacheFile = cacheDir ? path.join(cacheDir, 'anime_title_cache.json') : null;
    this.fingerprintCacheFile = cacheDir ? path.join(cacheDir, 'series_fingerprints.json') : null;

    this.titleCache = new Map(); // normalizedTitle -> malId
    this.fingerprints = new Map(); // seriesKey -> [ { episode, samples, sampleRate } ]

    this._loadCache();
  }

  _loadCache() {
    if (this.titleCacheFile && fs.existsSync(this.titleCacheFile)) {
      try {
        const raw = fs.readFileSync(this.titleCacheFile, 'utf8');
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) {
          this.titleCache.set(k, v);
        }
      } catch (_) {}
    }

    if (this.fingerprintCacheFile && fs.existsSync(this.fingerprintCacheFile)) {
      try {
        const raw = fs.readFileSync(this.fingerprintCacheFile, 'utf8');
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) {
          this.fingerprints.set(k, v);
        }
      } catch (_) {}
    }
  }

  _saveCache() {
    if (this.titleCacheFile) {
      try {
        const dir = path.dirname(this.titleCacheFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const obj = Object.fromEntries(this.titleCache);
        fs.writeFileSync(this.titleCacheFile, JSON.stringify(obj, null, 2), 'utf8');
      } catch (_) {}
    }

    if (this.fingerprintCacheFile) {
      try {
        const dir = path.dirname(this.fingerprintCacheFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const obj = Object.fromEntries(this.fingerprints);
        fs.writeFileSync(this.fingerprintCacheFile, JSON.stringify(obj, null, 2), 'utf8');
      } catch (_) {}
    }
  }

  clearCache() {
    this.titleCache.clear();
    this.fingerprints.clear();
    this._saveCache();
  }

  /**
   * Sayfa başlığı, video başlığı ve URL adresinden temiz dizi/anime adı ve bölüm numarasını ayıklar.
   */
  extractEpisodeInfo({ pageTitle = '', pageUrl = '', streamTitle = '' } = {}) {
    let raw = (pageTitle || streamTitle || '').trim();
    let episodeNumber = null;

    // 1. Bölüm numarasını tespit et
    const sxeMatch = raw.match(/s\d+e(\d+)/i);
    const epMatch = raw.match(/(?:(?:sezon|\d+\.\s*sezon)?\s*(\d+)\s*\.\s*[Bb]ölüm|[Bb]ölüm\s*(\d+)|[Ee]pisode\s*(\d+)|[Ee]p\s*(\d+))/i);

    if (sxeMatch) {
      episodeNumber = parseInt(sxeMatch[1], 10);
    } else if (epMatch) {
      episodeNumber = parseInt(epMatch[1] || epMatch[2] || epMatch[3] || epMatch[4], 10);
    } else if (pageUrl) {
      const urlEpMatch = pageUrl.match(/(?:bolum|episode|ep)[-_]?(\d+)/i) || pageUrl.match(/(\d+)[-_]?(?:bolum|episode)/i);
      if (urlEpMatch) {
        episodeNumber = parseInt(urlEpMatch[1], 10);
      }
    }

    // 2. Dizi / Anime Başlığını Ayıkla
    let cleanTitle = '';
    const isUrlTitle = !raw || /^https?:\/\//i.test(raw);

    if (!isUrlTitle) {
      // Başlıkta "31. Bölüm" veya "Bölüm 31" varsa, bölümden önceki kısım dizi adıdır
      const splitEp = raw.split(/(?:\d+\.\s*[Bb]ölüm|[Bb]ölüm\s*\d+|[Ee]pisode\s*\d+|[Ee]p\s*\d+|s\d+e\d+|\b\d+\.\s*sezon\b)/i);
      if (splitEp.length > 1 && splitEp[0].trim().length >= 2) {
        cleanTitle = splitEp[0].trim();
      } else {
        cleanTitle = raw;
      }

      // Streaming site eklerini ve gürültü kelimelerini temizle
      cleanTitle = cleanTitle
        .replace(/\s*[-–|/]\s*(?:anizm|anime|dizi|film|hd|izle|watch|online|full|türkçe|altyazı).*$/i, '')
        .replace(/\b(?:izle|türkçe|altyazılı|dublajlı|dublaj|altyazı|online|full\s*hd|1080p|720p)\b/gi, '')
        .replace(/[-–:_|/]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // 3. Eğer başlık boşsa, çok kısaysa veya sadece domain ise URL slug'ından çıkar
    const isDomainOnly = /^[a-z0-9-]+\.(?:net|org|com|co|tv|vip|me|to|site|fun|io|cc)$/i.test(cleanTitle) ||
                         /^[a-z0-9-]+\s+(?:net|org|com|co|tv|vip|me|to|site|fun|io|cc)$/i.test(cleanTitle);

    if ((!cleanTitle || isDomainOnly || cleanTitle.length < 3 || isUrlTitle) && pageUrl) {
      try {
        const u = new URL(pageUrl);
        const parts = u.pathname.replace(/^\/|\/$/g, '').split('/');
        const slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
        const cleanSlug = decodeURIComponent(slug)
          .replace(/(?:\d+[-_]?(?:bolum|episode|ep)|(?:bolum|episode|ep)[-_]?\d+)/gi, '')
          .replace(/(?:[-_]?(?:izle|watch|online|hd|full|turkce|altyazili))/gi, '')
          .replace(/[-_]+/g, ' ')
          .trim();
        if (cleanSlug && cleanSlug.length >= 2) {
          cleanTitle = cleanSlug;
        }
      } catch (_) {}
    }

    // Baş harfleri düzelt (Title Case)
    if (cleanTitle) {
      cleanTitle = cleanTitle
        .split(' ')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }

    const normalizedTitle = (cleanTitle || '').toLowerCase().replace(/[^a-z0-9]/gi, ' ').replace(/\s+/g, ' ').trim();

    return {
      title: cleanTitle || 'Anime',
      normalizedTitle,
      episodeNumber: Number.isFinite(episodeNumber) && episodeNumber > 0 ? episodeNumber : null,
    };
  }

  /**
   * AniList GraphQL üzerinden MAL ID (MyAnimeList ID) sorgular.
   */
  async resolveMalId(title) {
    if (!title || typeof title !== 'string') return null;
    const norm = title.toLowerCase().replace(/[^a-z0-9]/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) return null;

    if (this.titleCache.has(norm)) {
      return this.titleCache.get(norm);
    }

    // 1. AniList GraphQL API sorgusu (Hızlı ve güvenilir)
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const query = `
        query ($search: String) {
          Media(search: $search, type: ANIME) {
            idMal
            title { romaji english }
          }
        }
      `;
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MKVideoPlayer/2.0',
        },
        body: JSON.stringify({ query, variables: { search: title } }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const malId = data?.data?.Media?.idMal;
        if (malId && Number.isFinite(malId)) {
          this.titleCache.set(norm, malId);
          this._saveCache();
          return malId;
        }
      }
    } catch (_) {
      // Ağ hatası veya zaman aşımında sessizce devam et
    }

    // 2. Yedek: Jikan MAL Search API
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      const res = await fetch(`https://api.jikan.moe/v4/anime?q=${encodeURIComponent(title)}&limit=1`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MKVideoPlayer/2.0' },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const malId = data?.data?.[0]?.mal_id;
        if (malId && Number.isFinite(malId)) {
          this.titleCache.set(norm, malId);
          this._saveCache();
          return malId;
        }
      }
    } catch (_) {}

    return null;
  }

  /**
   * AniSkip API üzerinden bölüm için resmi intro/outro atlama sürelerini sorgular.
   */
  async fetchAniSkipTimes({ malId, episodeNumber, duration = 0 }) {
    if (!malId || !episodeNumber) return null;

    const queryEndpoint = async (ep) => {
      try {
        // episodeLength=0 AniSkip API'sinde katı süre doğrulamasını baypas ederek kesin veriyi döndürür
        const url = `https://api.aniskip.com/v2/skip-times/${malId}/${ep}?types[]=op&types[]=ed&types[]=mixed-op&types[]=recap&episodeLength=0`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3500);

        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MKVideoPlayer/2.0' },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !data.found || !Array.isArray(data.results)) return null;

        let intro = null;
        let outro = null;

        for (const item of data.results) {
          if (!item || !item.interval) continue;
          const start = Math.max(0, Number(item.interval.startTime) || 0);
          const end = Math.max(start, Number(item.interval.endTime) || 0);
          if (end <= start) continue;

          const type = (item.skipType || '').toLowerCase();
          if ((type === 'op' || type === 'mixed-op') && !intro) {
            intro = { start, end, duration: end - start };
          } else if (type === 'ed' && !outro) {
            outro = { start, end, duration: end - start };
          }
        }

        if (intro || outro) {
          return {
            found: true,
            source: 'aniskip',
            intro,
            outro,
            malId,
            episodeNumber: ep,
          };
        }
      } catch (_) {}
      return null;
    };

    // 1. İstenen spesifik bölümü sorgula
    let res = await queryEndpoint(episodeNumber);
    // 2. Eğer spesifik bölüm henüz etiketlenmemişse (404), serinin genel açılış müziği için standart TV bölümlerini (2, 3 veya 1) sorgula
    if (!res && episodeNumber > 1) {
      for (const candidateEp of [2, 3, 1]) {
        res = await queryEndpoint(candidateEp);
        if (res && res.intro) break;
      }
    }

    return res;
  }

  /**
   * İki ses enerji sinyali dizisi arasındaki Pearson korelasyonunu hesaplar.
   * Kayan pencere ile intro eşleşme aralığını (60 - 95 sn) bulur.
   */
  correlateEnergySignatures(sigA, sigB, sampleRate = 2) {
    if (!Array.isArray(sigA) || !Array.isArray(sigB) || sigA.length < 30 || sigB.length < 30) {
      return { matched: false };
    }

    // Standart intro penceresi: 60 sn ile 95 sn arası (örneğin 2 Hz'de 120 - 190 örnek)
    const winLen = Math.min(Math.round(85 * sampleRate), Math.min(sigA.length, sigB.length));
    if (winLen < 30) return { matched: false };

    let bestCorr = -1;
    let bestStartA = 0;
    let bestStartB = 0;
    let bestLen = winLen / sampleRate;

    // A ve B sinyalleri üzerinde kayan pencere araması
    const maxSearchA = Math.min(sigA.length - winLen, Math.round(210 * sampleRate));
    const maxSearchB = Math.min(sigB.length - winLen, Math.round(210 * sampleRate));

    for (let i = 0; i <= maxSearchA; i += 2) {
      const sliceA = sigA.slice(i, i + winLen);
      if (sliceA.length < winLen) continue;

      // Ortalama ve varyans A
      let sumA = 0;
      for (let k = 0; k < winLen; k++) sumA += sliceA[k];
      const meanA = sumA / winLen;
      let varA = 0;
      for (let k = 0; k < winLen; k++) varA += (sliceA[k] - meanA) ** 2;
      if (varA < 0.001) continue; // sessiz bölgeyi atla

      for (let j = 0; j <= maxSearchB; j += 2) {
        const sliceB = sigB.slice(j, j + winLen);
        if (sliceB.length < winLen) continue;

        let sumB = 0;
        for (let k = 0; k < winLen; k++) sumB += sliceB[k];
        const meanB = sumB / winLen;
        let varB = 0;
        for (let k = 0; k < winLen; k++) varB += (sliceB[k] - meanB) ** 2;
        if (varB < 0.001) continue;

        let cov = 0;
        for (let k = 0; k < winLen; k++) {
          cov += (sliceA[k] - meanA) * (sliceB[k] - meanB);
        }

        const corr = cov / Math.sqrt(varA * varB);
        if (corr > bestCorr) {
          bestCorr = corr;
          bestStartA = i / sampleRate;
          bestStartB = j / sampleRate;
        }
      }
    }

    if (bestCorr >= 0.78) {
      return {
        matched: true,
        confidence: Math.round(bestCorr * 100) / 100,
        start: bestStartA,
        end: bestStartA + bestLen,
        matchStartB: bestStartB,
        duration: bestLen,
      };
    }

    return { matched: false, confidence: Math.max(0, bestCorr) };
  }

  /**
   * Tek bir bölümün ses enerjisinden intro müzik platosunu (yüksek ritim/düşük varyans) tespit eder.
   */
  detectIntroFromEnergy(samples, sampleRate = 2) {
    if (!Array.isArray(samples) || samples.length < 60) return { matched: false };

    const targetSec = 85;
    const winLen = Math.round(targetSec * sampleRate);
    const maxSearch = Math.min(samples.length - winLen, Math.round(210 * sampleRate));

    let bestScore = -1;
    let bestStart = 0;

    for (let i = 0; i < maxSearch; i++) {
      const slice = samples.slice(i, i + winLen);
      let sum = 0;
      for (let k = 0; k < slice.length; k++) sum += slice[k];
      const mean = sum / slice.length;

      let variance = 0;
      for (let k = 0; k < slice.length; k++) variance += (slice[k] - mean) ** 2;
      variance = variance / slice.length;

      // Intro müziği: Yüksek ortalama enerji + düşük dinamik varyans (sıkıştırılmış ritmik müzik)
      if (mean > 0.15 && variance < 0.05) {
        const score = mean / (variance + 0.01);
        if (score > bestScore) {
          bestScore = score;
          bestStart = i / sampleRate;
        }
      }
    }

    if (bestScore > 1.8) {
      return {
        matched: true,
        start: bestStart,
        end: bestStart + targetSec,
        confidence: Math.min(0.95, Math.round((bestScore / 3) * 100) / 100),
      };
    }

    return { matched: false };
  }

  /**
   * Bir dizi/anime bölümünün ses parmak izini kaydeder.
   */
  saveSeriesFingerprint(seriesKey, episodeNumber, samples, sampleRate = 2) {
    if (!seriesKey || !Array.isArray(samples) || samples.length === 0) return false;
    const key = String(seriesKey).toLowerCase().replace(/[^a-z0-9]/gi, '_');

    let list = this.fingerprints.get(key) || [];
    // En fazla 5 bölüm sakla
    list = list.filter((it) => it.episode !== episodeNumber);
    list.unshift({ episode: episodeNumber, samples: samples.slice(0, 500), sampleRate });
    if (list.length > 5) list = list.slice(0, 5);

    this.fingerprints.set(key, list);
    this._saveCache();
    return true;
  }

  /**
   * Mevcut bölümün ses parmak izini önceki bölümlerle karşılaştırır.
   */
  matchSeriesFingerprint(seriesKey, currentSamples, sampleRate = 2) {
    if (!seriesKey || !Array.isArray(currentSamples)) return { matched: false };
    const key = String(seriesKey).toLowerCase().replace(/[^a-z0-9]/gi, '_');
    const list = this.fingerprints.get(key);
    if (!list || list.length === 0) return { matched: false };

    for (const item of list) {
      const match = this.correlateEnergySignatures(currentSamples, item.samples, sampleRate);
      if (match.matched) {
        return {
          matched: true,
          source: 'fingerprint_cross_episode',
          start: match.start,
          end: match.end,
          confidence: match.confidence,
          comparedEpisode: item.episode,
        };
      }
    }

    return { matched: false };
  }

  /**
   * 3 Kademeli Ana Algılama Fonksiyonu (Cascade: AniSkip -> Yerel Parmak İzi -> Heuristic)
   */
  async detectIntro(meta = {}, settings = {}) {
    const defaultIntroSec = (settings && settings.introSkipSeconds) || 85;
    const isSmartEnabled = settings.smartIntroDetection !== false;

    // Ayarlardan akıllı algılama kapalıysa doğrudan sezgisel yedek dön
    if (!isSmartEnabled) {
      return {
        found: false,
        source: 'heuristic',
        intro: { start: 0, end: defaultIntroSec, duration: defaultIntroSec },
        outro: null,
      };
    }

    const info = this.extractEpisodeInfo(meta);

    // Kademe 1: AniSkip API sorgusu
    if (info.episodeNumber) {
      try {
        const malId = await this.resolveMalId(info.title);
        if (malId) {
          let skipData = await this.fetchAniSkipTimes({
            malId,
            episodeNumber: info.episodeNumber,
            duration: meta.duration,
          });

          // Eğer spesifik bölüm bulunamadıysa serinin 1. bölüm açılışını dene
          if (!skipData && info.episodeNumber > 1) {
            skipData = await this.fetchAniSkipTimes({
              malId,
              episodeNumber: 1,
              duration: meta.duration,
            });
          }

          if (skipData && skipData.intro) {
            return {
              found: true,
              source: 'aniskip',
              title: info.title,
              episode: info.episodeNumber,
              intro: skipData.intro,
              outro: skipData.outro,
            };
          }
        }
      } catch (_) {}
    }

    // Kademe 2: Yerel Parmak İzi (Bölümler Arası veya Akustik Enerji Analizi)
    if (meta.energySamples && Array.isArray(meta.energySamples)) {
      const crossMatch = this.matchSeriesFingerprint(info.title, meta.energySamples, meta.sampleRate || 2);
      if (crossMatch.matched) {
        return {
          found: true,
          source: 'fingerprint',
          method: 'cross_episode',
          title: info.title,
          intro: { start: crossMatch.start, end: crossMatch.end, duration: crossMatch.end - crossMatch.start },
          outro: null,
          confidence: crossMatch.confidence,
        };
      }

      // Tek bölüm akustik enerji platosu
      const energyMatch = this.detectIntroFromEnergy(meta.energySamples, meta.sampleRate || 2);
      if (energyMatch.matched) {
        return {
          found: true,
          source: 'fingerprint',
          method: 'energy_plateau',
          title: info.title,
          intro: { start: energyMatch.start, end: energyMatch.end, duration: energyMatch.end - energyMatch.start },
          outro: null,
          confidence: energyMatch.confidence,
        };
      }
    }

    // Kademe 3: Sezgisel Yedek (Heuristic)
    return {
      found: false,
      source: 'heuristic',
      title: info.title,
      intro: { start: 0, end: defaultIntroSec, duration: defaultIntroSec },
      outro: null,
    };
  }
}

module.exports = {
  IntroDetector,
};
