"""Telegram Clone Worker — protocol bridge.

Holds MTProto user sessions (Telethon) on this host and exposes a small
JSON HTTP API for the Cloudflare Worker, which orchestrates clone tasks.
The Worker never sees api_id/api_hash/codes; they only ever transit
through the request bodies below and are never logged.
"""

import asyncio
import json
import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from telethon import TelegramClient, utils
from telethon.errors import (
    AuthKeyUnregisteredError,
    ChannelPrivateError,
    FloodWaitError,
    InviteHashExpiredError,
    InviteHashInvalidError,
    PhoneCodeExpiredError,
    PhoneCodeInvalidError,
    SessionPasswordNeededError,
    UsernameInvalidError,
    UsernameNotOccupiedError,
)
from telethon.tl.functions.messages import CheckChatInviteRequest
from telethon.tl.types import (
    Channel,
    Chat,
    ChatInvite,
    ChatInviteAlready,
    DocumentAttributeAnimated,
    DocumentAttributeAudio,
    DocumentAttributeFilename,
    DocumentAttributeVideo,
    Message,
    MessageMediaDocument,
    MessageMediaPhoto,
    User,
)

DATA_DIR = Path(os.environ.get("BRIDGE_DATA_DIR", "./data")).resolve()
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")
PORT = int(os.environ.get("BRIDGE_PORT", "18787"))
MAX_BATCH_IDS = 50

app = FastAPI(title="telegram-clone-bridge", docs_url=None, redoc_url=None)

DATA_DIR.mkdir(parents=True, exist_ok=True)
ACCOUNTS_FILE = DATA_DIR / "accounts.json"

# phone -> asyncio.Lock, serializes all MTProto calls per account
_locks: dict[str, asyncio.Lock] = {}
# phone -> live client
_clients: dict[str, TelegramClient] = {}
# phone -> pending login context (in-memory only; lost on restart, resend code)
_pending: dict[str, dict] = {}


def _json_error(status: int, code: str, message: str, **extra):
    return JSONResponse({"ok": False, "error": code, "message": message, **extra}, status_code=status)


def _sanitize_phone(phone: str) -> str:
    return re.sub(r"[^0-9]", "", phone)


def _session_path(phone: str) -> str:
    return str(DATA_DIR / f"session_{_sanitize_phone(phone)}.session")


def _load_accounts() -> dict:
    if not ACCOUNTS_FILE.exists():
        return {}
    try:
        return json.loads(ACCOUNTS_FILE.read_text())
    except Exception:
        return {}


def _save_accounts(accounts: dict) -> None:
    ACCOUNTS_FILE.write_text(json.dumps(accounts))
    os.chmod(ACCOUNTS_FILE, 0o600)


def _lock_for(phone: str) -> asyncio.Lock:
    lock = _locks.get(phone)
    if lock is None:
        lock = asyncio.Lock()
        _locks[phone] = lock
    return lock


async def _get_client(phone: str) -> TelegramClient:
    """Return a connected, authorized client for phone. Raises KeyError if
    the account was never logged in here, RuntimeError if not authorized."""
    client = _clients.get(phone)
    accounts = _load_accounts()
    creds = accounts.get(phone)
    if creds is None:
        raise KeyError(f"account {phone} not logged in on this bridge")
    if client is None or not client.is_connected():
        client = TelegramClient(_session_path(phone), int(creds["api_id"]), creds["api_hash"])
        await client.connect()
        _clients[phone] = client
    if not await client.is_user_authorized():
        raise RuntimeError(f"account {phone} session is not authorized (logged out?)")
    return client


async def _resolve_entity(client: TelegramClient, chat: str):
    """chat may be @username, t.me invite link, or a numeric id."""
    chat = chat.strip()
    m = re.search(r"(?:t\.me/|telegram\.me/)(?:joinchat/|\+)([\w-]+)", chat)
    if m:
        invite_hash = m.group(1)
        result = await client(CheckChatInviteRequest(invite_hash))
        if isinstance(result, (ChatInvite, ChatInviteAlready)):
            return result.chat
        raise ValueError("invite link could not be resolved")
    if re.fullmatch(r"-?\d+", chat):
        return await client.get_entity(int(chat))
    return await client.get_entity(chat)


