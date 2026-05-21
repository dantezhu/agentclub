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

from loguru import logger

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
_INITIAL_RETRY_DELAY = 1.0
_MAX_RETRY_DELAY = 30.0
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


def _extract_platform_config(platform_cfg: Any) -> dict[str, Any]:
    if not isinstance(platform_cfg, dict):
        return {}
    keys = (
        "server_url",
        "agent_token",
        "require_mention",
        "allow_from",
        "allow_from_kind",
    )
    return {key: platform_cfg[key] for key in keys if key in platform_cfg}


def _resolve_allow_from(extra: dict[str, Any]) -> list[str]:
    return _coerce_string_list(extra.get("allow_from"))


def _resolve_allow_from_kind(extra: dict[str, Any]) -> list[str]:
    values = _coerce_string_list(extra.get("allow_from_kind"))
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
        except Exception as exc:
            logger.debug("[agentclub] could not set group session default: {}", exc)

        self.server_url = (
            os.getenv("AGENTCLUB_SERVER_URL")
            or extra.get("server_url")
            or ""
        ).rstrip("/")
        self.agent_token = (
            os.getenv("AGENTCLUB_AGENT_TOKEN")
            or extra.get("agent_token")
            or ""
        )
        self.require_mention = _coerce_bool(
            extra.get("require_mention"),
            True,
        )
        self.allow_from = _resolve_allow_from(extra)
        self.allow_from_kind = _resolve_allow_from_kind(extra)

        # Keep Hermes' gateway authorization in sync with our own id allowlist.
        if self.allow_from and not os.getenv("AGENTCLUB_ALLOW_FROM"):
            os.environ["AGENTCLUB_ALLOW_FROM"] = ",".join(self.allow_from)

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
            logger.error("[agentclub] server_url is not configured")
            self._set_fatal_error(
                "config_missing",
                "AGENTCLUB_SERVER_URL or agentclub.server_url is required",
                retryable=False,
            )
            return False
        if not self.agent_token:
            logger.error("[agentclub] agent_token is not configured")
            self._set_fatal_error(
                "config_missing",
                "AGENTCLUB_AGENT_TOKEN or agentclub.agent_token is required",
                retryable=False,
            )
            return False

        try:
            import aiohttp
            import socketio
        except ImportError as exc:
            logger.error("[agentclub] missing dependency: {}", exc)
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
                logger.warning("[agentclub] Agent Club token lock is already held")
                return False
        except Exception as exc:
            logger.warning("[agentclub] platform lock acquisition failed: {}", exc)
            self._lock_acquired = False

        self._tmp_dir = tempfile.mkdtemp(prefix="agentclub_hermes_")
        self._http = aiohttp.ClientSession(
            headers={"Authorization": f"Bearer {self.agent_token}"}
        )
        self._sio = socketio.AsyncClient(
            reconnection=True,
            reconnection_attempts=0,
            reconnection_delay=_INITIAL_RETRY_DELAY,
            reconnection_delay_max=_MAX_RETRY_DELAY,
        )
        self._register_sio_handlers(self._sio)
        self._auth_future = asyncio.get_running_loop().create_future()

        logger.info("[agentclub] connecting to {}", self.server_url)
        try:
            await self._sio.connect(
                self.server_url,
                auth={"agent_token": self.agent_token},
                transports=["websocket", "polling"],
            )
            await asyncio.wait_for(self._auth_future, timeout=30.0)
        except Exception as exc:
            logger.warning("[agentclub] connect failed: {}", exc)
            self._set_fatal_error("connect_failed", str(exc), retryable=True)
            await self.disconnect()
            return False

        self._mark_connected()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info("[agentclub] started")
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.debug("[agentclub] heartbeat task shutdown error: {}", exc)
            self._heartbeat_task = None
        if self._sio is not None:
            try:
                if self._sio.connected:
                    await self._sio.disconnect()
            except Exception as exc:
                logger.warning("[agentclub] disconnect error: {}", exc)
            self._sio = None
        if self._http is not None:
            try:
                await self._http.close()
            except Exception as exc:
                logger.warning("[agentclub] http close error: {}", exc)
            self._http = None
        if self._tmp_dir:
            shutil.rmtree(self._tmp_dir, ignore_errors=True)
            self._tmp_dir = None
        if self._lock_acquired:
            try:
                self._release_platform_lock()
            except Exception as exc:
                logger.warning("[agentclub] platform lock release failed: {}", exc)
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
                    logger.debug("[agentclub] listChats() HTTP {}", resp.status)
                    return empty
                data = await resp.json()
        except Exception as exc:
            logger.debug("[agentclub] listChats() error: {}", exc)
            return empty
        if not isinstance(data, dict):
            return empty
        groups = data.get("groups") if isinstance(data.get("groups"), list) else []
        directs = data.get("directs") if isinstance(data.get("directs"), list) else []
        return {"groups": groups, "directs": directs}

    def _register_sio_handlers(self, sio: Any) -> None:
        @sio.event
        async def connect() -> None:
            logger.info("[agentclub] socket connected")

        @sio.event
        async def disconnect() -> None:
            logger.warning("[agentclub] socket disconnected")

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
            logger.info(
                "[agentclub] authenticated as {} ({}), heartbeat={}s",
                self._display_name,
                self._agent_user_id,
                self._heartbeat_interval,
            )
            if self._auth_future is not None and not self._auth_future.done():
                self._auth_future.set_result(data)

        @sio.on("error")
        async def _on_error(data: dict[str, Any]) -> None:
            logger.warning("[agentclub] server error: {}", data)

        @sio.on("new_message")
        async def _on_new_message(data: dict[str, Any]) -> None:
            await self._process_inbound(data)

        @sio.on("offline_messages")
        async def _on_offline_messages(messages: list[dict[str, Any]]) -> None:
            logger.info("[agentclub] received {} offline message(s)", len(messages or []))
            for message in messages or []:
                await self._process_inbound(message)

    async def _heartbeat_loop(self) -> None:
        try:
            while self._running:
                if self._is_socket_connected():
                    try:
                        await self._sio.emit("heartbeat")
                    except Exception as exc:
                        logger.debug("[agentclub] heartbeat emit failed: {}", exc)
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
        except Exception as exc:
            logger.warning("[agentclub] mark_read failed for {}: {}", message_id, exc)

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
            logger.warning("[agentclub] upload skipped; not a file: {}", local_path)
            return None
        try:
            import aiohttp
        except ImportError as exc:
            logger.warning("[agentclub] upload skipped; missing dependency: {}", exc)
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
                        body = await resp.text()
                        logger.warning(
                            "[agentclub] upload failed HTTP {}: {}",
                            resp.status,
                            body[:200],
                        )
                        return None
                    return await resp.json()
        except Exception as exc:
            logger.warning("[agentclub] upload error for {}: {}", local_path, exc)
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
                    logger.warning(
                        "[agentclub] download failed HTTP {}: {}",
                        resp.status,
                        absolute_url,
                    )
                    return None
                data = await resp.read()
            with open(local_path, "wb") as fh:
                fh.write(data)
            return local_path
        except Exception as exc:
            logger.warning("[agentclub] download error for {}: {}", absolute_url, exc)
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
                    logger.debug(
                        "[agentclub] listGroupMembers({}) HTTP {}",
                        group_id,
                        resp.status,
                    )
                    return []
                data = await resp.json()
        except Exception as exc:
            logger.debug("[agentclub] listGroupMembers({}) error: {}", group_id, exc)
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
    server_url = os.getenv("AGENTCLUB_SERVER_URL") or extra.get("server_url", "")
    agent_token = os.getenv("AGENTCLUB_AGENT_TOKEN") or extra.get("agent_token", "")
    return bool(str(server_url or "").strip() and str(agent_token or "").strip())


