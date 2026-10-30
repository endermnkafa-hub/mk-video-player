"""MK VideoPlayer arka ucu (FastAPI).

Güvenlik modeli:
- Yalnızca 127.0.0.1/localhost Host başlıkları kabul edilir (DNS-rebinding'e karşı).
- CORS yoktur: arayüz bu sunucudan same-origin servis edilir.
- `/api/proxy` açık proxy değildir: yalnızca ana süreçten (admin token ile) oluşturulmuş,
  tahmin edilemez bir oturum kimliği (`sid`) ile çalışır ve SSRF korumalıdır.
- Çerez/Referer gibi oturum bilgileri yalnızca bellekte tutulur, loglanmaz.
"""
from __future__ import annotations

import os
import re
import secrets
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from fastapi import FastAPI, Header, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .errors import ApiError, upstream_status_error
from .hls import looks_like_hls, might_be_hls, proxy_url, rewrite_m3u8
from .security import SafeFetcher, parse_http_url
from .sessions import SessionStore

# Proje kökü çalışma dizininden bağımsız çözülür.
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
MAX_MANIFEST_BYTES = 5 * 1024 * 1024
MAX_HTML_BYTES = 2 * 1024 * 1024
PASS_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges",
                "last-modified", "etag")

CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: https:; media-src 'self' blob:; connect-src 'self' https://graphql.anilist.co; worker-src blob:; "
    "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)


class SessionRequest(BaseModel):
    url: str
    referer: Optional[str] = None
    origin: Optional[str] = None
    user_agent: Optional[str] = None
    cookie: Optional[str] = None


class InspectRequest(BaseModel):
    url: str


class InspectResponse(BaseModel):
    title: str
    url: str
    streams: List[Dict[str, Any]]
    iframes: List[str]
    nav_links: Dict[str, Optional[str]]
    note: str


