"""Agent Club platform adapter for Hermes Agent.

The adapter connects Hermes' gateway platform interface to Agent Club's
Socket.IO/HTTP agent protocol. It intentionally keeps the Agent Club server
protocol unchanged; all Hermes-specific behavior stays in this plugin.
"""

from __future__ import annotations

import asyncio
import hashlib
import mimetypes
import os
import re
import shutil
import tempfile
import time
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urljoin

from gateway.config import Platform
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    SendResult,
)


_DEDUP_CAPACITY = 1024
_GROUP_PREFIX = "gc_"
_DIRECT_PREFIX = "dc_"
_INITIAL_HEARTBEAT_SECONDS = 30.0
_AT_TAG_RE = re.compile(r'<at user_id="([^"]+)">([^<]*)</at>')
_ALLOW_KIND_TOKENS = {"*", "human", "agent"}
_TRUE_VALUES = {"1", "true", "yes", "on"}
_FALSE_VALUES = {"0", "false", "no", "off"}


def _decode_chat_id(chat_id: str) -> tuple[str, str] | None:
    if chat_id.startswith(_GROUP_PREFIX):
        return "group", chat_id
    if chat_id.startswith(_DIRECT_PREFIX):
        return "direct", chat_id
    return None


def _extract_mention_user_ids(text: str) -> list[str]:
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for match in _AT_TAG_RE.finditer(text):
        uid = (match.group(1) or "").strip()
        if not uid or uid in seen:
            continue
        seen.add(uid)
        out.append(uid)
    return out


def _has_mention_tag(text: str) -> bool:
    return bool(text) and bool(_AT_TAG_RE.search(text))


def _coerce_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [part.strip() for part in value.split(",") if part.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(part).strip() for part in value if str(part).strip()]
    return [str(value).strip()] if str(value).strip() else []


def _env_first(*names: str) -> str:
    for name in names:
        value = os.getenv(name)
        if value is not None and value.strip():
            return value.strip()
    return ""


def _env_bool(name: str) -> bool | None:
    value = os.getenv(name)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    return None


def _coerce_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    normalized = str(value).strip().lower()
    if normalized in _TRUE_VALUES:
        return True
    if normalized in _FALSE_VALUES:
        return False
    return default


def _validate_allow_from_kind(values: list[str]) -> list[str]:
    invalid = [value for value in values if value not in _ALLOW_KIND_TOKENS]
    if invalid:
        raise ValueError(
            "allow_from_kind entries must be one of "
            f"{sorted(_ALLOW_KIND_TOKENS)}; got invalid tokens: {invalid}"
        )
    return values


def _get_extra(config: Any) -> dict[str, Any]:
    extra = getattr(config, "extra", {}) or {}
    return extra if isinstance(extra, dict) else {}


