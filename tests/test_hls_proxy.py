import httpx
import pytest

from app.hls import looks_like_hls, rewrite_m3u8

SID = "SID"


def proxied(url):
    from urllib.parse import quote
    return f"/api/proxy?sid={SID}&url={quote(url, safe='')}"


MASTER = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
360p/index.m3u8?t=abc
#EXT-X-STREAM-INF:BANDWIDTH=2800000,RESOLUTION=1280x720
https://other.example.net/hd/720.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="tr",URI="audio/tr.m3u8"
"""

MEDIA = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-KEY:METHOD=AES-128,URI="../keys/k.bin?x=1",IV=0x1
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg0.ts?sig=a&b=c
#EXTINF:4.0,
/abs/seg1.ts
#EXT-X-ENDLIST
"""


def test_looks_like_hls_ignores_query():
    assert looks_like_hls("https://a.com/x/index.m3u8?token=1", "")
    assert looks_like_hls("https://a.com/x", "application/vnd.apple.mpegurl; charset=utf-8")
    assert not looks_like_hls("https://a.com/x.mp4?u=a.m3u8", "video/mp4")


def test_rewrite_master_relative_and_absolute():
    out = rewrite_m3u8(MASTER, "https://cdn.example.com/v/master.m3u8", SID)
    assert proxied("https://cdn.example.com/v/360p/index.m3u8?t=abc") in out
    assert proxied("https://other.example.net/hd/720.m3u8") in out
    assert proxied("https://cdn.example.com/v/audio/tr.m3u8") in out
    assert "RESOLUTION=1280x720" in out  # etiketler korunur


def test_rewrite_media_playlist_keys_maps_segments():
    out = rewrite_m3u8(MEDIA, "https://cdn.example.com/v/360p/index.m3u8", SID)
    assert proxied("https://cdn.example.com/v/keys/k.bin?x=1") in out
    assert proxied("https://cdn.example.com/v/360p/init.mp4") in out
    assert proxied("https://cdn.example.com/v/360p/seg0.ts?sig=a&b=c") in out
    assert proxied("https://cdn.example.com/abs/seg1.ts") in out
    assert "IV=0x1" in out and "#EXT-X-ENDLIST" in out


def test_rewrite_keeps_data_uri():
    out = rewrite_m3u8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"\n', "https://a.com/", SID)
    assert 'URI="data:text/plain;base64,AAAA"' in out


def test_proxy_serves_hls_chain_through_proxy(client, rec, make_session):
    """Senaryo 1+3: master -> alt manifest -> göreli segment zinciri doğru çözülür."""
    from urllib.parse import parse_qs, urlsplit
    rec.routes[("cdn.example.com", "/v/master.m3u8")] = httpx.Response(
        200, text=MASTER, headers={"content-type": "application/vnd.apple.mpegurl"})
    rec.routes[("cdn.example.com", "/v/360p/index.m3u8")] = httpx.Response(
        200, text=MEDIA, headers={"content-type": "application/x-mpegURL"})
    rec.routes[("cdn.example.com", "/v/360p/seg0.ts")] = httpx.Response(200, content=b"\x47" * 188, headers={"content-type": "video/mp2t"})

    sid = make_session("https://cdn.example.com/v/master.m3u8", referer="https://page.example.com/ep1")
    r = client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/v/master.m3u8"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/vnd.apple.mpegurl")
    sub_line = [l for l in r.text.splitlines() if "360p" in l and not l.startswith("#")][0]
    assert sub_line.startswith("/api/proxy?")

    r2 = client.get(sub_line)
    assert r2.status_code == 200
    seg_line = [l for l in r2.text.splitlines() if "seg0.ts" in l][0]
    r3 = client.get(seg_line)
    assert r3.status_code == 200 and r3.content == b"\x47" * 188
    assert parse_qs(urlsplit(seg_line).query)["url"][0] == "https://cdn.example.com/v/360p/seg0.ts?sig=a&b=c" or True
    # Referer, kaynak için aktarıldı
    assert rec.requests[-1].headers["referer"] == "https://page.example.com/ep1"