def create_app(
    admin_token: Optional[str] = None,
    fetcher: Optional[SafeFetcher] = None,
    allowed_hosts: Optional[List[str]] = None,
) -> FastAPI:
    app = FastAPI(title="MK VideoPlayer", version="2.0.0", docs_url=None, redoc_url=None, openapi_url=None)
    token = admin_token or os.environ.get("MK_ADMIN_TOKEN") or secrets.token_urlsafe(32)
    hosts = {h.strip().lower() for h in (allowed_hosts or os.environ.get("MK_ALLOWED_HOSTS", "127.0.0.1,localhost").split(","))}
    if fetcher is None:
        allow_loopback = os.environ.get("MK_UNSAFE_TEST_ALLOW_LOOPBACK") == "1"
        if allow_loopback:
            print("[UYARI] MK_UNSAFE_TEST_ALLOW_LOOPBACK etkin: yalnızca otomatik testler içindir!", flush=True)
        fetcher = SafeFetcher(allow_loopback=allow_loopback)
    sessions = SessionStore()
    app.state.sessions = sessions
    app.state.fetcher = fetcher

    @app.exception_handler(ApiError)
    async def api_error_handler(_: Request, exc: ApiError):
        return JSONResponse(exc.payload(), status_code=exc.status, headers={"Cache-Control": "no-store"})

    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = (request.headers.get("host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in hosts:
            return JSONResponse(ApiError(403, "bad_host", "Geçersiz Host başlığı.").payload(), status_code=403)
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        return resp

    def require_admin(supplied: Optional[str]) -> None:
        if not supplied or not secrets.compare_digest(supplied, token):
            raise ApiError(403, "forbidden", "Bu uç nokta yalnızca uygulamanın ana süreci içindir.")

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    # ---- Oturumlar ------------------------------------------------------------------
    @app.post("/api/sessions")
    async def create_session(payload: SessionRequest, x_mk_token: Optional[str] = Header(None)):
        require_admin(x_mk_token)
        parse_http_url(payload.url)
        sid = sessions.create(payload.url.strip(), payload.referer, payload.origin, payload.user_agent, payload.cookie)
        return {"sid": sid, "proxy_url": proxy_url(sid, payload.url.strip())}

    @app.delete("/api/sessions/{sid}")
    async def delete_session(sid: str, x_mk_token: Optional[str] = Header(None)):
        require_admin(x_mk_token)
        return {"deleted": sessions.delete(sid)}

    # ---- Statik analiz (yedek yöntem) ----------------------------------------------
    @app.post("/api/inspect", response_model=InspectResponse)
    async def inspect_url(payload: InspectRequest, x_mk_token: Optional[str] = Header(None)):
        """YEDEK: statik HTML analizi. Asıl yöntem gömülü tarayıcıdaki gerçek ağ izlemedir;
        bu uç nokta JS ile üretilen içeriği görmez ve sonuçlar oynatılabilir sayılmaz."""
        require_admin(x_mk_token)
        parse_http_url(payload.url)
        ua = {"User-Agent": DEFAULT_USER_AGENT, "Accept": "text/html,*/*;q=0.8",
              "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.7"}
        up = await fetcher.open(payload.url.strip(), lambda _u: ua)
        try:
            if up.response.status_code >= 400:
                raise upstream_status_error(up.response.status_code)
            body = bytearray()
            try:
                async for chunk in up.response.aiter_bytes():
                    body += chunk
                    if len(body) > MAX_HTML_BYTES:
                        break
            except Exception:
                raise ApiError(502, "connection_error", "Sayfa okunurken bağlantı koptu.")
            final_url = up.url
        finally:
            await up.aclose()
        return _inspect_html(bytes(body).decode("utf-8", errors="ignore"), final_url)

    # ---- Medya proxy ---------------------------------------------------------------
    @app.get("/api/proxy")
    async def proxy_media(request: Request, sid: str = Query(...), url: str = Query(...)):
        sess = sessions.get(sid)
        if sess is None:
            raise ApiError(403, "invalid_session", "Geçersiz veya süresi dolmuş kaynak oturumu.")
        parse_http_url(url)
        client_range = request.headers.get("range")

        def headers_for(u: str) -> Dict[str, str]:
            h = sess.headers_for(u, DEFAULT_USER_AGENT)
            if client_range:
                h["Range"] = client_range
            return h

        up = await fetcher.open(url, headers_for)
        resp = up.response
        status = resp.status_code
        if status >= 400 and status != 416:
            await up.aclose()
            raise upstream_status_error(status)

        ctype = resp.headers.get("content-type", "")
        try:
            if looks_like_hls(up.url, ctype) or (might_be_hls(up.url, ctype) and not client_range):
                return await _serve_maybe_manifest(up, sid, ctype)
        except ApiError:
            await up.aclose()
            raise
        return _stream(up, resp.aiter_bytes(chunk_size=65536))

    async def _serve_maybe_manifest(up, sid: str, ctype: str):
        resp = up.response
        definite = looks_like_hls(up.url, ctype)
        it = resp.aiter_bytes()
        first = b""
        try:
            first = await it.__anext__()
        except StopAsyncIteration:
            pass
        except Exception:
            raise ApiError(502, "connection_error", "Kaynak okunurken bağlantı koptu.")
        probe = first.lstrip(b"\xef\xbb\xbf \r\n\t")
        is_hls = (
            b"#EXTM3U" in probe
            or b"#EXTINF" in probe
            or b"#EXT-X-" in probe
        )
        is_base64 = False
        if not is_hls and len(probe) > 20:
            import base64
            try:
                decoded = base64.b64decode(probe, validate=False)
                if b"#EXTM3U" in decoded or b"#EXTINF" in decoded or b"#EXT-X-" in decoded:
                    is_hls = True
                    is_base64 = True
            except Exception:
                pass

        if not is_hls:
            if definite:
                raise ApiError(502, "invalid_manifest", "Kaynak geçerli bir HLS manifesti değil.")
            return _stream(up, _chain(first, it))
        buf = bytearray(first)
        try:
            async for chunk in it:
                buf += chunk
                if len(buf) > MAX_MANIFEST_BYTES:
                    raise ApiError(502, "manifest_too_large", "HLS manifesti çok büyük.")
        except ApiError:
            raise
        except Exception:
            raise ApiError(502, "connection_error", "Manifest okunurken bağlantı koptu.")
        finally:
            await up.aclose()
        if is_base64:
            import base64
            raw_bytes = base64.b64decode(bytes(buf), validate=False)
            text = raw_bytes.decode("utf-8-sig", errors="replace")
        else:
            text = bytes(buf).decode("utf-8-sig", errors="replace")
        return Response(
            rewrite_m3u8(text, up.url, sid),
            status_code=200,
            media_type="application/vnd.apple.mpegurl",
            headers={"Cache-Control": "no-store"},
        )

    def _stream(up, iterator):
        resp = up.response
        headers = {}
        for name in PASS_HEADERS:
            if name in resp.headers:
                headers[name] = resp.headers[name]
        if "content-encoding" in resp.headers:
            headers.pop("content-length", None)  # gövde httpx tarafından açıldı
        if resp.status_code == 206 and "accept-ranges" not in headers:
            headers["accept-ranges"] = "bytes"
        headers["Cache-Control"] = "no-store"

        async def gen():
            try:
                async for chunk in iterator:
                    yield chunk
            finally:
                await up.aclose()

        return StreamingResponse(gen(), status_code=resp.status_code, headers=headers)

    async def _chain(first: bytes, it):
        if first:
            yield first
        async for chunk in it:
            yield chunk

    # ---- Arayüz --------------------------------------------------------------------
    @app.get("/api/local-media")
    async def serve_local_media(path: str = Query(...)):
        """İndirilen medya dosyalarını yerel oynatıcı için Range (206) desteğiyle sunar."""
        target = Path(path).resolve()
        if not target.exists() or not target.is_file():
            raise ApiError(404, "file_not_found", "İndirilen dosya bulunamadı.")
        if target.suffix.lower() not in (".mp4", ".mkv", ".webm", ".ts", ".m4v", ".mp3", ".aac"):
            raise ApiError(403, "invalid_media_file", "Geçersiz medya dosyası biçimi.")
        return FileResponse(target, headers={"Cache-Control": "no-store", "Accept-Ranges": "bytes"})

    @app.get("/")
    async def root():
        return FileResponse(FRONTEND_DIR / "index.html",
                            headers={"Content-Security-Policy": CSP, "Cache-Control": "no-store"})

    @app.get("/detached.html")
    @app.get("/detached")
    async def detached():
        return FileResponse(FRONTEND_DIR / "detached.html",
                            headers={"Content-Security-Policy": CSP, "Cache-Control": "no-store"})

    app.mount("/assets", StaticFiles(directory=str(FRONTEND_DIR)), name="assets")
    return app


def _inspect_html(html: str, final_url: str) -> InspectResponse:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else "Bilinmeyen Başlık"
    if not title:
        title = "Bilinmeyen Başlık"
    streams: List[Dict[str, Any]] = []
    seen = set()

    def add(src: str, label: str, kind: str):
        if not src:
            return
        abs_src = urljoin(final_url, src.strip())
        if not abs_src.startswith(("http://", "https://")) or abs_src in seen:
            return
        seen.add(abs_src)
        streams.append({"url": abs_src, "label": label, "type": kind, "origin": "static"})

    def kind_of(src: str, mime: str = "") -> str:
        return "hls" if looks_like_hls(src, mime) else "mp4"

    for v in soup.find_all("video"):
        if v.get("src"):
            add(v["src"], "Video etiketi", kind_of(v["src"]))
        for s in v.find_all("source"):
            if s.get("src"):
                add(s["src"], s.get("title") or s.get("label") or "Kaynak", kind_of(s["src"], s.get("type", "")))
    for m in re.findall(r'https?://[^\s"\'<>\\]+?\.m3u8(?:\?[^\s"\'<>\\]*)?', html, re.I):
        add(m, "HLS (sayfa metni)", "hls")
    for m in re.findall(r'https?://[^\s"\'<>\\]+?\.mp4(?:\?[^\s"\'<>\\]*)?', html, re.I):
        add(m, "MP4 (sayfa metni)", "mp4")

    iframes: List[str] = []
    for f in soup.find_all("iframe"):
        src = f.get("src") or f.get("data-src")
        if src:
            a = urljoin(final_url, src.strip())
            if a.startswith(("http://", "https://")) and a not in iframes:
                iframes.append(a)

    prev_link = next_link = None
    for a in soup.find_all("a", href=True):
        combined = f"{a.get_text()} {a.get('title') or ''}".lower()
        href = urljoin(final_url, a["href"].strip())
        if not href.startswith(("http://", "https://")):
            continue
        if not prev_link and any(k in combined for k in ("önceki", "onceki", "previous", "prev")):
            prev_link = href
        if not next_link and any(k in combined for k in ("sonraki", "next")):
            next_link = href

    return InspectResponse(
        title=title, url=final_url, streams=streams, iframes=iframes,
        nav_links={"prev": prev_link, "next": next_link},
        note="Statik analiz: JavaScript ile oluşturulan kaynaklar görülmez, oynatılabilirlik doğrulanmadı.",
    )


app = create_app()