def _chat_info(entity) -> dict:
    if isinstance(entity, Channel):
        chat_type = "channel" if entity.broadcast else "supergroup"
        title = entity.title
        username = getattr(entity, "username", None)
    elif isinstance(entity, Chat):
        chat_type = "group"
        title = entity.title
        username = None
    elif isinstance(entity, User):
        chat_type = "user"
        title = " ".join(filter(None, [entity.first_name, entity.last_name])) or None
        username = entity.username
    else:
        chat_type = "unknown"
        title = getattr(entity, "title", None)
        username = getattr(entity, "username", None)
    return {"id": entity.id, "title": title, "type": chat_type, "username": username}


def _media_info(msg: Message) -> dict | None:
    media = msg.media
    if isinstance(media, MessageMediaPhoto) and media.photo:
        sizes = [s for s in getattr(media.photo, "sizes", []) if hasattr(s, "size")]
        size = max((s.size for s in sizes), default=None)
        return {"type": "photo", "size": size, "name": None}
    if isinstance(media, MessageMediaDocument) and media.document:
        doc = media.document
        size = getattr(doc, "size", None)
        name = None
        kind = "document"
        for attr in getattr(doc, "attributes", []):
            if isinstance(attr, DocumentAttributeFilename):
                name = attr.file_name
            elif isinstance(attr, DocumentAttributeVideo):
                kind = "video"
            elif isinstance(attr, DocumentAttributeAudio):
                kind = "voice" if getattr(attr, "voice", False) else "audio"
            elif isinstance(attr, DocumentAttributeAnimated):
                kind = "animation"
        mime = getattr(doc, "mime_type", "") or ""
        if kind == "document" and mime.startswith("video/"):
            kind = "video"
        return {"type": kind, "size": size, "name": name}
    return None


def _message_info(msg: Message) -> dict:
    media = _media_info(msg)
    return {
        "id": msg.id,
        "date": msg.date.isoformat() if msg.date else None,
        "text": msg.message or None,
        "media": media,
    }


def _map_telethon_error(e: Exception):
    """-> (http_status, code, message, extra)"""
    if isinstance(e, FloodWaitError):
        return 429, "rate_limited", f"Telegram flood wait: {e.seconds}s", {"retry_after": e.seconds}
    if isinstance(e, (AuthKeyUnregisteredError,)):
        return 401, "unauthorized", "session is not authorized (logged out or revoked)", {}
    if isinstance(e, (UsernameNotOccupiedError, UsernameInvalidError)):
        return 404, "not_found", "chat not found", {}
    if isinstance(e, ChannelPrivateError):
        return 404, "not_found", "chat is private or account has no access", {}
    if isinstance(e, (InviteHashExpiredError, InviteHashInvalidError)):
        return 400, "invalid_request", "invite link is invalid or expired", {}
    if isinstance(e, (PhoneCodeInvalidError, PhoneCodeExpiredError)):
        return 400, "invalid_request", "login code is invalid or expired", {}
    if isinstance(e, KeyError):
        return 404, "not_found", str(e), {}
    if isinstance(e, RuntimeError):
        return 401, "unauthorized", str(e), {}
    if isinstance(e, ValueError):
        return 400, "invalid_request", str(e), {}
    return 502, "unknown", f"telegram error: {type(e).__name__}: {e}", {}


@app.middleware("http")
async def _auth(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)
    if not BRIDGE_SECRET:
        return _json_error(500, "misconfigured", "BRIDGE_SECRET is not set on the bridge")
    if request.headers.get("x-bridge-secret") != BRIDGE_SECRET:
        return _json_error(401, "unauthorized", "bad or missing X-Bridge-Secret")
    return await call_next(request)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/health")
async def health():
    accounts = []
    # Reuse the cached client via _get_client: opening a second
    # TelegramClient on the same SQLite session file races the first
    # client's uncommitted transaction and reads a stale DB.
    for phone in _load_accounts().keys():
        try:
            await _get_client(phone)
            authorized = True
        except Exception:
            authorized = False
        accounts.append({"phone": phone, "authorized": authorized})
    return {"ok": True, "accounts": accounts}


