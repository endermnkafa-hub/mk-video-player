"""Bellekte tutulan, süreli kaynak oturumları. Diske hiçbir şey yazılmaz, loglanmaz."""
from __future__ import annotations

import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Dict, Optional
from urllib.parse import urlsplit

MAX_SESSIONS = 64
TTL_SECONDS = 6 * 3600
MAX_HEADER_LEN = 8192


@dataclass
class SourceSession:
    source_url: str
    referer: Optional[str] = None
    origin: Optional[str] = None
    user_agent: Optional[str] = None
    cookie: Optional[str] = field(default=None, repr=False)  # repr'de görünmez
    cookie_host: Optional[str] = None
    created: float = field(default_factory=time.time)

    def headers_for(self, url: str, default_ua: str) -> Dict[str, str]:
        """Yalnızca gerekli başlıklar; Cookie yalnızca kaynağın kendi host'una gönderilir."""
        h = {"User-Agent": self.user_agent or default_ua, "Accept": "*/*"}
        if self.referer:
            h["Referer"] = self.referer
        if self.origin:
            h["Origin"] = self.origin
        host = (urlsplit(url).hostname or "").lower()
        if self.cookie and self.cookie_host and host == self.cookie_host:
            h["Cookie"] = self.cookie
        return h


def _clean(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    if len(value) > MAX_HEADER_LEN or any(c in value for c in "\r\n\0"):
        return None
    return value


class SessionStore:
    def __init__(self, max_sessions: int = MAX_SESSIONS, ttl: float = TTL_SECONDS, clock=time.time):
        self._items: "OrderedDict[str, SourceSession]" = OrderedDict()
        self.max_sessions = max_sessions
        self.ttl = ttl
        self.clock = clock

    def create(self, source_url: str, referer=None, origin=None, user_agent=None, cookie=None) -> str:
        self._purge()
        sid = secrets.token_urlsafe(24)
        host = (urlsplit(source_url).hostname or "").lower()
        self._items[sid] = SourceSession(
            source_url=source_url, referer=_clean(referer), origin=_clean(origin),
            user_agent=_clean(user_agent), cookie=_clean(cookie), cookie_host=host,
            created=self.clock(),
        )
        while len(self._items) > self.max_sessions:
            self._items.popitem(last=False)
        return sid

    def get(self, sid: str) -> Optional[SourceSession]:
        s = self._items.get(sid)
        if s is None:
            return None
        if self.clock() - s.created > self.ttl:
            del self._items[sid]
            return None
        return s

    def delete(self, sid: str) -> bool:
        return self._items.pop(sid, None) is not None

    def _purge(self) -> None:
        now = self.clock()
        for k in [k for k, v in self._items.items() if now - v.created > self.ttl]:
            del self._items[k]
