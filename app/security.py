"""SSRF / DNS-rebinding korumalı giden istek katmanı.

- Yalnızca http/https, kullanıcı bilgisi (user:pass@) içermeyen URL'ler kabul edilir.
- Hedef host çözümlenir; TÜM sonuçlar genel (public) IP olmalıdır.
- Bağlantı, doğrulanmış IP adresine kurulur (IP pinning); böylece doğrulama ile
  bağlanma arasında DNS yanıtı değişse bile (DNS rebinding) iç ağa gidilemez.
- Her yönlendirme (Location) elle izlenir ve her adım baştan doğrulanır.
"""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import SplitResult, urljoin, urlsplit

import httpx

from .errors import ApiError

_DNS_CACHE: Dict[Tuple[str, int], Tuple[float, List[str]]] = {}
_DNS_CACHE_TTL = 120.0  # 2 dakika DNS önbellek süresi


def clear_dns_cache() -> None:
    _DNS_CACHE.clear()

MAX_URL_LENGTH = 4096
MAX_REDIRECTS = 5

Resolver = Callable[[str, int], Awaitable[List[str]]]
HeadersFor = Callable[[str], Dict[str, str]]

_EXTRA_BLOCKED = [
    ipaddress.ip_network("64:ff9b::/96"),  # NAT64: gömülü IPv4 iç ağ olabilir
    ipaddress.ip_network("2002::/16"),     # 6to4
    ipaddress.ip_network("2001::/32"),     # Teredo
    ipaddress.ip_network("100.64.0.0/10"), # CGNAT
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("198.18.0.0/15"),
]


def is_public_ip(value: str) -> bool:
    """IP adresi yalnızca genel internet adresiyse True döner."""
    try:
        ip = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified or not ip.is_global
    ):
        return False
    return not any(ip in net for net in _EXTRA_BLOCKED if net.version == ip.version)


def parse_http_url(url: str) -> SplitResult:
    """URL'yi doğrular; geçersizse ApiError(400) fırlatır."""
    if not isinstance(url, str) or not url.strip():
        raise ApiError(400, "empty_url", "URL boş olamaz.")
    url = url.strip()
    if len(url) > MAX_URL_LENGTH:
        raise ApiError(400, "invalid_url", "URL çok uzun.")
    if any(ord(c) < 33 or ord(c) == 127 for c in url):
        raise ApiError(400, "invalid_url", "URL geçersiz karakterler içeriyor.")
    try:
        parts = urlsplit(url)
        _ = parts.port  # geçersiz portta ValueError
    except ValueError:
        raise ApiError(400, "invalid_url", "URL ayrıştırılamadı.")
    if parts.scheme not in ("http", "https"):
        raise ApiError(400, "unsupported_scheme", "Yalnızca http ve https adresleri desteklenir.")
    if not parts.hostname:
        raise ApiError(400, "invalid_url", "URL içinde ana bilgisayar adı yok.")
    if parts.username or parts.password:
        raise ApiError(400, "invalid_url", "Kullanıcı bilgisi içeren URL'lere izin verilmez.")
    return parts


