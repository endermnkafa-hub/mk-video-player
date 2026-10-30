/* MK VideoPlayer - Anime Arama ve Keşif Modülü (AniList GraphQL Entegrasyonu)
 * UMD biçiminde: hem tarayıcıda hem testlerde (Node.js) çalışır.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MKDiscover = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ANILIST_API_URL = 'https://graphql.anilist.co';

  const FORMATS = [
    { id: 'all', label: 'Tüm Formatlar' },
    { id: 'TV', label: 'TV Dizileri' },
    { id: 'MOVIE', label: 'Anime Filmleri' },
    { id: 'OVA', label: 'OVA / Özel' },
  ];

  const GENRES = [
    { id: 'all', label: 'Tümü' },
    { id: 'Action', label: 'Aksiyon' },
    { id: 'Adventure', label: 'Macera' },
    { id: 'Comedy', label: 'Komedi' },
    { id: 'Drama', label: 'Dram' },
    { id: 'Fantasy', label: 'Fantastik' },
    { id: 'Mystery', label: 'Gizem' },
    { id: 'Psychological', label: 'Psikolojik' },
    { id: 'Sci-Fi', label: 'Bilim Kurgu' },
    { id: 'Supernatural', label: 'Doğaüstü' },
    { id: 'Romance', label: 'Romantizm' },
    { id: 'Horror', label: 'Korku' },
  ];

  // AniList yanıtları için 5 dakikalık yerel bellek önbelleği (Kota aşımını önler, hızı artırır)
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const memoryCache = new Map();

  function cacheGet(key) {
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > CACHE_TTL_MS) {
      memoryCache.delete(key);
      return null;
    }
    return entry.data;
  }

  function cacheSet(key, data) {
    if (memoryCache.size > 150) {
      const first = memoryCache.keys().next().value;
      memoryCache.delete(first);
    }
    memoryCache.set(key, { data, time: Date.now() });
  }

  function clearCache() {
    memoryCache.clear();
  }

  const PROVIDERS = [
    { id: 'web_1080p', name: '🌟 1080p Remaster Ara (Önerilen)', desc: 'Webde 1080p / Blu-ray Türkçe sürümleri aratır' },
    { id: 'animecix', name: 'Animecix (1080p / HD Arama)', desc: 'Animecix üzerinde aratır' },
    { id: 'turkanime', name: 'TürkAnime (Çoklu Fansub & HD)', desc: 'TürkAnime üzerinde aratır' },
    { id: 'dizigom', name: 'Dizigom (HD Arama)', desc: 'Dizigom üzerinde aratır' },
    { id: 'anizm_direct', name: 'Anizm (Doğrudan Bölüm)', desc: 'Doğrudan bölüm sayfasına gider' },
    { id: 'anizm_search', name: 'Anizm (Arama)', desc: 'Sitede animeyi aratır' },
    { id: 'duckduckgo', name: 'Web Genel Arama', desc: 'Tüm web üzerinde bölümü aratır' },
  ];

  /**
   * Başlığı URL uyumlu slug haline getirir (Türkçe karakterleri ve noktalama işaretlerini dönüştürür).
   */
  function slugify(text) {
    if (!text || typeof text !== 'string') return '';
    const trMap = {
      'ç': 'c', 'Ç': 'c', 'ğ': 'g', 'Ğ': 'g', 'ı': 'i', 'İ': 'i',
      'ö': 'o', 'Ö': 'o', 'ş': 's', 'Ş': 's', 'ü': 'u', 'Ü': 'u',
    };
    let str = text.replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => trMap[c] || c);
    return str
      .toLowerCase()
      .replace(/['":;!?,.&/\\()\[\]{}+*#@^~`|]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .trim();
  }

  /**
   * Seçilen sağlayıcıya ve bölüme göre hedef web URL'sini oluşturur.
   */
  function buildProviderUrl(providerId, anime, episodeNumber = 1) {
    const title = (anime && (anime.titleEnglish || anime.titleRomaji || anime.titleNative || anime.title)) || 'Anime';
    const romajiTitle = (anime && anime.titleRomaji) || title;
    const ep = Math.max(1, parseInt(episodeNumber, 10) || 1);

    const slug = slugify(romajiTitle || title);

    switch (providerId) {
      case 'web_1080p':
        return `https://duckduckgo.com/?q=${encodeURIComponent(`${title} ${ep}. bolum 1080p remaster izle`)}`;
      case 'anizm_direct':
        return `https://anizm.net/${slug}-${ep}-bolum-izle`;
      case 'anizm_search':
        return `https://anizm.net/ara?q=${encodeURIComponent(title)}`;
      case 'animecix':
        return `https://animecix.net/search?q=${encodeURIComponent(title)}`;
      case 'dizigom':
        return `https://www.dizigom.tv/dizi-ara/?q=${encodeURIComponent(title)}`;
      case 'turkanime':
        return `https://www.turkanime.co/?q=${encodeURIComponent(title)}`;
      case 'duckduckgo':
      default:
        return `https://duckduckgo.com/?q=${encodeURIComponent(`${title} ${ep}. bolum izle`)}`;
    }
  }

  /**
   * AniList API çağrısı yapar.
   */
  async function queryAniList(query, variables = {}, fetchFn = null) {
    const doFetch = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!doFetch) throw new Error('fetch API bulunamadı.');

    const res = await doFetch(ANILIST_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(`AniList API yanıtı: HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors[0].message || 'AniList GraphQL hatası.');
    }

    return json.data;
  }

  function formatMedia(m) {
    if (!m) return null;
    const titleEnglish = m.title ? m.title.english : null;
    const titleRomaji = m.title ? m.title.romaji : null;
    const titleNative = m.title ? m.title.native : null;
    const mainTitle = titleEnglish || titleRomaji || titleNative || 'Bilinmeyen Anime';

    return {
      id: m.id,
      idMal: m.idMal || null,
      title: mainTitle,
      titleEnglish,
      titleRomaji,
      titleNative,
      cover: m.coverImage ? (m.coverImage.extraLarge || m.coverImage.large || m.coverImage.medium) : '',
      banner: m.bannerImage || '',
      score: m.averageScore ? (m.averageScore / 10).toFixed(1) : null,
      score100: m.averageScore || null,
      episodes: m.episodes || null,
      status: m.status || 'UNKNOWN',
      year: m.seasonYear || (m.startDate && m.startDate.year) || null,
      genres: m.genres || [],
      description: m.description ? m.description.replace(/<[^>]*>/g, '').trim() : '',
      studios: m.studios && m.studios.nodes ? m.studios.nodes.map((s) => s.name).join(', ') : '',
      format: m.format || 'TV',
    };
  }

  /**
   * Trend / Popüler animeleri çeker.
   * Hem string tür (örn. getTrending('Action')) hem seçenek nesnesi (getTrending({ genre, format })) kabul eder.
   */
  async function getTrending(opts = {}) {
    const options = (typeof opts === 'string') ? { genre: opts } : (opts || {});
    const { page = 1, perPage = 24, genre = null, format = null, fetchFn = null } = options;
    const hasGenre = genre && genre !== 'all';
    const hasFormat = format && format !== 'all';

    const cacheKey = `trending:${page}:${perPage}:${genre || 'all'}:${format || 'all'}`;
    if (!options.skipCache) {
      const cached = cacheGet(cacheKey);
      if (cached) return cached;
    }

    const query = `
      query ($page: Int, $perPage: Int${hasGenre ? ', $genre: String' : ''}${hasFormat ? ', $format: MediaFormat' : ''}) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { total currentPage hasNextPage }
          media(type: ANIME, sort: TRENDING_DESC${hasGenre ? ', genre: $genre' : ''}${hasFormat ? ', format: $format' : ''}) {
            id
            idMal
            title { romaji english native }
            coverImage { extraLarge large medium }
            bannerImage
            averageScore
            episodes
            status
            seasonYear
            genres
            description
            startDate { year }
            format
          }
        }
      }
    `;

    const variables = { page, perPage };
    if (hasGenre) variables.genre = genre;
    if (hasFormat) variables.format = format;

    const data = await queryAniList(query, variables, fetchFn);
    const media = (data && data.Page && data.Page.media) || [];
    const formatted = media.map(formatMedia);
    cacheSet(cacheKey, formatted);
    return formatted;
  }

  /**
   * Anime arar.
   * query string'in yanı sıra isteğe bağlı format filtresi ve sayfalama destekler.
   */
  async function searchAnime(searchQuery, opts = {}) {
    const q = String(searchQuery || '').trim();
    if (!q) return [];

    const options = (typeof opts === 'number') ? { page: opts } : (opts || {});
    const { page = 1, perPage = 24, format = null, fetchFn = null } = options;
    const hasFormat = format && format !== 'all';

    const cacheKey = `search:${q.toLowerCase()}:${page}:${perPage}:${format || 'all'}`;
    if (!options.skipCache) {
      const cached = cacheGet(cacheKey);
      if (cached) return cached;
    }

    const query = `
      query ($search: String, $page: Int, $perPage: Int${hasFormat ? ', $format: MediaFormat' : ''}) {
        Page(page: $page, perPage: $perPage) {
          pageInfo { total currentPage hasNextPage }
          media(search: $search, type: ANIME, sort: SEARCH_MATCH${hasFormat ? ', format: $format' : ''}) {
            id
            idMal
            title { romaji english native }
            coverImage { extraLarge large medium }
            bannerImage
            averageScore
            episodes
            status
            seasonYear
            genres
            description
            startDate { year }
            format
          }
        }
      }
    `;

    const variables = { search: q, page, perPage };
    if (hasFormat) variables.format = format;

    const data = await queryAniList(query, variables, fetchFn);
    const media = (data && data.Page && data.Page.media) || [];
    const formatted = media.map(formatMedia);
    cacheSet(cacheKey, formatted);
    return formatted;
  }

  /**
   * Tekil bir animenin detaylarını çeker.
   */
  async function getAnimeDetails(id, fetchFn = null) {
    const numId = parseInt(id, 10);
    if (!numId) return null;

    const cacheKey = `detail:${numId}`;
    const cached = cacheGet(cacheKey);
    if (cached) return cached;

    const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          id
          idMal
          title { romaji english native }
          coverImage { extraLarge large }
          bannerImage
          averageScore
          episodes
          status
          seasonYear
          genres
          description
          studios(isMain: true) { nodes { name } }
          nextAiringEpisode { episode }
          startDate { year }
          format
        }
      }
    `;

    const data = await queryAniList(query, { id: numId }, fetchFn);
    const formatted = formatMedia(data && data.Media);
    if (formatted) cacheSet(cacheKey, formatted);
    return formatted;
  }

  return {
    GENRES,
    FORMATS,
    PROVIDERS,
    slugify,
    buildProviderUrl,
    getTrending,
    searchAnime,
    getAnimeDetails,
    formatMedia,
    clearCache,
  };
});
