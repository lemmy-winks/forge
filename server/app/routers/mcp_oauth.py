"""OAuth 2.1 for the external MCP endpoint — lets Claude's connector UI add
Forge by URL (Settings → Connectors → Add custom connector), no config file.

Hand-rolled like /mcp itself and for the same reasons: no SDK dependency and
the whole flow runs in the sqlite smoke suite. The surface is the minimum the
MCP auth spec (2025-06-18) requires a remote server to offer:

  RFC 9728  /.well-known/oauth-protected-resource[/mcp]  → who my auth server is
  RFC 8414  /.well-known/oauth-authorization-server[/mcp] → my endpoints
  RFC 7591  POST /mcp/oauth/register                      → dynamic client reg
            GET/POST /mcp/oauth/authorize                 → consent (app session)
            POST /mcp/oauth/token                         → code/refresh exchange

Public clients only: registration is open (it grants nothing), every token is
minted by a signed-in user approving the consent page, and PKCE S256 is
mandatory — there are no client secrets anywhere. Access tokens (`fgm_`) ride
the same Authorization: Bearer header as ingest tokens; deleting the row in
Settings → Connections is revocation. The ingest-token path stays untouched for
mcp-remote / Health Auto Export style callers."""

import hashlib
import html
import secrets
from base64 import urlsafe_b64encode
from datetime import timedelta
from urllib.parse import parse_qsl, urlencode, urlsplit

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import OAuthClient, OAuthCode, OAuthToken, User, utcnow
from ..security import COOKIE, _serializer, public_base_url

router = APIRouter(tags=["mcp-oauth"])

CODE_TTL = timedelta(minutes=5)
ACCESS_TTL = timedelta(days=7)
REFRESH_TTL = timedelta(days=180)


def _session_user(request: Request, db: Session) -> User | None:
    """current_user without the 401 — the consent page handles signed-out itself."""
    from itsdangerous import BadSignature
    raw = request.cookies.get(COOKIE)
    if not raw:
        return None
    try:
        data = _serializer().loads(raw, max_age=60 * 60 * 24 * 90)
    except BadSignature:
        return None
    return db.get(User, data.get("uid", ""))


def _ok_redirect_uri(uri: str) -> bool:
    p = urlsplit(uri)
    if p.scheme == "https" and p.hostname:
        return True
    # native/dev clients: loopback only, per OAuth 2.1
    return p.scheme == "http" and p.hostname in ("localhost", "127.0.0.1", "::1")


def _aware(dt):
    """sqlite round-trips DateTime(timezone=True) naive; Postgres keeps the tz."""
    from datetime import timezone
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


async def _form(request: Request) -> dict:
    """Hand-parse application/x-www-form-urlencoded — request.form() would pull in
    python-multipart, and this surface stays dependency-free on purpose."""
    return dict(parse_qsl((await request.body()).decode("utf-8", "replace")))


def new_mcp_access_token() -> str:
    return "fgm_" + secrets.token_urlsafe(24)


def new_mcp_refresh_token() -> str:
    return "fgr_" + secrets.token_urlsafe(24)


def user_for_mcp_token(db: Session, token: str) -> User | None:
    """Resolve an OAuth access token to its user (None if unknown/expired)."""
    if not token.startswith("fgm_"):
        return None
    row = db.query(OAuthToken).filter(OAuthToken.access_token == token).first()
    if not row or _aware(row.access_expires_at) < utcnow():
        return None
    row.last_used_at = utcnow()
    db.commit()
    return db.get(User, row.user_id)


# ---------------------------------------------------------------- discovery

def _resource_metadata(request: Request):
    b = public_base_url(request)  # host-derived so every allowed domain self-describes
    return {"resource": b + "/mcp",
            "authorization_servers": [b],
            "bearer_methods_supported": ["header"]}


def _server_metadata(request: Request):
    b = public_base_url(request)
    return {"issuer": b,
            "authorization_endpoint": b + "/mcp/oauth/authorize",
            "token_endpoint": b + "/mcp/oauth/token",
            "registration_endpoint": b + "/mcp/oauth/register",
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "token_endpoint_auth_methods_supported": ["none"]}


# clients probe both the root form and the path-suffixed form (RFC 8414 §3)
@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp")
def protected_resource(request: Request):
    return _resource_metadata(request)


