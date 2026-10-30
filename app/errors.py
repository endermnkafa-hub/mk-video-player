"""Uygulama genelinde kullanılan yapılandırılmış API hataları."""
from __future__ import annotations


class ApiError(Exception):
    """İstemciye `{"error": {"code", "message"}}` olarak dönen hata."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message

    def payload(self) -> dict:
        return {"error": {"code": self.code, "message": self.message}}


def upstream_status_error(status: int) -> ApiError:
    """Kaynak sunucunun verdiği HTTP durumunu anlaşılır bir hataya çevirir."""
    messages = {
        401: "Kaynak kimlik doğrulaması istiyor (401).",
        403: "Kaynak sunucu erişimi reddetti (403). Oturum/Referer bilgisi geçersiz olabilir.",
        404: "Kaynak bulunamadı (404). Bağlantı süresi dolmuş olabilir.",
        410: "Kaynak artık mevcut değil (410).",
        429: "Kaynak sunucu çok fazla istek nedeniyle sınırladı (429). Biraz bekleyin.",
    }
    if status in messages:
        msg = messages[status]
    elif 500 <= status < 600:
        msg = f"Kaynak sunucu hata verdi ({status})."
    else:
        msg = f"Kaynak sunucu beklenmeyen bir durum döndürdü ({status})."
    return ApiError(status, f"upstream_{status}", msg)
