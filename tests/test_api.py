import httpx
import pytest

H = {"X-MK-Token": "test-admin-token"}


def test_proxy_is_not_open(client):
    """Oturumsuz proxy isteği hiçbir yere gitmez."""
    r = client.get("/api/proxy", params={"url": "https://cdn.example.com/a.mp4"})
    assert r.status_code == 422
    r = client.get("/api/proxy", params={"sid": "uydurma", "url": "https://cdn.example.com/a.mp4"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "invalid_session"


@pytest.mark.parametrize("target", [
    "http://127.0.0.1:8000/api/health", "http://localhost/", "http://10.0.0.5/admin",
    "http://169.254.169.254/latest/meta-data/", "http://metadata.example.org/", "http://[::1]/",
    "file:///C:/Windows/win.ini", "ftp://cdn.example.com/x",
])
def test_proxy_cannot_reach_internal_network(client, rec, make_session, target):
    """Senaryo 9: proxy dahili adreslere erişemez."""
    sid = make_session("https://cdn.example.com/a.mp4")
    r = client.get("/api/proxy", params={"sid": sid, "url": target})
    assert r.status_code in (400, 403)
    assert rec.requests == []


def test_proxy_blocks_redirect_to_internal(client, rec, make_session):
    rec.routes[("cdn.example.com", "/r.mp4")] = httpx.Response(302, headers={"location": "http://10.0.0.5/secret"})
    sid = make_session("https://cdn.example.com/r.mp4")
    r = client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/r.mp4"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "blocked_address"


def test_session_requires_admin_token(client):
    r = client.post("/api/sessions", json={"url": "https://cdn.example.com/a.mp4"})
    assert r.status_code == 403
    r = client.post("/api/sessions", json={"url": "https://cdn.example.com/a.mp4"}, headers={"X-MK-Token": "yanlis"})
    assert r.status_code == 403
    r = client.post("/api/sessions", json={"url": "https://cdn.example.com/a.mp4"}, headers=H)
    assert r.status_code == 200


def test_empty_and_wrong_media_url_clear_errors(client):
    """Senaryo 4: boş/yanlış URL anlaşılır hata verir."""
    r = client.post("/api/sessions", json={"url": ""}, headers=H)
    assert r.status_code == 400 and r.json()["error"]["code"] == "empty_url"
    r = client.post("/api/sessions", json={"url": "javascript:alert(1)"}, headers=H)
    assert r.status_code == 400 and r.json()["error"]["code"] == "unsupported_scheme"
    r = client.post("/api/sessions", json={"url": "xyz"}, headers=H)
    assert r.status_code == 400


def test_bad_host_header_rejected(client):
    """DNS rebinding: yerel API yalnızca 127.0.0.1/localhost Host'unu kabul eder."""
    r = client.get("/api/health", headers={"Host": "evil.example.com"})
    assert r.status_code == 403 and r.json()["error"]["code"] == "bad_host"
    assert client.get("/api/health").status_code == 200


def test_no_cors_headers(client):
    r = client.get("/api/health", headers={"Origin": "https://evil.example.com"})
    assert "access-control-allow-origin" not in r.headers
    r = client.options("/api/proxy", headers={"Origin": "https://evil.example.com", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in r.headers


def test_index_served_independent_of_cwd_with_csp(client, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    r = client.get("/")
    assert r.status_code == 200 and "script-src 'self'" in r.headers["content-security-policy"]


# ---- /api/inspect -----------------------------------------------------------------
PAGE = """<html><head><title>Bölüm 27</title></head><body>
<video><source src="/v/ep.mp4?token=abc" type="video/mp4"></video>
<script>var u = "https://cdn.example.com/hls/index.m3u8?e=1";</script>
<iframe src="//other.example.net/embed/1"></iframe>
<a href="/ep26" title="Önceki Bölüm">geri</a><a href="/ep28">Sonraki</a>
</body></html>"""


def test_inspect_requires_admin(client):
    assert client.post("/api/inspect", json={"url": "https://page.example.com/"}).status_code == 403


def test_inspect_static_fallback_parses_with_query_params(client, rec):
    """Senaryo 2: ?token=... MP4 tanımayı bozmaz."""
    rec.routes[("page.example.com", "/ep27")] = httpx.Response(200, text=PAGE, headers={"content-type": "text/html"})
    r = client.post("/api/inspect", json={"url": "https://page.example.com/ep27"}, headers=H)
    assert r.status_code == 200
    d = r.json()
    kinds = {s["url"]: s["type"] for s in d["streams"]}
    assert kinds["https://page.example.com/v/ep.mp4?token=abc"] == "mp4"
    assert kinds["https://cdn.example.com/hls/index.m3u8?e=1"] == "hls"
    assert d["iframes"] == ["https://other.example.net/embed/1"]
    assert d["nav_links"] == {"prev": "https://page.example.com/ep26", "next": "https://page.example.com/ep28"}
    assert "Statik" in d["note"]


@pytest.mark.parametrize("status,code", [(403, "upstream_403"), (404, "upstream_404"), (429, "upstream_429")])
def test_inspect_reports_http_errors(client, rec, status, code):
    rec.routes[("page.example.com", "/x")] = httpx.Response(status, text="no")
    r = client.post("/api/inspect", json={"url": "https://page.example.com/x"}, headers=H)
    assert r.status_code == status and r.json()["error"]["code"] == code


def test_inspect_timeout_dns_connection_redirect(client, rec):
    def t(req):
        raise httpx.ReadTimeout("t", request=req)

    def c(req):
        raise httpx.ConnectError("c", request=req)

    rec.routes[("page.example.com", "/t")] = t
    rec.routes[("page.example.com", "/c")] = c
    rec.routes[("page.example.com", "/loop")] = httpx.Response(302, headers={"location": "/loop"})
    get = lambda u: client.post("/api/inspect", json={"url": u}, headers=H)
    assert get("https://page.example.com/t").json()["error"]["code"] == "timeout"
    assert get("https://page.example.com/c").json()["error"]["code"] == "connection_error"
    assert get("https://yok.example.invalid/").json()["error"]["code"] == "dns_error"
    assert get("https://page.example.com/loop").json()["error"]["code"] == "too_many_redirects"
    assert get("http://127.0.0.1/").json()["error"]["code"] == "blocked_address"
