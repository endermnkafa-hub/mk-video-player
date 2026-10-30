"""HLS manifest yardımcıları."""
from __future__ import annotations

import re
from typing import Callable
from urllib.parse import urljoin, urlencode

HLS_CONTENT_TYPES = (
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
    "audio/mpegurl",
    "audio/x-mpegurl",
)

_URI_ATTR = re.compile(r'(URI=)(?:"([^"]*)"|\'([^\']*)\')', re.IGNORECASE)


def proxy_url(sid: str, absolute_url: str) -> str:
    return "/api/proxy?" + urlencode({"sid": sid, "url": absolute_url})


def url_path_lower(url: str) -> str:
    """Sorgu/parça kısmını atarak küçük harfli yol döner."""
    return url.split("#", 1)[0].split("?", 1)[0].lower()


def looks_like_hls(url: str, content_type: str) -> bool:
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    path = url_path_lower(url)
    return ct in HLS_CONTENT_TYPES or path.endswith((".m3u8", ".m3u"))


def might_be_hls(url: str, content_type: str) -> bool:
    """Gövdeye bakmaya değer mi? (video/mp4 gibi kesin türleri koklamayız.)"""
    ct = (content_type or "").split(";", 1)[0].strip().lower()
    if looks_like_hls(url, ct):
        return True
    return ct in ("", "text/plain", "application/octet-stream", "binary/octet-stream")


def rewrite_m3u8(content: str, base_url: str, sid: str,
                 make_url: Callable[[str, str], str] = proxy_url) -> str:
    """Manifestteki tüm URI'leri (satır URI'leri ve etiket URI="..." değerleri) mutlak URL'ye
    çevirip yerel proxy üzerinden geçirir. Göreli yollar, sorgu parametreleri, alt manifestler,
    EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA ve benzeri etiketler desteklenir."""

    def conv(uri: str) -> str:
        uri = uri.strip()
        if not uri or uri.lower().startswith("data:"):
            return uri
        return make_url(sid, urljoin(base_url, uri))

    def tag_sub(m: "re.Match[str]") -> str:
        if m.group(2) is not None:
            return f'{m.group(1)}"{conv(m.group(2))}"'
        return f'{m.group(1)}"{conv(m.group(3))}"'

    out = []
    for line in content.splitlines():
        s = line.strip()
        if not s:
            out.append(line)
        elif s.startswith("#"):
            out.append(_URI_ATTR.sub(tag_sub, line))
        else:
            out.append(conv(s))
    return "\n".join(out) + "\n"
