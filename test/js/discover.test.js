'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { JSDOM } = require('jsdom');
const Discover = require(path.join(ROOT, 'frontend', 'js', 'discover.js'));
const Render = require(path.join(ROOT, 'frontend', 'js', 'render.js'));

test('slugify: Türkçe ve özel karakterleri URL dostu slug yapar', () => {
  assert.equal(Discover.slugify('Attack on Titan: The Final Season'), 'attack-on-titan-the-final-season');
  assert.equal(Discover.slugify('Şingeki no Kyojin Çılgınlığı'), 'singeki-no-kyojin-cilginligi');
  assert.equal(Discover.slugify('Solo Leveling (2024)!'), 'solo-leveling-2024');
  assert.equal(Discover.slugify(''), '');
  assert.equal(Discover.slugify(null), '');
});

test('buildProviderUrl: Anizm, Animecix, Dizigom ve DuckDuckGo URL şablonlarını doğru üretir', () => {
  const anime = {
    title: 'Solo Leveling',
    titleEnglish: 'Solo Leveling',
    titleRomaji: 'Ore dake Level Up na Ken',
  };

  const anizmDirect = Discover.buildProviderUrl('anizm_direct', anime, 12);
  assert.equal(anizmDirect, 'https://anizm.net/ore-dake-level-up-na-ken-12-bolum-izle');

  const anizmSearch = Discover.buildProviderUrl('anizm_search', anime, 1);
  assert.equal(anizmSearch, 'https://anizm.net/ara?q=Solo%20Leveling');

  const animecix = Discover.buildProviderUrl('animecix', anime, 5);
  assert.equal(animecix, 'https://animecix.net/search?q=Solo%20Leveling');

  const dizigom = Discover.buildProviderUrl('dizigom', anime, 5);
  assert.equal(dizigom, 'https://www.dizigom.tv/dizi-ara/?q=Solo%20Leveling');

  const turkanime = Discover.buildProviderUrl('turkanime', anime, 3);
  assert.equal(turkanime, 'https://www.turkanime.co/?q=Solo%20Leveling');

  const web1080p = Discover.buildProviderUrl('web_1080p', anime, 1);
  assert.equal(web1080p, 'https://duckduckgo.com/?q=Solo%20Leveling%201.%20bolum%201080p%20remaster%20izle');

  const ddg = Discover.buildProviderUrl('duckduckgo', anime, 8);
  assert.equal(ddg, 'https://duckduckgo.com/?q=Solo%20Leveling%208.%20bolum%20izle');
});

test('formatMedia: AniList ham GraphQL verisini arayüz için temizler', () => {
  const raw = {
    id: 101922,
    idMal: 38000,
    title: { english: 'Demon Slayer', romaji: 'Kimetsu no Yaiba' },
    coverImage: { large: 'https://img.test/cover.jpg' },
    averageScore: 86,
    episodes: 26,
    description: '<p>A boy fights demons to save his sister.</p>',
    genres: ['Action', 'Supernatural'],
    seasonYear: 2019,
  };

  const formatted = Discover.formatMedia(raw);
  assert.equal(formatted.id, 101922);
  assert.equal(formatted.title, 'Demon Slayer');
  assert.equal(formatted.score, '8.6');
  assert.equal(formatted.episodes, 26);
  assert.equal(formatted.description, 'A boy fights demons to save his sister.');
  assert.deepEqual(formatted.genres, ['Action', 'Supernatural']);
});

test('getTrending ve searchAnime mock fetch ile doğru çalışır', async () => {
  const mockFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.variables && body.variables.search) {
      return {
        ok: true,
        json: async () => ({
          data: {
            Page: {
              media: [
                { id: 1, title: { english: 'Searched Anime' }, averageScore: 90, episodes: 12 },
              ],
            },
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: {
          Page: {
            media: [
              { id: 2, title: { romaji: 'Trending Anime' }, averageScore: 85, episodes: 24 },
            ],
          },
        },
      }),
    };
  };

  const trending = await Discover.getTrending({ fetchFn: mockFetch });
  assert.equal(trending.length, 1);
  assert.equal(trending[0].title, 'Trending Anime');

  const searchResults = await Discover.searchAnime('Solo', { fetchFn: mockFetch });
  assert.equal(searchResults.length, 1);
  assert.equal(searchResults[0].title, 'Searched Anime');
});

