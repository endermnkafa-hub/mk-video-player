# 🎬 MK VideoPlayer (v2.0.0)

Kullanıcının anime bölüm sayfalarını açabildiği, sayfa içindeki video oynatıcı ve çeviri seçenekleriyle normal bir tarayıcı gibi etkileşime girebildiği, seçilen kaynağın gerçek medya isteklerini anlık algılayarak kendi özel oynatıcısında (HLS.js / HTML5) reklamsız ve tam kontrollü oynatabildiği modern masaüstü uygulaması.

---

## 🌟 Kullanıcı Akışı

1. Uygulamayı başlatın (`npm start` veya `python run.py`).
2. Adres çubuğuna bir anime bölüm sayfası yapıştırın (örn. `https://anizm.net/dragon-ball-27-bolum-izle`).
3. Bölüm sayfası sol taraftaki gömülü Chromium tarayıcısında tam JavaScript, iframe ve etkileşim desteğiyle açılır.
4. "Kaynak algılamayı başlat" butonu etkindir. Sayfa arayüzünden dilediğiniz çeviriyi veya video kaynağını (player) seçin.
5. Uygulama, seçiminizden sonra başlayan gerçek ağ isteklerini (HLS master manifestleri, MP4 video akışları) yakalar ve sağdaki listeye ekler.
6. Listelenen kaynaklardan dilediğinizi seçip **Oynat** butonuna basın.
7. Yayın MK VideoPlayer'ın özel oynatıcı alanında başlar:
   - Kalite seçimi (HLS ABR / Manuel 1080p, 720p, 480p sabitleme)
   - 0.25x – 2.0x akıcı oynatma hızı
   - Görüntü boyutlandırma (Sığdır, Doldur, Esnet)
   - Kaldığı yerden devam etme (Resume Playback)
   - Klavye kısayolları ve tam ekran

---

## 🏗️ Mimari Tasarım

```
┌────────────────────────────────────────────────────────────────────────┐
│                        MK VideoPlayer Masaüstü                        │
│                                                                        │
│   Üst Panel: Adres Çubuğu · Gezinme · Algılama Aç/Kapa · Yerleşim      │
├──────────────────────────────────┬─────────────────────────────────────┤
│   Sol: Gömülü Chromium Tarayıcı │   Sağ: MK VideoPlayer Özel Oynatıcı │
│   (WebContentsView)              │                                     │
│   • Tam JS, iframe, DOM desteği │   • HLS.js + HTML5 Native Video     │
│   • İzole bellek içi oturum     │   • Çözünürlük/Kalite Menüsü        │
│   • Reklam pop-up engelleme     │   • Hız, Boyut, Kaldığı Yer         │
│   • Ağ İstekleri Analizi        │                                     │
│     (HLS/MP4 algılama, filtre)  │   Algılanan Kaynaklar Listesi       │
│                                  │   [HLS] cdn.site.com 1080p [Oynat]  │
│                                  │   [MP4] cdn.site.com ~720p [Oynat]  │
└──────────────────────────────────┴─────────────────────────────────────┘
                               ▲
                               │ Local Session Proxy (SSRF Korumalı)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Python FastAPI Güvenli Medya Proxy Arka Ucu               │
│   • Dinamik yerel port, rastgele admin token                           │
│   • SSRF koruması + IP sabitleme (DNS Rebinding önleme)                │
│   • Yetkisiz / açık proxy engeli (Yalnızca üretilmiş sid ile erişim)   │
│   • HLS Playlist Rewrite (Mutlak, göreli, anahtar, alt manifestler)    │
│   • HTTP 206 Partial Content (MP4 Range akışları)                      │
│   • Sıfır disk sızıntısı: Oturum başlıkları/çerezler loglanmaz         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 🔒 Güvenlik Modeli

- **SSRF & DNS Rebinding Koruması:** Dahili ağ adresleri (127.0.0.1, RFC 1918 özel ağlar, link-local, AWS/GCP metadata) çözümlenir ve giden tüm isteklerde reddedilir. IP sabitleme (IP pinning) ile doğrulanan IP dışındaki adreslere bağlantı engellenir.
- **Açık Proxy Koruması:** `/api/proxy` rastgele genel isteklere kapalıdır. Yalnızca ana süreçten admin token ile oluşturulmuş tek kullanımlık oturum kimliği (`sid`) ile çalışır.
- **İzole Web İçeriği:** Gömülü tarayıcı `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true` ile çalışır. Web sitelerinden gelen veriler asla `innerHTML` ile yazdırılmaz (`textContent` ve güvenli DOM kullanılır).
- **Hassas Veri Gizliliği:** Çerezler ve oturum bilgileri loglara yazılmaz, arayüze sızdırılmaz ve diske kaydedilmez.
- **Korumalı İçerik ve DRM Bildirimi:** DRM / erişim korumalı yayınlar tespit edildiğinde kullanıcıya açıkça uyumsuzluk bildirilir.

---

## 🛠️ Kurulum ve Çalıştırma

### 1. Gereksinimler
- **Node.js**: v18 veya üzeri (npm ile birlikte)
- **Python**: 3.10 veya üzeri (veya Windows `py` launcher)
- *(İsteğe bağlı)* **FFmpeg**: Yerel fixture test videoları üretmek için

### 2. Bağımlılıkların Yüklenmesi

```bash
# Python sanal ortamı ve paketleri
py -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt

# Node.js bağımlılıkları ve derleme (Tailwind CSS + HLS.js kopyalama)
npm install
npm run build:css
```

### 3. Uygulamayı Başlatma

```bash
# Masaüstü uygulamasını başlatır (Electron + FastAPI otomatik başlar)
npm start

# veya Python betiği ile:
python run.py
```

*(Yalnızca arka uç API'sini ayrı test etmek isterseniz: `python run.py --backend-only`)*

---

## 🧪 Testler

Proje üç katmanlı kapsamlı otomatik test paketine sahiptir ve üçüncü taraf harici servislere bağımlı olmadan yerel mock/fixture sunucuları ile çalışır:

```bash
# 1. Tüm testleri (Birim, Güvenlik, E2E) tek komutla çalıştırır:
npm test

# 2. Yalnızca JavaScript birim testleri (Node Test Runner):
npm run test:js

# 3. Yalnızca Python arka uç ve güvenlik testleri (pytest):
npm run test:py

# 4. Yalnızca Electron uçtan uca (E2E) masaüstü testleri:
npm run test:e2e
```

### Doğrulanan Senaryolar:
1. Normal HLS master manifesti algılanması, çözünürlüklerin ayrıştırılması ve oynatıcıya aktarılması.
2. `?token=...` parametreli MP4 adreslerinin başarıyla tanınması.
3. HLS alt manifestleri, göreli segmentler ve şifreleme anahtarlarının proxy üzerinden çözülmesi.
4. Geçersiz veya boş URL girdilerinde anlaşılır hata mesajları.
5. HTTP 403, 404, 429, zaman aşımı ve DNS hatalarının ayrı ayrı raporlanması.
6. Birden fazla medya isteği olduğunda hiçbirinin rastgele otomatik oynatılmaması, kullanıcıya seçim hakkı verilmesi.
7. JavaScript ile dinamik olarak oluşturulan sayfalardan medya isteklerinin yakalanabilmesi.
8. Yeni bölüme geçildiğinde önceki bölümün kaynaklarının silinmesi ve karışıklıkların önlenmesi.
9. SSRF korumasının loopback, dahili ağ ve DNS rebinding girişimlerini engellemesi.
10. Güvenilmeyen etiket veya URL metinlerinin XSS oluşturmadan güvenli DOM olarak eklenmesi.
11. HLS kalite seçimi, oynat/duraklat, ileri-geri sarma, ses ve hata sonrası otomatik kaldığı yerden kurtarma.