def _get_any(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in data:
            return data[key]
    return default


def _flatten_platform_config(platform_cfg: Any) -> dict[str, Any]:
    if not isinstance(platform_cfg, dict):
        return {}
    out: dict[str, Any] = {}
    extra = platform_cfg.get("extra")
    if isinstance(extra, dict):
        out.update(extra)
    for key in (
        "server_url",
        "serverUrl",
        "agent_token",
        "agentToken",
        "allow_from",
        "allowFrom",
        "allowed_users",
        "allowedUsers",
        "allow_from_kind",
        "allowFromKind",
        "require_mention",
        "requireMention",
        "home_channel",
        "homeChannel",
        "group_sessions_per_user",
        "groupSessionsPerUser",
    ):
        if key in platform_cfg:
            out[key] = platform_cfg[key]
    return out


def _resolve_allow_from(extra: dict[str, Any]) -> list[str]:
    if _env_bool("AGENTCLUB_ALLOW_ALL_USERS") is True:
        return ["*"]
    raw_env = _env_first("AGENTCLUB_ALLOWED_USERS", "AGENTCLUB_ALLOW_FROM")
    if raw_env:
        return _coerce_string_list(raw_env)
    return _coerce_string_list(
        _get_any(extra, "allow_from", "allowFrom", "allowed_users", "allowedUsers")
    )


def _resolve_allow_from_kind(extra: dict[str, Any]) -> list[str]:
    raw_env = _env_first("AGENTCLUB_ALLOW_FROM_KIND", "AGENTCLUB_ALLOWED_USER_KINDS")
    values = (
        _coerce_string_list(raw_env)
        if raw_env
        else _coerce_string_list(_get_any(extra, "allow_from_kind", "allowFromKind"))
    )
    return _validate_allow_from_kind(values)


def _infer_mime_type(filename: str, bucket: str | None = None) -> str | None:
    guessed, _ = mimetypes.guess_type(filename or "")
    if guessed:
        return guessed
    if bucket == "image":
        return "image/*"
    if bucket == "audio":
        return "audio/*"
    if bucket == "video":
        return "video/*"
    return None


def _message_type_for_content(content_type: str) -> MessageType:
    if content_type == "image":
        return MessageType.PHOTO
    if content_type == "audio":
        return MessageType.AUDIO
    if content_type == "video":
        return MessageType.VIDEO
    if content_type == "file":
        return MessageType.DOCUMENT
    return MessageType.TEXT


def _normalize_upload_content_type(value: str | None) -> str:
    if not value:
        return "file"
    lower = value.lower()
    if lower == "image" or lower.startswith("image/"):
        return "image"
    if lower == "audio" or lower.startswith("audio/"):
        return "audio"
    if lower == "video" or lower.startswith("video/"):
        return "video"
    return "file"


def _build_roster_hint(
    roster: list[dict[str, Any]],
    inbound_has_at_tags: bool,
    agent_user_id: str | None,
) -> str | None:
    if not inbound_has_at_tags and not roster:
        return None

    parts = [
        'The content may include mention tags of the form '
        '<at user_id="...">name</at>. Treat these as real mentions of '
        "Agent Club users or agents."
    ]
    if agent_user_id:
        parts.append(f'If user_id is "{agent_user_id}", that mention refers to you.')
    if roster:
        lines = []
        for member in roster:
            uid = member.get("id", "")
            name = member.get("display_name") or uid
            suffix = ""
            if uid and uid == agent_user_id:
                suffix = " (you)"
            elif member.get("is_agent"):
                suffix = " (bot)"
            lines.append(f'- {name}: user_id="{uid}"{suffix}')
        parts.append(
            "To @mention someone in your reply, emit the same tag: "
            '<at user_id="UUID">name</at>. Use user_id="all" for @everyone. '
            "Room roster:\n" + "\n".join(lines)
        )
    return " ".join(parts)


class AgentClubAdapter(BasePlatformAdapter):
    """Hermes gateway platform adapter for Agent Club."""

    def __init__(self, config: Any, **_: Any):
        platform = Platform("agentclub")
        super().__init__(config=config, platform=platform)
        extra = _get_extra(config)

        # Agent Club group ids already represent the conversation. Match the
        # OpenClaw/Nanobot adapters by defaulting group sessions to shared
        # chat sessions instead of per-sender sessions.
        try:
            self.config.extra.setdefault("group_sessions_per_user", False)
        except Exception:
            pass

        self.server_url = (
            os.getenv("AGENTCLUB_SERVER_URL")
            or _get_any(extra, "server_url", "serverUrl", default="")
            or ""
        ).rstrip("/")
        self.agent_token = (
            os.getenv("AGENTCLUB_AGENT_TOKEN")
            or _get_any(extra, "agent_token", "agentToken", default="")
            or ""
        )
        env_require = _env_bool("AGENTCLUB_REQUIRE_MENTION")
        self.require_mention = (
            env_require
            if env_require is not None
            else _coerce_bool(
                _get_any(extra, "require_mention", "requireMention"),
                True,
            )
        )
        self.allow_from = _resolve_allow_from(extra)
        self.allow_from_kind = _resolve_allow_from_kind(extra)

        # Keep Hermes' gateway authorization in sync with our own id allowlist.
        if self.allow_from and not os.getenv("AGENTCLUB_ALLOWED_USERS"):
            os.environ["AGENTCLUB_ALLOWED_USERS"] = ",".join(self.allow_from)

        self._sio: Any = None
        self._http: Any = None
        self._tmp_dir: str | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._heartbeat_interval = _INITIAL_HEARTBEAT_SECONDS
        self._agent_user_id: str | None = None
        self._display_name: str | None = None
        self._auth_future: asyncio.Future | None = None
        self._seen_message_ids: OrderedDict[str, None] = OrderedDict()
        self._roster_cache: dict[str, list[dict[str, Any]]] = {}
        self._lock_acquired = False

    @property
    def name(self) -> str:
        return "Agent Club"

    async def connect(self) -> bool:
        if not self.server_url:
            self._set_fatal_error(
                "config_missing",
                "AGENTCLUB_SERVER_URL or extra.server_url is required",
                retryable=False,
            )
            return False
        if not self.agent_token:
            self._set_fatal_error(
                "config_missing",
                "AGENTCLUB_AGENT_TOKEN or extra.agent_token is required",
                retryable=False,
            )
            return False

        try:
            import aiohttp
            import socketio
        except ImportError as exc:
            self._set_fatal_error("missing_dependency", str(exc), retryable=False)
            return False

        token_hash = hashlib.sha256(
            f"{self.server_url}:{self.agent_token}".encode("utf-8")
        ).hexdigest()[:16]
        try:
            self._lock_acquired = self._acquire_platform_lock(
                "agentclub",
                token_hash,
                "Agent Club token",
            )
            if not self._lock_acquired:
                return False
        except Exception:
            self._lock_acquired = False

        self._tmp_dir = tempfile.mkdtemp(prefix="agentclub_hermes_")
        self._http = aiohttp.ClientSession(
            headers={"Authorization": f"Bearer {self.agent_token}"}
        )
        self._sio = socketio.AsyncClient(
            reconnection=True,
            reconnection_attempts=0,
            reconnection_delay=1,
            reconnection_delay_max=30,
        )
        self._register_sio_handlers(self._sio)
        self._auth_future = asyncio.get_running_loop().create_future()

        try:
            await self._sio.connect(
                self.server_url,
                auth={"agent_token": self.agent_token},
                transports=["websocket", "polling"],
            )
            await asyncio.wait_for(self._auth_future, timeout=30.0)
        except Exception as exc:
            self._set_fatal_error("connect_failed", str(exc), retryable=True)
            await self.disconnect()
            return False

        self._mark_connected()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except (asyncio.CancelledError, Exception):
                pass
            self._heartbeat_task = None
        if self._sio is not None:
            try:
                if self._sio.connected:
                    await self._sio.disconnect()
            except Exception:
                pass
            self._sio = None
        if self._http is not None:
            try:
                await self._http.close()
            except Exception:
                pass
            self._http = None
        if self._tmp_dir:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None
        if self._lock_acquired:
            try:
                self._release_platform_lock()
            except Exception:
                pass
            self._lock_acquired = False

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        del reply_to, metadata
        decoded = _decode_chat_id(chat_id or "")
        if decoded is None:
            return SendResult(
                success=False,
                error="Agent Club chat_id must start with gc_ or dc_",
            )
        if not self._is_socket_connected():
            return SendResult(success=False, error="Not connected", retryable=True)

        chat_type, target_chat_id = decoded
        text = (content or "").strip()
        if not text:
            return SendResult(success=True)

        payload: dict[str, Any] = {
            "chat_type": chat_type,
            "chat_id": target_chat_id,
            "content": text,
            "content_type": "text",
        }
        mentions = _extract_mention_user_ids(text)
        if mentions:
            payload["mentions"] = mentions
        await self._emit_send_message(payload)
        return SendResult(success=True, message_id=f"agentclub-{int(time.time() * 1000)}")

    async def send_image(
        self,
        chat_id: str,
        image_url: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        if image_url.startswith("file://"):
            return await self.send_image_file(
                chat_id,
                unquote(image_url[7:]),
                caption=caption,
                reply_to=reply_to,
                metadata=metadata,
            )
        if image_url.startswith("/") or image_url.startswith("~/"):
            return await self.send_image_file(
                chat_id,
                os.path.expanduser(image_url),
                caption=caption,
                reply_to=reply_to,
                metadata=metadata,
            )
        text = f"{caption}\n{image_url}" if caption else image_url
        return await self.send(chat_id, text, reply_to=reply_to, metadata=metadata)

    async def send_image_file(
        self,
        chat_id: str,
        image_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **_: Any,
    ) -> SendResult:
        del reply_to, metadata
        return await self._send_file_message(chat_id, image_path, "image", caption)

    async def send_voice(
        self,
        chat_id: str,
        audio_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **_: Any,
    ) -> SendResult:
        del reply_to, metadata
        return await self._send_file_message(chat_id, audio_path, "audio", caption)

    async def send_video(
        self,
        chat_id: str,
        video_path: str,
        caption: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **_: Any,
    ) -> SendResult:
        del reply_to, metadata
        return await self._send_file_message(chat_id, video_path, "video", caption)

    async def send_document(
        self,
        chat_id: str,
        file_path: str,
        caption: str | None = None,
        file_name: str | None = None,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
        **_: Any,
    ) -> SendResult:
        del file_name, reply_to, metadata
        return await self._send_file_message(chat_id, file_path, "file", caption)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        decoded = _decode_chat_id(chat_id or "")
        if decoded is None:
            return {"name": chat_id, "type": "dm"}
        chat_type, _ = decoded
        return {"name": chat_id, "type": "group" if chat_type == "group" else "dm"}

    async def list_chats(self) -> dict[str, list[dict[str, Any]]]:
        empty = {"groups": [], "directs": []}
        if self._http is None:
            return empty
        url = urljoin(self.server_url + "/", "api/agent/chats")
        try:
            async with self._http.get(url) as resp:
                if resp.status != 200:
                    return empty
                data = await resp.json()
        except Exception:
            return empty
        if not isinstance(data, dict):
            return empty
        groups = data.get("groups") if isinstance(data.get("groups"), list) else []
        directs = data.get("directs") if isinstance(data.get("directs"), list) else []
        return {"groups": groups, "directs": directs}

    def _register_sio_handlers(self, sio: Any) -> None:
        @sio.event
        async def connect() -> None:
            return None

        @sio.event
        async def disconnect() -> None:
            return None

        @sio.on("auth_ok")
        async def _on_auth_ok(data: dict[str, Any]) -> None:
            self._agent_user_id = data.get("user_id")
            self._display_name = data.get("display_name")
            try:
                interval = float(data.get("heartbeat_interval") or 0)
            except (TypeError, ValueError):
                interval = 0
            if interval > 0:
                self._heartbeat_interval = interval
            if self._auth_future is not None and not self._auth_future.done():
                self._auth_future.set_result(data)

        @sio.on("new_message")
        async def _on_new_message(data: dict[str, Any]) -> None:
            await self._process_inbound(data)

        @sio.on("offline_messages")
        async def _on_offline_messages(messages: list[dict[str, Any]]) -> None:
            for message in messages or []:
                await self._process_inbound(message)

    async def _heartbeat_loop(self) -> None:
        try:
            while self._running:
                if self._is_socket_connected():
                    try:
                        await self._sio.emit("heartbeat")
                    except Exception:
                        pass
                await asyncio.sleep(max(1.0, self._heartbeat_interval))
        except asyncio.CancelledError:
            pass

    async def _process_inbound(self, msg: dict[str, Any]) -> None:
        message_id = msg.get("id") or ""
        sender_id = msg.get("sender_id") or ""
        sender_name = msg.get("sender_name") or sender_id
        sender_is_agent = bool(msg.get("sender_is_agent"))
        chat_type = msg.get("chat_type") or "direct"
        chat_id = msg.get("chat_id") or ""
        content = msg.get("content") or ""
        content_type = msg.get("content_type") or "text"
        file_url = msg.get("file_url") or ""
        file_name = msg.get("file_name") or ""
        mentions = [
            mention for mention in (msg.get("mentions") or []) if isinstance(mention, str)
        ]

        if sender_id and sender_id == self._agent_user_id:
            return

        if message_id:
            if message_id in self._seen_message_ids:
                await self._ack(message_id)
                return
            self._seen_message_ids[message_id] = None
            while len(self._seen_message_ids) > _DEDUP_CAPACITY:
                self._seen_message_ids.popitem(last=False)

        if not self._is_sender_id_allowed(sender_id):
            await self._ack(message_id)
            return
        if not self._is_sender_kind_allowed(sender_is_agent):
            await self._ack(message_id)
            return

        mentions_bot = (
            bool(self._agent_user_id) and self._agent_user_id in mentions
        ) or ("all" in mentions)
        if chat_type == "group" and self.require_mention and not mentions_bot:
            await self._ack(message_id)
            return

        media_paths: list[str] = []
        media_types: list[str] = []
        if file_url and content_type != "text":
            local_path = await self._download_attachment(
                file_url, file_name or message_id or "attachment"
            )
            if local_path:
                media_paths.append(local_path)
                inferred = _infer_mime_type(local_path, content_type)
                if inferred:
                    media_types.append(inferred)

        text = content
        if file_url and content_type != "text":
            label = file_name or file_url
            bracket = f"[{content_type}: {label}]"
            text = f"{text}\n{bracket}" if text else bracket

        if not text.strip() and not media_paths:
            await self._ack(message_id)
            return

        roster: list[dict[str, Any]] = []
        if chat_type == "group" and chat_id:
            roster = await self._list_group_members(chat_id)
        hint = _build_roster_hint(roster, _has_mention_tag(text), self._agent_user_id)
        prompt = f"{text}\n\n[System: {hint}]" if hint else text

        await self._ack(message_id)

        source = self.build_source(
            chat_id=chat_id,
            chat_name=chat_id,
            chat_type="group" if chat_type == "group" else "dm",
            user_id=sender_id,
            user_name=sender_name,
            is_bot=sender_is_agent,
            message_id=message_id,
        )
        event = MessageEvent(
            text=prompt,
            message_type=_message_type_for_content(content_type),
            source=source,
            raw_message=msg,
            message_id=message_id,
            media_urls=media_paths,
            media_types=media_types,
            timestamp=_timestamp_from_payload(msg.get("created_at")),
        )
        await self.handle_message(event)

    def _is_sender_id_allowed(self, sender_id: str) -> bool:
        return "*" in self.allow_from or (bool(sender_id) and sender_id in self.allow_from)

    def _is_sender_kind_allowed(self, sender_is_agent: bool) -> bool:
        if "*" in self.allow_from_kind:
            return True
        return "agent" in self.allow_from_kind if sender_is_agent else "human" in self.allow_from_kind

    async def _ack(self, message_id: str) -> None:
        if not message_id or not self._is_socket_connected():
            return
        try:
            await self._sio.emit("mark_read", {"message_ids": [message_id]})
        except Exception:
            pass

    async def _emit_send_message(self, payload: dict[str, Any]) -> None:
        await self._sio.emit("send_message", payload)

    async def _send_file_message(
        self,
        chat_id: str,
        local_path: str,
        preferred_type: str,
        caption: str | None = None,
    ) -> SendResult:
        decoded = _decode_chat_id(chat_id or "")
        if decoded is None:
            return SendResult(
                success=False,
                error="Agent Club chat_id must start with gc_ or dc_",
            )
        if not self._is_socket_connected():
            return SendResult(success=False, error="Not connected", retryable=True)

        uploaded = await self._upload_attachment(local_path)
        if not uploaded:
            return SendResult(success=False, error=f"Upload failed: {local_path}")
        chat_type, target_chat_id = decoded
        content = (caption or "").strip()
        payload: dict[str, Any] = {
            "chat_type": chat_type,
            "chat_id": target_chat_id,
            "content": content,
            "content_type": _normalize_upload_content_type(
                uploaded.get("content_type") or preferred_type
            ),
            "file_url": uploaded["url"],
            "file_name": uploaded["filename"],
        }
        mentions = _extract_mention_user_ids(content)
        if mentions:
            payload["mentions"] = mentions
        await self._emit_send_message(payload)
        return SendResult(success=True, message_id=f"agentclub-{int(time.time() * 1000)}")

    async def _upload_attachment(self, local_path: str) -> dict[str, Any] | None:
        if self._http is None:
            return None
        path = Path(local_path).expanduser()
        if not path.is_file():
            return None
        try:
            import aiohttp
        except ImportError:
            return None
        url = urljoin(self.server_url + "/", "api/agent/upload")
        try:
            with path.open("rb") as fh:
                data = aiohttp.FormData()
                data.add_field(
                    "file",
                    fh,
                    filename=path.name,
                    content_type="application/octet-stream",
                )
                async with self._http.post(url, data=data) as resp:
                    if resp.status != 200:
                        return None
                    return await resp.json()
        except Exception:
            return None

    async def _download_attachment(self, file_url: str, file_name: str) -> str | None:
        if self._tmp_dir is None or self._http is None:
            return None
        absolute_url = (
            file_url
            if re.match(r"^https?://", file_url, flags=re.IGNORECASE)
            else urljoin(self.server_url + "/", file_url.lstrip("/"))
        )
        safe_name = Path(file_name).name or "attachment"
        local_path = os.path.join(self._tmp_dir, safe_name)
        try:
            async with self._http.get(absolute_url) as resp:
                if resp.status != 200:
                    return None
                data = await resp.read()
            with open(local_path, "wb") as fh:
                fh.write(data)
            return local_path
        except Exception:
            return None

    async def _list_group_members(self, group_id: str) -> list[dict[str, Any]]:
        if self._http is None or not group_id:
            return []
        if group_id in self._roster_cache:
            return self._roster_cache[group_id]
        url = urljoin(self.server_url + "/", f"api/agent/groups/{group_id}/members")
        try:
            async with self._http.get(url) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()
        except Exception:
            return []
        roster = data if isinstance(data, list) else []
        self._roster_cache[group_id] = roster
        return roster

    def _is_socket_connected(self) -> bool:
        return bool(self._sio is not None and getattr(self._sio, "connected", False))


def _timestamp_from_payload(value: Any) -> datetime:
    try:
        return datetime.fromtimestamp(float(value))
    except (TypeError, ValueError, OSError):
        return datetime.now()


def check_requirements() -> bool:
    try:
        import aiohttp  # noqa: F401
        import socketio  # noqa: F401
    except ImportError:
        return False
    return True


def validate_config(config: Any) -> bool:
    extra = _get_extra(config)
    try:
        _resolve_allow_from_kind(extra)
    except ValueError:
        return False
    server_url = os.getenv("AGENTCLUB_SERVER_URL") or _get_any(
        extra, "server_url", "serverUrl", default=""
    )
    agent_token = os.getenv("AGENTCLUB_AGENT_TOKEN") or _get_any(
        extra, "agent_token", "agentToken", default=""
    )
    return bool(str(server_url or "").strip() and str(agent_token or "").strip())


def is_connected(config: Any) -> bool:
    return validate_config(config)


def _env_enablement() -> dict[str, Any] | None:
    server_url = os.getenv("AGENTCLUB_SERVER_URL", "").strip()
    agent_token = os.getenv("AGENTCLUB_AGENT_TOKEN", "").strip()
    if not (server_url and agent_token):
        return None

    seed: dict[str, Any] = {"server_url": server_url, "agent_token": agent_token}
    require_mention = _env_bool("AGENTCLUB_REQUIRE_MENTION")
    if require_mention is not None:
        seed["require_mention"] = require_mention

    allowed = _env_first("AGENTCLUB_ALLOWED_USERS", "AGENTCLUB_ALLOW_FROM")
    if _env_bool("AGENTCLUB_ALLOW_ALL_USERS") is True:
        allowed = "*"
    if allowed:
        if not os.getenv("AGENTCLUB_ALLOWED_USERS"):
            os.environ["AGENTCLUB_ALLOWED_USERS"] = allowed
        seed["allow_from"] = _coerce_string_list(allowed)

    kinds = _env_first("AGENTCLUB_ALLOW_FROM_KIND", "AGENTCLUB_ALLOWED_USER_KINDS")
    if kinds:
        seed["allow_from_kind"] = _coerce_string_list(kinds)

    home = os.getenv("AGENTCLUB_HOME_CHANNEL", "").strip()
    if home:
        seed["home_channel"] = {"chat_id": home, "name": home}
    return seed


def _apply_yaml_config(yaml_cfg: dict[str, Any], platform_cfg: dict[str, Any]) -> dict[str, Any] | None:
    del yaml_cfg
    extra = _flatten_platform_config(platform_cfg)
    if not extra:
        return None

    server_url = _get_any(extra, "server_url", "serverUrl")
    if server_url and not os.getenv("AGENTCLUB_SERVER_URL"):
        os.environ["AGENTCLUB_SERVER_URL"] = str(server_url)
    agent_token = _get_any(extra, "agent_token", "agentToken")
    if agent_token and not os.getenv("AGENTCLUB_AGENT_TOKEN"):
        os.environ["AGENTCLUB_AGENT_TOKEN"] = str(agent_token)

    allow_from = _coerce_string_list(
        _get_any(extra, "allow_from", "allowFrom", "allowed_users", "allowedUsers")
    )
    if allow_from and not os.getenv("AGENTCLUB_ALLOWED_USERS"):
        os.environ["AGENTCLUB_ALLOWED_USERS"] = ",".join(allow_from)
    allow_kind = _coerce_string_list(_get_any(extra, "allow_from_kind", "allowFromKind"))
    if allow_kind and not os.getenv("AGENTCLUB_ALLOW_FROM_KIND"):
        os.environ["AGENTCLUB_ALLOW_FROM_KIND"] = ",".join(allow_kind)
    require_mention = _get_any(extra, "require_mention", "requireMention")
    if require_mention is not None and not os.getenv("AGENTCLUB_REQUIRE_MENTION"):
        os.environ["AGENTCLUB_REQUIRE_MENTION"] = (
            "true" if _coerce_bool(require_mention, True) else "false"
        )
    return extra


def register(ctx: Any) -> None:
    ctx.register_platform(
        name="agentclub",
        label="Agent Club",
        adapter_factory=lambda cfg: AgentClubAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=[
            "AGENTCLUB_SERVER_URL",
            "AGENTCLUB_AGENT_TOKEN",
            "AGENTCLUB_ALLOWED_USERS",
            "AGENTCLUB_ALLOW_FROM_KIND",
        ],
        install_hint="pip install hermes-channel-agentclub",
        env_enablement_fn=_env_enablement,
        apply_yaml_config_fn=_apply_yaml_config,
        allowed_users_env="AGENTCLUB_ALLOWED_USERS",
        allow_all_env="AGENTCLUB_ALLOW_ALL_USERS",
        platform_hint=(
            "You are chatting via Agent Club. Agent Club supports Markdown, "
            "code blocks, media attachments, and mention tags like "
            '<at user_id="...">name</at>. Use the Agent Club gc_/dc_ chat id '
            "unchanged when sending proactive messages."
        ),
    )