@router.get("/.well-known/oauth-authorization-server")
@router.get("/.well-known/oauth-authorization-server/mcp")
def authorization_server(request: Request):
    return _server_metadata(request)


# ---------------------------------------------------------------- registration

@router.post("/mcp/oauth/register")
async def register(request: Request, db: Session = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid_client_metadata"}, status_code=400)
    uris = body.get("redirect_uris") or []
    if not isinstance(uris, list) or not uris or not all(
            isinstance(u, str) and _ok_redirect_uri(u) for u in uris):
        return JSONResponse({"error": "invalid_redirect_uri",
                             "error_description": "redirect_uris must be https or loopback"},
                            status_code=400)
    client = OAuthClient(name=str(body.get("client_name", ""))[:120], redirect_uris=uris)
    db.add(client)
    db.commit()
    return JSONResponse({"client_id": client.id,
                         "client_name": client.name,
                         "redirect_uris": uris,
                         "token_endpoint_auth_method": "none",
                         "grant_types": ["authorization_code", "refresh_token"],
                         "response_types": ["code"]}, status_code=201)


# ---------------------------------------------------------------- authorize

_HEAD = ('<meta name="viewport" content="width=device-width,initial-scale=1">'
         '<link rel="icon" href="/icon.svg"><title>Forge — connect</title>')
_CONSENT_CSS = """
body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:#060708;
     color:#e7e9ec;display:grid;place-items:center;min-height:100vh}
.card{background:#121316;border-radius:16px;padding:28px;max-width:360px;margin:16px}
h1{font-size:19px;margin:0 0 10px}
p{color:#9aa0a8;margin:8px 0}
b{color:#e7e9ec}
.btns{display:flex;gap:10px;margin-top:20px}
button,a.btn{flex:1;border:0;border-radius:999px;padding:12px 0;font-size:15px;font-weight:650;
     cursor:pointer;text-align:center;text-decoration:none}
.yes{background:#e7e9ec;color:#060708}
.no{background:#1c1e22;color:#9aa0a8}
"""


def _consent_error(msg: str, status: int = 400) -> HTMLResponse:
    return HTMLResponse(f"{_HEAD}<style>{_CONSENT_CSS}</style><div class=card><h1>Can't continue</h1>"
                        f"<p>{html.escape(msg)}</p></div>", status_code=status)


def _validated_authorize_params(request: Request, db: Session):
    """(client, params) or an error response. client_id/redirect_uri failures
    render a page — never redirect a browser to an unverified URI."""
    q = request.query_params
    client = db.get(OAuthClient, q.get("client_id", ""))
    if not client:
        return None, _consent_error("Unknown client — re-add the connector to register it.")
    redirect_uri = q.get("redirect_uri", "")
    if redirect_uri not in (client.redirect_uris or []):
        return None, _consent_error("redirect_uri does not match the registered one.")
    err = None
    if q.get("response_type") != "code":
        err = "unsupported_response_type"
    elif not q.get("code_challenge") or q.get("code_challenge_method", "S256") != "S256":
        err = "invalid_request"  # PKCE S256 is mandatory
    if err:
        sep = "&" if "?" in redirect_uri else "?"
        params = {"error": err}
        if q.get("state"):
            params["state"] = q["state"]
        return None, RedirectResponse(redirect_uri + sep + urlencode(params), status_code=302)
    return client, None


@router.get("/mcp/oauth/authorize")
def authorize_page(request: Request, db: Session = Depends(get_db)):
    client, error = _validated_authorize_params(request, db)
    if error:
        return error
    user = _session_user(request, db)
    if not user:
        if get_settings().google_enabled:
            nxt = request.url.path + "?" + str(request.url.query)
            return RedirectResponse("/auth/login?" + urlencode({"next": nxt}), status_code=302)
        return HTMLResponse(
            f"{_HEAD}<style>{_CONSENT_CSS}</style><div class=card><h1>Sign in first</h1>"
            f"<p>Open <a class=btn style='display:inline' href='/'>Forge</a> in this browser, "
            f"sign in, then come back and refresh this page.</p></div>", status_code=401)
    q = request.query_params
    hidden = "".join(
        f'<input type="hidden" name="{k}" value="{html.escape(q.get(k, ""), quote=True)}">'
        for k in ("client_id", "redirect_uri", "state", "code_challenge"))
    name = html.escape(client.name or "An MCP client")
    return HTMLResponse(
        f"{_HEAD}<style>{_CONSENT_CSS}</style><div class=card>"
        f"<h1>Connect {name}?</h1>"
        f"<p><b>{name}</b> wants to use Forge's food tools as "
        f"<b>{html.escape(user.name)}</b> — log meals, browse and import recipes.</p>"
        f"<p>You can disconnect it any time in Settings → Connections.</p>"
        f"<form method=post class=btns>{hidden}"
        f"<button class=no name=decision value=deny>Deny</button>"
        f"<button class=yes name=decision value=allow>Allow</button></form></div>")


@router.post("/mcp/oauth/authorize")
async def authorize_submit(request: Request, db: Session = Depends(get_db)):
    client, error = _validated_authorize_params(request, db)
    if error:
        return error
    user = _session_user(request, db)
    if not user:
        return _consent_error("Session expired — reload the page and try again.", status=401)
    q = request.query_params
    form = await _form(request)
    redirect_uri = q["redirect_uri"]
    sep = "&" if "?" in redirect_uri else "?"
    if form.get("decision") != "allow":
        params = {"error": "access_denied"}
        if q.get("state"):
            params["state"] = q["state"]
        return RedirectResponse(redirect_uri + sep + urlencode(params), status_code=302)
    db.query(OAuthCode).filter(OAuthCode.expires_at < utcnow()).delete()
    code = OAuthCode(code=secrets.token_urlsafe(32), client_id=client.id, user_id=user.id,
                     redirect_uri=redirect_uri, code_challenge=q["code_challenge"],
                     expires_at=utcnow() + CODE_TTL)
    db.add(code)
    db.commit()
    params = {"code": code.code}
    if q.get("state"):
        params["state"] = q["state"]
    return RedirectResponse(redirect_uri + sep + urlencode(params), status_code=302)


# ---------------------------------------------------------------- token

def _token_error(err: str, desc: str = "") -> JSONResponse:
    body = {"error": err}
    if desc:
        body["error_description"] = desc
    return JSONResponse(body, status_code=400)


def _token_response(row: OAuthToken) -> JSONResponse:
    return JSONResponse({"access_token": row.access_token,
                         "token_type": "Bearer",
                         "expires_in": int(ACCESS_TTL.total_seconds()),
                         "refresh_token": row.refresh_token})


@router.post("/mcp/oauth/token")
async def token(request: Request, db: Session = Depends(get_db)):
    form = await _form(request)
    grant = form.get("grant_type", "")

    if grant == "authorization_code":
        row = db.get(OAuthCode, str(form.get("code", "")))
        if not row or _aware(row.expires_at) < utcnow():
            return _token_error("invalid_grant", "unknown or expired code")
        db.delete(row)  # single use, spent even on failure below
        db.commit()
        if form.get("client_id") != row.client_id:
            return _token_error("invalid_grant", "client mismatch")
        if form.get("redirect_uri", row.redirect_uri) != row.redirect_uri:
            return _token_error("invalid_grant", "redirect_uri mismatch")
        digest = hashlib.sha256(str(form.get("code_verifier", "")).encode()).digest()
        if urlsafe_b64encode(digest).rstrip(b"=").decode() != row.code_challenge:
            return _token_error("invalid_grant", "PKCE verification failed")
        tok = OAuthToken(user_id=row.user_id, client_id=row.client_id,
                         access_token=new_mcp_access_token(),
                         refresh_token=new_mcp_refresh_token(),
                         access_expires_at=utcnow() + ACCESS_TTL,
                         refresh_expires_at=utcnow() + REFRESH_TTL)
        db.add(tok)
        db.commit()
        return _token_response(tok)

    if grant == "refresh_token":
        tok = (db.query(OAuthToken)
               .filter(OAuthToken.refresh_token == str(form.get("refresh_token", ""))).first())
        if not tok or _aware(tok.refresh_expires_at) < utcnow():
            return _token_error("invalid_grant", "unknown or expired refresh token")
        # rotate both tokens in place — the grant row (and Settings entry) persists
        tok.access_token = new_mcp_access_token()
        tok.refresh_token = new_mcp_refresh_token()
        tok.access_expires_at = utcnow() + ACCESS_TTL
        tok.refresh_expires_at = utcnow() + REFRESH_TTL
        db.commit()
        return _token_response(tok)

    return _token_error("unsupported_grant_type")
