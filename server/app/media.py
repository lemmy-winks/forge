"""Food image intake for the MCP surface. Images land as remote URLs or data:
URIs; both are materialized into `media_blobs` so the PWA never hotlinks the
outside world (offline-first, and recipe sources rot). A URL that can't be
fetched is kept verbatim as a graceful fallback — the row still records where
the picture lives."""

import base64
import binascii
import logging
import re

import httpx
from sqlalchemy.orm import Session

from .models import MediaBlob

log = logging.getLogger("forge.media")

MAX_BYTES = 3 * 1024 * 1024
FETCH_TIMEOUT = 8.0
_DATA_RE = re.compile(r"^data:(image/[a-z0-9.+-]+);base64,(.+)$", re.IGNORECASE | re.DOTALL)


def media_path(blob: MediaBlob) -> str:
    return f"/api/food/media/{blob.id}"


def _store(db: Session, user_id: str | None, mime: str, data: bytes, src_url: str = "") -> MediaBlob:
    blob = MediaBlob(user_id=user_id, mime=mime.lower(), data=data, src_url=src_url)
    db.add(blob)
    db.flush()  # id now assigned; caller commits with the owning row
    return blob


def store_image(db: Session, user_id: str | None, src: str) -> tuple[str, str | None]:
    """Materialize one image reference. Returns (stored_ref, warning).
    stored_ref is a /api/food/media/{id} path on success, or the original URL
    when fetching failed (warning explains why)."""
    src = (src or "").strip()
    if not src:
        return "", "empty image reference"

    m = _DATA_RE.match(src)
    if m:
        try:
            data = base64.b64decode(m.group(2), validate=True)
        except (binascii.Error, ValueError):
            return "", "invalid base64 in data: URI"
        if len(data) > MAX_BYTES:
            return "", f"image over the {MAX_BYTES // (1024 * 1024)} MB cap"
        return media_path(_store(db, user_id, m.group(1), data)), None

    if not src.startswith(("http://", "https://")):
        return "", f"unsupported image reference: {src[:60]}"

    # re-imports of the same page shouldn't duplicate blobs
    existing = (db.query(MediaBlob)
                .filter(MediaBlob.src_url == src, MediaBlob.user_id == user_id).first())
    if existing:
        return media_path(existing), None

    try:
        with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=True,
                          headers={"User-Agent": "Forge/1.0 (self-hosted fitness app)"}) as client:
            resp = client.get(src)
            resp.raise_for_status()
            mime = (resp.headers.get("content-type") or "").split(";")[0].strip()
            if not mime.startswith("image/"):
                return src, f"not an image ({mime or 'no content-type'}) — kept as remote URL"
            if len(resp.content) > MAX_BYTES:
                return src, "image over the size cap — kept as remote URL"
            return media_path(_store(db, user_id, mime, resp.content, src_url=src)), None
    except httpx.HTTPError as e:
        log.info("image fetch failed for %s: %s", src, e)
        return src, f"fetch failed ({type(e).__name__}) — kept as remote URL"


def store_images(db: Session, user_id: str | None, srcs: list[str]) -> tuple[list[str], list[str]]:
    """Materialize a list; drops empty/invalid entries, collects warnings."""
    stored: list[str] = []
    warnings: list[str] = []
    for s in srcs or []:
        ref, warn = store_image(db, user_id, s)
        if ref:
            stored.append(ref)
        if warn:
            warnings.append(warn)
    return stored, warnings