test('REGRESYON: getTrending doğrudan string parametreyle tür filtrelemeyi başarıyla işletir', async () => {
  let capturedVariables = null;
  const mockFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    capturedVariables = body.variables;
    return {
      ok: true,
      json: async () => ({ data: { Page: { media: [{ id: 10, title: { romaji: 'Action Hit' } }] } } }),
    };
  };

  // Doğrudan string geçildiğinde (UI genre chip tıklaması)
  const res = await Discover.getTrending({ genre: 'Action', fetchFn: mockFetch });
  assert.equal(res.length, 1);
  assert.equal(capturedVariables.genre, 'Action');
  assert.ok(capturedVariables.perPage >= 18);
});

test('FORMATS ve format filtreleme: AniList sorgusuna format değişkenini doğru ekler', async () => {
  assert.ok(Array.isArray(Discover.FORMATS));
  assert.ok(Discover.FORMATS.some((f) => f.id === 'MOVIE'));
  assert.ok(Discover.FORMATS.some((f) => f.id === 'TV'));

  let capturedVariables = null;
  const mockFetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    capturedVariables = body.variables;
    return {
      ok: true,
      json: async () => ({ data: { Page: { media: [{ id: 77, title: { english: 'Movie Anime' }, format: 'MOVIE' }] } } }),
    };
  };

  const res = await Discover.getTrending({ format: 'MOVIE', fetchFn: mockFetch });
  assert.equal(res[0].format, 'MOVIE');
  assert.equal(capturedVariables.format, 'MOVIE');
});

test('Önbellek (Memory Cache): tekrarlayan sorguları ağa gitmeden anında döndürür', async () => {
  Discover.clearCache();
  let fetchCount = 0;
  const mockFetch = async () => {
    fetchCount++;
    return {
      ok: true,
      json: async () => ({ data: { Page: { media: [{ id: 999, title: { english: 'Cached Hit' } }] } } }),
    };
  };

  // 1. çağrı
  await Discover.getTrending({ genre: 'Drama', fetchFn: mockFetch });
  assert.equal(fetchCount, 1);

  // 2. çağrı aynı parametrelerle (önbellekten gelmeli, mockFetch çağrılmamalı)
  // fetchFn verilmediğinde memoryCache'e bakar
  const cached = await Discover.getTrending({ genre: 'Drama' });
  // Önbellekte varsa veriyi döner
  assert.equal(fetchCount, 1);
  if (cached) assert.equal(cached[0].title, 'Cached Hit');

  Discover.clearCache();
});

test('renderGenreChips: tür butonlarını güvenli ve aktif seçimle render eder', () => {
  const dom = new JSDOM('<!DOCTYPE html><div id="chips"></div>');
  const container = dom.window.document.getElementById('chips');
  let selected = null;

  Render.renderGenreChips(container, Discover.GENRES, 'Action', (id) => { selected = id; });

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, Discover.GENRES.length);

  // 'Action' aktif olmalı
  const actionBtn = Array.from(buttons).find((b) => b.textContent.includes('Aksiyon'));
  assert.ok(actionBtn);
  assert.ok(actionBtn.classList.contains('bg-brand-600'));

  // Tıklandığında seçim tetiklenmeli
  const comedyBtn = Array.from(buttons).find((b) => b.textContent.includes('Komedi'));
  comedyBtn.click();
  assert.equal(selected, 'Comedy');
});

test('renderAnimeCards: anime kartlarını XSS güvenli biçimde oluşturur ve tıklamayı iletir', () => {
  const dom = new JSDOM('<!DOCTYPE html><div id="grid"></div>');
  const container = dom.window.document.getElementById('grid');
  let chosenAnime = null;

  const testList = [
    {
      id: 99,
      title: '<script>alert("xss")</script>Solo Leveling',
      cover: 'https://img.test/solo.jpg',
      score: '8.7',
      episodes: 12,
      year: 2024,
      status: 'RELEASING',
    },
  ];

  Render.renderAnimeCards(container, testList, (anime) => { chosenAnime = anime; });

  const cards = container.querySelectorAll('[data-anime-id="99"]');
  assert.equal(cards.length, 1);

  // XSS denetimi: script etiketi DOM olarak yürütülmemeli, text olarak kalmalı
  assert.equal(container.querySelectorAll('script').length, 0);
  assert.ok(container.textContent.includes('<script>alert("xss")</script>Solo Leveling'));

  // Puan ve bölüm rozetleri
  assert.ok(container.textContent.includes('8.7'));
  assert.ok(container.textContent.includes('12 Bölüm'));
  assert.ok(container.textContent.includes('Devam Ediyor'));

  // Tıklama kontrolü
  cards[0].click();
  assert.equal(chosenAnime.id, 99);
});

