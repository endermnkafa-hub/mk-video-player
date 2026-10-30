import asyncio
import socket

import httpx
import pytest

from app.errors import ApiError
from app.security import SafeFetcher, is_public_ip, parse_http_url, resolve_public

from .conftest import Recorder, fake_resolver


@pytest.mark.parametrize("ip", [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254",
    "0.0.0.0", "100.64.0.1", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1",
    "::ffff:10.0.0.1", "64:ff9b::7f00:1", "not-an-ip",
])
def test_internal_ips_rejected(ip):
    assert not is_public_ip(ip)


@pytest.mark.parametrize("ip", ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])
def test_public_ips_allowed(ip):
    assert is_public_ip(ip)


@pytest.mark.parametrize("url", [
    "ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "http://", "",
    "   ", "http://user:pass@example.com/", "http://exa mple.com/",
])
def test_bad_urls_rejected(url):
    with pytest.raises(ApiError) as e:
        parse_http_url(url)
    assert e.value.status == 400


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("url", [
    "http://127.0.0.1/x", "http://localhost/x", "http://10.1.2.3/x", "http://[::1]/x",
    "http://169.254.169.254/latest/meta-data", "http://2130706433/",  # ondalık 127.0.0.1
    "http://evil.example.org/x",  # DNS -> 10.0.0.5
    "http://loop.example.org/x",
])
def test_fetcher_blocks_internal_targets(url):
    rec = Recorder()

    async def resolver(host, port):
        if host == "localhost":
            return ["127.0.0.1"]
        if host == "2130706433":
            return ["127.0.0.1"]
        return await fake_resolver(host, port)

    f = SafeFetcher(resolver=resolver, transport=httpx.MockTransport(rec))
    with pytest.raises(ApiError) as e:
        run(f.open(url, lambda u: {}))
    assert e.value.code == "blocked_address" and e.value.status == 403
    assert rec.requests == []  # hiçbir istek ağa çıkmadı


def test_redirect_to_internal_is_blocked_each_hop():
    rec = Recorder()
    rec.routes[("page.example.com", "/r")] = httpx.Response(302, headers={"location": "http://metadata.example.org/secret"})
    f = SafeFetcher(resolver=fake_resolver, transport=httpx.MockTransport(rec))
    with pytest.raises(ApiError) as e:
        run(f.open("http://page.example.com/r", lambda u: {}))
    assert e.value.code == "blocked_address"
    assert len(rec.requests) == 1


def test_redirect_loop_limited():
    rec = Recorder()
    rec.routes[("page.example.com", "/loop")] = httpx.Response(302, headers={"location": "/loop"})
    f = SafeFetcher(resolver=fake_resolver, transport=httpx.MockTransport(rec), max_redirects=3)
    with pytest.raises(ApiError) as e:
        run(f.open("http://page.example.com/loop", lambda u: {}))
    assert e.value.code == "too_many_redirects"


def test_connection_is_pinned_to_validated_ip():
    """DNS rebinding: bağlantı doğrulanan IP'ye kurulur, Host/SNI özgün ad olarak kalır."""
    rec = Recorder()
    rec.routes[("cdn.example.com", "/a")] = httpx.Response(200, text="ok")
    calls = []

    async def rebinding_resolver(host, port):
        calls.append(host)
        return ["93.184.216.34"] if len(calls) == 1 else ["127.0.0.1"]

    f = SafeFetcher(resolver=rebinding_resolver, transport=httpx.MockTransport(rec))

    async def go():
        up = await f.open("https://cdn.example.com/a", lambda u: {"X": "1"})
        await up.aclose()

    run(go())
    req = rec.requests[0]
    assert req.url.host == "93.184.216.34"
    assert req.headers["host"] == "cdn.example.com"
    assert req.extensions["sni_hostname"] == "cdn.example.com"
    assert len(calls) == 1  # ikinci çözümleme hiç yapılmadı


def test_dns_failure_reported():
    f = SafeFetcher(resolver=fake_resolver, transport=httpx.MockTransport(Recorder()))
    with pytest.raises(ApiError) as e:
        run(f.open("http://yok.example.invalid/", lambda u: {}))
    assert e.value.code == "dns_error"


def test_resolve_public_rejects_mixed_results():
    async def mixed(host, port):
        return ["93.184.216.34", "10.0.0.1"]
    with pytest.raises(ApiError):
        run(resolve_public("x.example.com", 80, mixed))


def test_timeout_and_connect_error_mapping():
    def boom_timeout(req):
        raise httpx.ReadTimeout("t", request=req)

    def boom_conn(req):
        raise httpx.ConnectError("c", request=req)

    for handler, code, status in ((boom_timeout, "timeout", 504), (boom_conn, "connection_error", 502)):
        f = SafeFetcher(resolver=fake_resolver, transport=httpx.MockTransport(handler))
        with pytest.raises(ApiError) as e:
            run(f.open("http://cdn.example.com/x", lambda u: {}))
        assert (e.value.code, e.value.status) == (code, status)