def is_connected(config: Any) -> bool:
    return validate_config(config)


def _env_enablement() -> dict[str, Any] | None:
    server_url = os.getenv("AGENTCLUB_SERVER_URL", "").strip()
    agent_token = os.getenv("AGENTCLUB_AGENT_TOKEN", "").strip()
    if not (server_url and agent_token):
        return None

    return {"server_url": server_url, "agent_token": agent_token}


def _apply_yaml_config(yaml_cfg: dict[str, Any], platform_cfg: dict[str, Any]) -> dict[str, Any] | None:
    del yaml_cfg
    extra = _extract_platform_config(platform_cfg)
    if not extra:
        return None

    server_url = extra.get("server_url")
    if server_url and not os.getenv("AGENTCLUB_SERVER_URL"):
        os.environ["AGENTCLUB_SERVER_URL"] = str(server_url)
    agent_token = extra.get("agent_token")
    if agent_token and not os.getenv("AGENTCLUB_AGENT_TOKEN"):
        os.environ["AGENTCLUB_AGENT_TOKEN"] = str(agent_token)

    allow_from = _coerce_string_list(extra.get("allow_from"))
    if allow_from and not os.getenv("AGENTCLUB_ALLOW_FROM"):
        os.environ["AGENTCLUB_ALLOW_FROM"] = ",".join(allow_from)
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
        ],
        install_hint="pip install hermes-channel-agentclub",
        env_enablement_fn=_env_enablement,
        apply_yaml_config_fn=_apply_yaml_config,
        allowed_users_env="AGENTCLUB_ALLOW_FROM",
        platform_hint=(
            "You are chatting via Agent Club. Agent Club supports Markdown, "
            "code blocks, media attachments, and mention tags like "
            '<at user_id="...">name</at>. Use the Agent Club gc_/dc_ chat id '
            "unchanged when sending proactive messages."
        ),
    )