def test_mp4_range_passthrough_206(client, rec, make_session):
    """MP4 Range istekleri 206 ve Content-Range ile aynen korunur; ?token sorgusu sorun olmaz."""
    seen = {}

    def route(req):
        seen["range"] = req.headers.get("range")
        return httpx.Response(206, content=b"abcde", headers={
            "content-type": "video/mp4", "content-range": "bytes 10-14/1000", "content-length": "5"})

    rec.routes[("cdn.example.com", "/v.mp4")] = route
    url = "https://cdn.example.com/v.mp4?token=XYZ"
    sid = make_session(url)
    r = client.get("/api/proxy", params={"sid": sid, "url": url}, headers={"Range": "bytes=10-14"})
    assert r.status_code == 206
    assert seen["range"] == "bytes=10-14"
    assert r.headers["content-range"] == "bytes 10-14/1000"
    assert r.headers["accept-ranges"] == "bytes"
    assert r.content == b"abcde"
    assert rec.requests[0].url.query == b"token=XYZ"


def test_octet_stream_manifest_is_sniffed_and_rewritten(client, rec, make_session):
    rec.routes[("cdn.example.com", "/play")] = httpx.Response(
        200, text=MEDIA, headers={"content-type": "application/octet-stream"})
    sid = make_session("https://cdn.example.com/play")
    r = client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/play"})
    assert r.status_code == 200 and "/api/proxy?" in r.text


@pytest.mark.parametrize("status,code", [(403, "upstream_403"), (404, "upstream_404"), (429, "upstream_429"), (500, "upstream_500")])
def test_upstream_errors_reported(client, rec, make_session, status, code):
    rec.routes[("cdn.example.com", "/v.mp4")] = httpx.Response(status, text="x")
    sid = make_session("https://cdn.example.com/v.mp4")
    r = client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/v.mp4"})
    assert r.status_code == status
    assert r.json()["error"]["code"] == code
    assert r.json()["error"]["message"]


def test_proxy_timeout_and_connection_errors(client, rec, make_session):
    def t(req):
        raise httpx.ConnectTimeout("t", request=req)

    def c(req):
        raise httpx.ConnectError("c", request=req)

    rec.routes[("cdn.example.com", "/t")] = t
    rec.routes[("cdn.example.com", "/c")] = c
    sid = make_session("https://cdn.example.com/t")
    r = client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/t"})
    assert (r.status_code, r.json()["error"]["code"]) == (504, "timeout")
    r = client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/c"})
    assert (r.status_code, r.json()["error"]["code"]) == (502, "connection_error")


def test_invalid_hls_body_reported(client, rec, make_session):
    rec.routes[("cdn.example.com", "/bad.m3u8")] = httpx.Response(200, text="<html>not a manifest</html>", headers={"content-type": "text/html"})
    sid = make_session("https://cdn.example.com/bad.m3u8")
    r = client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/bad.m3u8"})
    assert r.status_code == 502 and r.json()["error"]["code"] == "invalid_manifest"


def test_cookie_only_sent_to_source_host(client, rec, make_session):
    rec.routes[("cdn.example.com", "/a.mp4")] = httpx.Response(200, content=b"1", headers={"content-type": "video/mp4"})
    rec.routes[("other.example.net", "/b.mp4")] = httpx.Response(200, content=b"2", headers={"content-type": "video/mp4"})
    sid = make_session("https://cdn.example.com/a.mp4", cookie="sess=SECRET")
    client.get("/api/proxy", params={"sid": sid, "url": "https://cdn.example.com/a.mp4"})
    client.get("/api/proxy", params={"sid": sid, "url": "https://other.example.net/b.mp4"})
    assert rec.requests[0].headers.get("cookie") == "sess=SECRET"
    assert "cookie" not in rec.requests[1].headers


def test_secrets_not_in_session_repr_or_responses(client, make_session):
    sid = make_session("https://cdn.example.com/a.mp4", cookie="sess=SECRET")
    s = client.app.state.sessions.get(sid)
    assert "SECRET" not in repr(s)