async def default_resolver(host: str, port: int) -> List[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return list(dict.fromkeys(i[4][0] for i in infos))


async def resolve_public(host: str, port: int, resolver: Optional[Resolver] = None,
                         allow_loopback: bool = False) -> List[str]:
    """Hostu çözer; her sonuç genel IP değilse reddeder. Doğrulanmış IP listesini döner.
    `allow_loopback` YALNIZCA otomatik testler içindir (MK_UNSAFE_TEST_ALLOW_LOOPBACK)."""
    use_cache = resolver is None
    cache_key = (host, port)
    now = time.monotonic()
    if use_cache and cache_key in _DNS_CACHE:
        exp, cached = _DNS_CACHE[cache_key]
        if now < exp:
            return cached

    try:
        ipaddress.ip_address(host)
        addrs = [host]
    except ValueError:
        try:
            addrs = await (resolver or default_resolver)(host, port)
        except (socket.gaierror, UnicodeError, OSError):
            raise ApiError(502, "dns_error", f"Alan adı çözümlenemedi: {host}")
    if not addrs:
        raise ApiError(502, "dns_error", f"Alan adı çözümlenemedi: {host}")
    for a in addrs:
        if allow_loopback and ipaddress.ip_address(a.split("%", 1)[0]).is_loopback:
            continue
        if not is_public_ip(a):
            raise ApiError(403, "blocked_address",
                           "Bu adres dahili/özel ağa çözümleniyor; güvenlik nedeniyle engellendi.")
    if use_cache:
        _DNS_CACHE[cache_key] = (now + _DNS_CACHE_TTL, addrs)
    return addrs


@dataclass
class Upstream:
    response: httpx.Response
    client: Optional[httpx.AsyncClient]
    url: str  # yönlendirmeler sonrası son URL

    async def aclose(self) -> None:
        try:
            await self.response.aclose()
        finally:
            if self.client is not None:
                await self.client.aclose()


class SafeFetcher:
    def __init__(
        self,
        resolver: Optional[Resolver] = None,
        transport: Optional[httpx.AsyncBaseTransport] = None,
        timeout: Optional[httpx.Timeout] = None,
        max_redirects: int = MAX_REDIRECTS,
        allow_loopback: bool = False,
    ):
        self.resolver = resolver
        self.transport = transport
        self.timeout = timeout or httpx.Timeout(20.0, connect=8.0)
        self.max_redirects = max_redirects
        self.allow_loopback = allow_loopback
        self._shared_client: Optional[httpx.AsyncClient] = None

    def _get_client(self) -> httpx.AsyncClient:
        if self._shared_client is None or self._shared_client.is_closed:
            limits = httpx.Limits(max_keepalive_connections=30, max_connections=60, keepalive_expiry=45.0)
            self._shared_client = httpx.AsyncClient(
                timeout=self.timeout,
                follow_redirects=False,
                trust_env=False,
                transport=self.transport,
                limits=limits,
            )
        return self._shared_client

    async def aclose(self) -> None:
        if self._shared_client is not None and not self._shared_client.is_closed:
            await self._shared_client.aclose()
            self._shared_client = None

    async def open(self, url: str, headers_for: HeadersFor) -> Upstream:
        """GET isteği açar (stream=True). Çağıran Upstream.aclose() çağırmalıdır."""
        current = url
        client = self._get_client()
        for _ in range(self.max_redirects + 1):
            parts = parse_http_url(current)
            host = parts.hostname
            port = parts.port or (443 if parts.scheme == "https" else 80)
            ip = (await resolve_public(host, port, self.resolver, self.allow_loopback))[0]

            ip_host = f"[{ip}]" if ":" in ip else ip
            pinned = parts._replace(netloc=ip_host + (f":{parts.port}" if parts.port else "")).geturl()
            hdrs = dict(headers_for(current))
            hdrs["Host"] = host + (f":{parts.port}" if parts.port else "")

            try:
                req = client.build_request(
                    "GET", pinned, headers=hdrs, extensions={"sni_hostname": host},
                )
                resp = await client.send(req, stream=True)
            except httpx.TimeoutException:
                raise ApiError(504, "timeout", "Kaynak sunucu zaman aşımına uğradı.")
            except httpx.TransportError:
                raise ApiError(502, "connection_error", "Kaynak sunucuya bağlanılamadı.")
            except Exception:
                raise ApiError(502, "connection_error", "Kaynak isteği başarısız oldu.")

            if resp.status_code in (301, 302, 303, 307, 308) and resp.headers.get("location"):
                loc = resp.headers["location"]
                await resp.aclose()
                current = urljoin(current, loc)
                continue
            return Upstream(resp, None, current)
        raise ApiError(502, "too_many_redirects", "Çok fazla yönlendirme.")
