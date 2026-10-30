/* Kullanıcıya gösterilen hata/durum metinleri (UMD). Uzak sayfadan gelen hiçbir metin burada
 * HTML olarak yorumlanmaz; çağıranlar textContent kullanır. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MKMessages = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MESSAGES = {
    // Arka uç / proxy
    empty_url: 'Bağlantı boş. Lütfen bir adres girin.',
    invalid_url: 'Bağlantı geçersiz.',
    unsupported_scheme: 'Yalnızca http ve https adresleri desteklenir.',
    blocked_address: 'Bu adres dahili ağa çözümleniyor; güvenlik nedeniyle engellendi.',
    dns_error: 'Alan adı çözümlenemedi (DNS hatası). Adresi ve internet bağlantınızı kontrol edin.',
    timeout: 'Sunucu zamanında yanıt vermedi (zaman aşımı).',
    connection_error: 'Sunucuya bağlanılamadı. Bağlantı reddedildi veya koptu.',
    too_many_redirects: 'Çok fazla yönlendirme algılandı.',
    invalid_session: 'Kaynak oturumunun süresi dolmuş. Kaynağı sayfadan yeniden seçin.',
    invalid_manifest: 'Kaynak geçerli bir HLS manifesti değil.',
    manifest_too_large: 'HLS manifesti beklenenden çok büyük.',
    upstream_401: 'Kaynak kimlik doğrulaması istiyor (401).',
    upstream_403: 'Kaynak sunucu erişimi reddetti (403). Oturum süresi dolmuş veya kaynak korumalı olabilir.',
    upstream_404: 'Kaynak bulunamadı (404). Bağlantının süresi dolmuş olabilir.',
    upstream_410: 'Kaynak artık mevcut değil (410).',
    upstream_429: 'Sunucu çok fazla istek nedeniyle sınırladı (429). Biraz bekleyip tekrar deneyin.',
    upstream_500: 'Kaynak sunucu hata verdi (5xx).',
    // Gömülü tarayıcı
    http_403: 'Sayfa erişimi reddetti (403).',
    http_404: 'Sayfa bulunamadı (404).',
    http_429: 'Site çok fazla istek nedeniyle sınırladı (429).',
    http_5xx: 'Site sunucusu hata verdi (5xx).',
    cert_error: 'Sitenin güvenlik sertifikası geçersiz.',
    offline: 'İnternet bağlantısı yok.',
    blocked: 'İstek engellendi.',
    load_failed: 'Sayfa yüklenemedi.',
    // Kaynak durumları
    dash_unsupported: 'DASH (.mpd) yayınları bu sürümde desteklenmiyor.',
    drm_protected: 'Kaynak DRM/şifreleme korumalı; MK VideoPlayer korumayı aşmaz, bu yüzden oynatılamaz.',
    network_error: 'Kaynağa erişilirken ağ hatası oluştu.',
    // Oynatıcı
    no_source: 'Önce listeden bir kaynak seçin.',
    stale_source: 'Bu kaynak önceki bir sayfaya ait; yeni sayfada seçimi yeniden yapın.',
    hls_unavailable: 'HLS oynatıcı bileşeni yüklenemedi; bu tarayıcıda HLS oynatılamıyor.',
    hls_unsupported: 'Bu çalışma ortamı HLS oynatmayı desteklemiyor.',
    hls_network: 'Yayın verisi alınamadı (ağ hatası). Yeniden denendi ancak sonuç alınamadı.',
    hls_media: 'Video verisi çözülemedi (medya hatası). Biçim desteklenmiyor olabilir.',
    hls_manifest: 'HLS manifesti yüklenemedi veya çözümlenemedi.',
    hls_key: 'Şifre anahtarı alınamadı; kaynak erişim koruması içeriyor olabilir.',
    media_not_supported: 'Tarayıcı bu video biçimini oynatamıyor.',
    media_network: 'Video indirilirken ağ hatası oluştu.',
    media_decode: 'Video çözülemedi (bozuk veya desteklenmeyen kodek).',
    media_aborted: 'Video yüklemesi iptal edildi.',
    playback_failed: 'Oynatma başarısız oldu.',
  };

  const NET_ERRORS = [
    [/NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED/, 'dns_error'],
    [/TIMED_OUT|TIMEOUT/, 'timeout'],
    [/CONNECTION_(REFUSED|RESET|CLOSED|FAILED)|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|ADDRESS_UNREACHABLE/, 'connection_error'],
    [/CERT_|SSL_|BAD_SSL/, 'cert_error'],
    [/TOO_MANY_REDIRECTS/, 'too_many_redirects'],
    [/INTERNET_DISCONNECTED|NETWORK_CHANGED/, 'offline'],
    [/BLOCKED_BY_CLIENT|BLOCKED_BY/, 'blocked'],
  ];

  /** Chromium `ERR_*` açıklamasını iç hata koduna çevirir. */
  function netErrorCode(description) {
    const d = String(description || '');
    for (const [re, code] of NET_ERRORS) if (re.test(d)) return code;
    return 'load_failed';
  }

  function httpErrorCode(status) {
    if (status >= 500) return 'http_5xx';
    return `http_${status}`;
  }

  function describe(code, fallback) {
    if (MESSAGES[code]) return MESSAGES[code];
    const m = /^(?:upstream|http)_(\d{3})$/.exec(String(code || ''));
    if (m) return Number(m[1]) >= 500 ? MESSAGES.upstream_500 : `Sunucu ${m[1]} durumu döndürdü.`;
    return fallback || 'Beklenmeyen bir hata oluştu.';
  }

  return { MESSAGES, describe, netErrorCode, httpErrorCode };
});