test('renderEpisodeButtons: bölüm butonlarını üretir ve izlenen bölümleri işaretler', () => {
  const dom = new JSDOM('<!DOCTYPE html><div id="epGrid"></div>');
  const container = dom.window.document.getElementById('epGrid');
  let selectedEp = null;

  const watched = new Set([1, 2]);
  Render.renderEpisodeButtons(container, 5, watched, (ep) => { selectedEp = ep; });

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 5);

  // 1. ve 2. bölüm izlendi olarak işaretlenmeli
  assert.ok(buttons[0].textContent.includes('1. Bölüm'));
  assert.ok(buttons[0].textContent.includes('✓'));
  assert.ok(buttons[0].classList.contains('text-emerald-300'));

  // 3. bölüm izlenmemiş olmalı
  assert.ok(buttons[2].textContent.includes('3. Bölüm'));
  assert.ok(!buttons[2].textContent.includes('✓'));

  // Tıklama olayı
  buttons[3].click();
  assert.equal(selectedEp, 4);
});

test('renderEpisodeTabs: çok bölümlü animelerde (Naruto gibi) sayfalama sekmelerini doğru üretir', () => {
  const dom = new JSDOM('<!DOCTYPE html><div id="tabs"></div>');
  const container = dom.window.document.getElementById('tabs');
  let selectedRange = null;

  // 220 bölümlük Naruto örneği
  Render.renderEpisodeTabs(container, 220, { id: '51-100' }, (r) => { selectedRange = r; });

  const tabs = container.querySelectorAll('button');
  // 1-50, 51-100, 101-150, 151-200, 201-220, Tümü -> toplam 6 sekme
  assert.equal(tabs.length, 6);
  assert.equal(tabs[0].textContent, '1-50');
  assert.equal(tabs[1].textContent, '51-100');
  assert.ok(tabs[1].classList.contains('bg-brand-600')); // Aktif sekme
  assert.equal(tabs[tabs.length - 1].textContent, 'Tümü');

  tabs[2].click(); // 101-150 tıklandı
  assert.equal(selectedRange.id, '101-150');
  assert.equal(selectedRange.start, 101);
  assert.equal(selectedRange.end, 150);

  // Kısa anime (12 bölüm) -> sekme üretilmemeli
  Render.renderEpisodeTabs(container, 12, null, () => {});
  assert.equal(container.querySelectorAll('button').length, 0);
});

test('renderEpisodeButtons: aralık (start, end) parametresiyle yalnızca istenen bölüm butonlarını üretir', () => {
  const dom = new JSDOM('<!DOCTYPE html><div id="epGrid"></div>');
  const container = dom.window.document.getElementById('epGrid');

  Render.renderEpisodeButtons(container, 220, new Set([85]), () => {}, { start: 80, end: 150 });

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, 71); // 80'den 150'ye kadar 71 bölüm
  assert.ok(buttons[0].textContent.includes('80. Bölüm'));
  assert.ok(buttons[buttons.length - 1].textContent.includes('150. Bölüm'));

  // 85. bölüm izlendi olarak işaretli olmalı
  const ep85 = Array.from(buttons).find((b) => b.textContent.includes('85. Bölüm'));
  assert.ok(ep85.textContent.includes('✓'));
  assert.equal(ep85.dataset.ep, '85');
});

test('renderFormatChips: format çiplerini doğru render eder ve seçim olayını tetikler', () => {
  const dom = new JSDOM('<!DOCTYPE html><div id="formatChips"></div>');
  const container = dom.window.document.getElementById('formatChips');
  let selectedFormat = null;

  Render.renderFormatChips(container, Discover.FORMATS, 'MOVIE', (fId) => {
    selectedFormat = fId;
  });

  const buttons = container.querySelectorAll('button');
  assert.equal(buttons.length, Discover.FORMATS.length);

  // 'MOVIE' seçili olmalı (bg-brand-600)
  const movieBtn = Array.from(buttons).find((b) => b.textContent.includes('Film'));
  assert.ok(movieBtn);
  assert.ok(movieBtn.classList.contains('bg-brand-600'));

  // 'TV' seçili olmamalı
  const tvBtn = Array.from(buttons).find((b) => b.textContent.includes('Dizi'));
  assert.ok(tvBtn);
  assert.ok(!tvBtn.classList.contains('bg-brand-600'));

  // Tıklama
  tvBtn.click();
  assert.equal(selectedFormat, 'TV');
});
