import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import SafeFetcher

TOKEN = "test-admin-token"

HOSTS = {
    "cdn.example.com": "93.184.216.34",
    "page.example.com": "93.184.216.35",
    "other.example.net": "93.184.216.36",
    "evil.example.org": "10.0.0.5",
    "metadata.example.org": "169.254.169.254",
    "loop.example.org": "127.0.0.1",
    "localhost": "127.0.0.1",
}


async def fake_resolver(host, port):
    if host not in HOSTS:
        import socket
        raise socket.gaierror("no such host")
    return [HOSTS[host]]


class Recorder:
    """MockTransport işleyicisi: gelen istekleri kaydeder, yanıtı `routes` belirler."""

    def __init__(self):
        self.requests = []
        self.routes = {}  # (host, path) -> callable(request) -> Response | Response

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        orig_host = request.headers.get("host", "").split(":")[0]
        key = (orig_host, request.url.path)
        route = self.routes.get(key)
        if route is None:
            return httpx.Response(404, text="nope")
        return route(request) if callable(route) else route


@pytest.fixture
def rec():
    return Recorder()


@pytest.fixture
def client(rec):
    fetcher = SafeFetcher(resolver=fake_resolver, transport=httpx.MockTransport(rec))
    app = create_app(admin_token=TOKEN, fetcher=fetcher)
    return TestClient(app, base_url="http://127.0.0.1")


@pytest.fixture
def make_session(client):
    def _make(url, **extra):
        r = client.post("/api/sessions", json={"url": url, **extra}, headers={"X-MK-Token": TOKEN})
        assert r.status_code == 200, r.text
        return r.json()["sid"]
    return _make