@app.post("/accounts/login/send-code")
async def login_send_code(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    api_id = body.get("api_id")
    api_hash = body.get("api_hash")
    if not phone or not api_id or not api_hash:
        return _json_error(400, "invalid_request", "phone, api_id and api_hash are required")
    try:
        async with _lock_for(phone):
            # Reuse the cached client when it's still connected: two
            # TelegramClients on the same SQLite session file race each
            # other's uncommitted transactions.
            client = _clients.get(phone)
            fresh = False
            if client is None or not client.is_connected():
                client = TelegramClient(_session_path(phone), int(api_id), str(api_hash))
                await client.connect()
                fresh = True
            try:
                if await client.is_user_authorized():
                    _clients[phone] = client
                    accounts = _load_accounts()
                    accounts[phone] = {"api_id": int(api_id), "api_hash": str(api_hash)}
                    _save_accounts(accounts)
                    return {"ok": True, "already_authorized": True}
                sent = await client.send_code_request(phone)
                _pending[phone] = {
                    "api_id": int(api_id),
                    "api_hash": str(api_hash),
                    "phone_code_hash": sent.phone_code_hash,
                    "at": time.time(),
                }
                # keep the connected client around for the confirm step
                _clients[phone] = client
                return {"ok": True, "already_authorized": False}
            except Exception:
                if fresh:
                    await client.disconnect()
                    _clients.pop(phone, None)
                raise
    except Exception as e:
        status, code, message, extra = _map_telethon_error(e)
        return _json_error(status, code, message, **extra)


@app.post("/accounts/login/confirm")
async def login_confirm(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    code = str(body.get("code", "")).strip()
    password = body.get("password")
    if not phone or not code:
        return _json_error(400, "invalid_request", "phone and code are required")
    pending = _pending.get(phone) or {}
    api_id = body.get("api_id") or pending.get("api_id")
    api_hash = body.get("api_hash") or pending.get("api_hash")
    phone_code_hash = pending.get("phone_code_hash")
    if not api_id or not api_hash:
        return _json_error(400, "invalid_request", "api_id/api_hash missing (send-code first)")
    try:
        async with _lock_for(phone):
            client = _clients.get(phone)
            fresh = False
            if client is None or not client.is_connected():
                client = TelegramClient(_session_path(phone), int(api_id), str(api_hash))
                await client.connect()
                _clients[phone] = client
                fresh = True
            try:
                try:
                    if phone_code_hash:
                        await client.sign_in(phone, code, phone_code_hash=phone_code_hash)
                    else:
                        await client.sign_in(phone, code)
                except SessionPasswordNeededError:
                    if not password:
                        return _json_error(400, "2fa_required", "two-factor password required")
                    await client.sign_in(password=str(password))
                # Commit the session to disk NOW. Telethon only flushes the
                # SQLite session on save()/close(); sign_in leaves the auth
                # in an uncommitted transaction, so without this a second
                # client on the same file reads a stale DB and a bridge
                # restart rolls the journal back, losing the login.
                await utils.maybe_async(client.session.save())
                accounts = _load_accounts()
                accounts[phone] = {"api_id": int(api_id), "api_hash": str(api_hash)}
                _save_accounts(accounts)
                _pending.pop(phone, None)
                me = await client.get_me()
                return {
                    "ok": True,
                    "phone": phone,
                    "user_id": me.id if me else None,
                    "username": getattr(me, "username", None),
                }
            except Exception:
                if fresh:
                    await client.disconnect()
                    _clients.pop(phone, None)
                raise
    except Exception as e:
        status, code_, message, extra = _map_telethon_error(e)
        return _json_error(status, code_, message, **extra)


@app.post("/accounts/logout")
async def logout(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    if not phone:
        return _json_error(400, "invalid_request", "phone is required")
    async with _lock_for(phone):
        client = _clients.pop(phone, None)
        if client is not None:
            try:
                await client.log_out()
            except Exception:
                pass
            try:
                await client.disconnect()
            except Exception:
                pass
        base = _session_path(phone)
        for p in (Path(base), Path(base + "-journal")):
            try:
                p.unlink(missing_ok=True)
            except Exception:
                pass
        accounts = _load_accounts()
        accounts.pop(phone, None)
        _save_accounts(accounts)
        _pending.pop(phone, None)
    return {"ok": True}


@app.post("/resolve")
async def resolve(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    chat = str(body.get("chat", "")).strip()
    if not phone or not chat:
        return _json_error(400, "invalid_request", "phone and chat are required")
    try:
        async with _lock_for(phone):
            client = await _get_client(phone)
            entity = await _resolve_entity(client, chat)
            return {"ok": True, **_chat_info(entity)}
    except Exception as e:
        status, code, message, extra = _map_telethon_error(e)
        return _json_error(status, code, message, **extra)


@app.post("/latest-id")
async def latest_id(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    chat = str(body.get("chat", "")).strip()
    if not phone or not chat:
        return _json_error(400, "invalid_request", "phone and chat are required")
    try:
        async with _lock_for(phone):
            client = await _get_client(phone)
            entity = await _resolve_entity(client, chat)
            msgs = await client.get_messages(entity, limit=1)
            return {"ok": True, "latest_id": msgs[0].id if msgs else 0}
    except Exception as e:
        status, code, message, extra = _map_telethon_error(e)
        return _json_error(status, code, message, **extra)


@app.post("/forward-batch")
async def forward_batch(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    source = str(body.get("source", "")).strip()
    dest = str(body.get("dest", "")).strip()
    ids = body.get("ids") or []
    drop_author = bool(body.get("drop_author", False))
    if not phone or not source or not dest or not ids:
        return _json_error(400, "invalid_request", "phone, source, dest and ids are required")
    ids = [int(i) for i in ids][:MAX_BATCH_IDS]
    copied: list[int] = []
    failed: list[dict] = []
    try:
        async with _lock_for(phone):
            client = await _get_client(phone)
            src_entity = await _resolve_entity(client, source)
            dst_entity = await _resolve_entity(client, dest)
            for mid in ids:
                try:
                    await client.forward_messages(dst_entity, mid, src_entity, drop_author=drop_author or None)
                    copied.append(mid)
                except FloodWaitError as e:
                    return _json_error(429, "rate_limited", f"Telegram flood wait: {e.seconds}s", retry_after=e.seconds)
                except Exception as e:
                    failed.append({"id": mid, "error": f"{type(e).__name__}: {e}"})
        return {"ok": True, "copied": copied, "failed": failed}
    except Exception as e:
        status, code, message, extra = _map_telethon_error(e)
        return _json_error(status, code, message, **extra)


@app.post("/sync")
async def sync(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    chat = str(body.get("chat", "")).strip()
    since_id = int(body.get("since_id") or 0)
    limit = min(int(body.get("limit") or 100), 200)
    if not phone or not chat:
        return _json_error(400, "invalid_request", "phone and chat are required")
    try:
        async with _lock_for(phone):
            client = await _get_client(phone)
            entity = await _resolve_entity(client, chat)
            msgs = await client.get_messages(entity, min_id=since_id, limit=limit, reverse=True)
            return {"ok": True, "messages": [_message_info(m) for m in msgs if isinstance(m, Message)]}
    except Exception as e:
        status, code, message, extra = _map_telethon_error(e)
        return _json_error(status, code, message, **extra)


@app.post("/send-test")
async def send_test(request: Request):
    body = await request.json()
    phone = str(body.get("phone", "")).strip()
    chat = str(body.get("chat", "")).strip()
    text = str(body.get("text", ""))
    if not phone or not chat or not text:
        return _json_error(400, "invalid_request", "phone, chat and text are required")
    try:
        async with _lock_for(phone):
            client = await _get_client(phone)
            entity = await _resolve_entity(client, chat)
            sent = await client.send_message(entity, text)
            return {"ok": True, "message_id": sent.id}
    except Exception as e:
        status, code, message, extra = _map_telethon_error(e)
        return _json_error(status, code, message, **extra)


def main():
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
