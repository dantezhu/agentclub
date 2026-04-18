"""Agent Club channel implementation for Nanobot.

Connects a Nanobot agent to the Agent Club IM server via Socket.IO
(auth = agent token) and a small HTTP surface for file upload and group
roster lookup.

Feature parity with the OpenClaw channel of the same server:

* ``mark_read`` ACK per inbound message — advances the server-side read
  cursor so messages aren't re-delivered via ``offline_messages`` on the
  next reconnect.
* ``<at user_id="…">name</at>`` @mention wire format, both inbound
  (preserved + system hint injected with the group roster) and outbound
  (parsed out of the agent's reply text to populate the ``mentions``
  field of ``send_message``).
* Recent-id dedup so duplicate deliveries (e.g. ACK raced a reconnect)
  don't produce duplicate agent runs.
* ``allow_from`` is an allowlist with support for role tokens. Empty
  list denies everyone (default-deny). Supported entries:
    - ``"*"``    — allow anyone
    - ``"human"`` — allow all non-agent senders
    - ``"agent"`` — allow all agent senders
    - any other string — a specific user_id
  Tokens can be mixed freely, e.g. ``["human", "agent-xyz"]``.

``streaming`` is intentionally not implemented yet — the IM server has
no "edit message" event, so every chunk would become a separate
message. If/when a streaming protocol is added server-side, override
``send_delta`` here.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
from collections import OrderedDict
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import aiohttp
import socketio
from loguru import logger
from pydantic import BaseModel, Field

from nanobot.bus.events import OutboundMessage
from nanobot.bus.queue import MessageBus
from nanobot.channels.base import BaseChannel


# Max inbound message ids to remember for dedup. 1024 matches the
# OpenClaw-channel gateway's dedup window.
_DEDUP_CAPACITY = 1024

# Wire format for @mentions, mirrored byte-for-byte from the OpenClaw
# channel so messages round-trip unchanged between the two adapters.
#   <at user_id="uuid-or-all">display name</at>
_AT_TAG_RE = re.compile(r'<at user_id="([^"]+)">([^<]*)</at>')


# Chat-id prefixes we stamp on every id before handing it to the bus,
# then strip on the way back out to the IM server. The model sees the
# prefixed form in Nanobot's Runtime-Context block; picking shapes
# that look like part of the id itself (no ``:``) prevents the LLM
# from treating them as structured "key:value" syntax and rewriting
# the id into a bare UUID before calling the ``message`` tool. This
# is the same trick Feishu uses with ``oc_`` / ``ou_`` — except there
# the prefix is enforced by the platform, here we add our own.
_GROUP_PREFIX = "gr_"
_DIRECT_PREFIX = "pr_"


def _encode_chat_id(chat_type: str, chat_id: str) -> str:
    """Tag ``chat_id`` with a chat-type prefix for the bus-facing form."""
    if chat_type == "group":
        return f"{_GROUP_PREFIX}{chat_id}"
    if chat_type == "direct":
        return f"{_DIRECT_PREFIX}{chat_id}"
    return chat_id


def _decode_chat_id(encoded: str) -> tuple[str, str] | None:
    """Recover ``(chat_type, chat_id)`` from a prefixed id, or ``None``."""
    if encoded.startswith(_GROUP_PREFIX):
        return "group", encoded[len(_GROUP_PREFIX):]
    if encoded.startswith(_DIRECT_PREFIX):
        return "direct", encoded[len(_DIRECT_PREFIX):]
    return None


def _extract_mention_user_ids(text: str) -> list[str]:
    """Pull unique user_ids out of ``<at user_id="…">`` tags."""
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


def _build_roster_hint(
    roster: list[dict[str, Any]],
    inbound_has_at_tags: bool,
    agent_user_id: str | None,
) -> str | None:
    """Return a system hint describing the mention protocol, or None.

    Mirrors the hint injected by the OpenClaw channel so the agent gets
    the same guidance regardless of which adapter is running.
    """
    if not inbound_has_at_tags and not roster:
        return None

    parts: list[str] = [
        'The content may include mention tags of the form '
        '<at user_id="...">name</at>. '
        'Treat these as real mentions of Agent Club users (or bots).'
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
            'To @mention someone in your reply, emit the same tag: '
            '<at user_id="UUID">name</at>. Use user_id="all" for '
            '@everyone. Room roster:\n' + "\n".join(lines)
        )
    return " ".join(parts)


class AgentClubConfig(BaseModel):
    """Agent Club channel configuration (stored under ``channels.agentclub``).

    Environment variables ``AGENTCLUB_SERVER_URL`` and
    ``AGENTCLUB_AGENT_TOKEN`` take precedence over the JSON values so
    secrets don't have to be committed to ``nanobot.json``.
    """

    enabled: bool = False
    server_url: str = ""
    agent_token: str = ""
    # ``allow_from`` is an allowlist with role tokens. An empty list
    # denies everyone (default-deny, matching feishu/openclaw). Entries:
    # ``"*"`` = anyone, ``"human"`` = all non-agent senders,
    # ``"agent"`` = all agent senders, anything else = a specific user_id.
    allow_from: list[str] = Field(default_factory=list)
    require_mention: bool = True
    streaming: bool = False


class AgentClubChannel(BaseChannel):
    """Agent Club IM channel for Nanobot.

    Single-socket, single-agent: one plugin instance represents one
    agent identity on the IM server. Multi-agent setups should spin up
    multiple nanobot processes (or someday multiple accounts).
    """

    name = "agentclub"
    display_name = "Agent Club"

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return AgentClubConfig().model_dump(by_alias=True)

    def __init__(self, config: Any, bus: MessageBus):
        if isinstance(config, dict):
            config = AgentClubConfig.model_validate(config)
        super().__init__(config, bus)
        self.config: AgentClubConfig = config

        # Environment overrides win over JSON so secrets can stay out of
        # the config file.
        self._server_url: str = (
            os.environ.get("AGENTCLUB_SERVER_URL")
            or self.config.server_url
            or ""
        ).rstrip("/")
        self._agent_token: str = (
            os.environ.get("AGENTCLUB_AGENT_TOKEN") or self.config.agent_token or ""
        )

        self._sio: socketio.AsyncClient | None = None
        self._http: aiohttp.ClientSession | None = None
        self._tmp_dir: str | None = None
        self._stop_event: asyncio.Event | None = None
        self._heartbeat_task: asyncio.Task | None = None
        # Cadence of application-level heartbeats. Seeded with a sane
        # default and overwritten when `auth_ok` arrives so the server's
        # Config acts as the single source of truth.
        self._heartbeat_interval: float = 30.0

        # Populated on ``auth_ok``
        self._agent_user_id: str | None = None
        self._display_name: str | None = None

        # Second-layer dedup. The IM server won't re-emit a message once
        # we ACK it via ``mark_read``, but an ACK that raced a
        # reconnect can still produce a duplicate — this catches it.
        self._seen_message_ids: OrderedDict[str, None] = OrderedDict()

        # Best-effort in-memory cache of group rosters, keyed by
        # ``group_id``. Invalidated passively: if an agent sees a
        # mention it doesn't recognize the cache will just look stale;
        # a restart refreshes it. Kept on the instance so unit tests
        # can inspect/seed it.
        self._roster_cache: dict[str, list[dict[str, Any]]] = {}

    # ----------------------------------------------------------------
    # BaseChannel lifecycle
    # ----------------------------------------------------------------

    async def start(self) -> None:
        if not self._server_url:
            logger.error("[agentclub] server_url is not configured")
            return
        if not self._agent_token:
            logger.error("[agentclub] agent_token is not configured")
            return

        self._tmp_dir = tempfile.mkdtemp(prefix="agentclub_")
        self._stop_event = asyncio.Event()
        self._http = aiohttp.ClientSession(
            headers={"Authorization": f"Bearer {self._agent_token}"}
        )

        self._sio = socketio.AsyncClient(
            reconnection=True,
            reconnection_attempts=0,  # infinite
            reconnection_delay=1,
            reconnection_delay_max=30,
        )
        self._register_sio_handlers(self._sio)

        logger.info("[agentclub] connecting to {}", self._server_url)
        try:
            await self._sio.connect(
                self._server_url,
                auth={"agent_token": self._agent_token},
                transports=["websocket", "polling"],
            )
        except Exception as exc:
            logger.error("[agentclub] connect failed: {}", exc)
            await self._cleanup()
            return

        self._running = True
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())
        logger.info("[agentclub] started")
        try:
            await self._stop_event.wait()
        finally:
            await self._cleanup()

    async def stop(self) -> None:
        self._running = False
        if self._stop_event is not None:
            self._stop_event.set()

    async def _heartbeat_loop(self) -> None:
        """Emit an application-level heartbeat while connected.

        The IM server combines its record of our ws connection with the
        `last_seen` timestamp we bump here to decide whether we're truly
        online. If this loop stops (process hung, task cancelled) the
        server will eventually mark us offline even if the socket itself
        is still held open by an uncooperative network path.

        Cadence is sourced from `self._heartbeat_interval`, which starts
        at a safe default and is overwritten from the `auth_ok` payload
        so the server owns the schedule."""
        try:
            while self._running:
                if self._sio is not None and self._sio.connected:
                    try:
                        await self._sio.emit("heartbeat")
                    except Exception as exc:
                        logger.debug("[agentclub] heartbeat emit failed: {}", exc)
                # Re-read every iteration so an `auth_ok` mid-run (on
                # reconnect) takes effect on the next beat.
                await asyncio.sleep(max(1.0, self._heartbeat_interval))
        except asyncio.CancelledError:
            pass

    async def _cleanup(self) -> None:
        """Tear down in a fixed order: heartbeat, sio, http, tmp dir."""
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
            except Exception as exc:
                logger.warning("[agentclub] disconnect error: {}", exc)
            self._sio = None
        if self._http is not None:
            try:
                await self._http.close()
            except Exception as exc:
                logger.warning("[agentclub] http close error: {}", exc)
            self._http = None
        if self._tmp_dir and os.path.isdir(self._tmp_dir):
            try:
                for name in os.listdir(self._tmp_dir):
                    try:
                        os.remove(os.path.join(self._tmp_dir, name))
                    except OSError:
                        pass
                os.rmdir(self._tmp_dir)
            except OSError:
                pass
        self._tmp_dir = None
        logger.info("[agentclub] stopped")

    # ----------------------------------------------------------------
    # Socket.IO event wiring
    # ----------------------------------------------------------------

    def _register_sio_handlers(self, sio: socketio.AsyncClient) -> None:
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
            interval = data.get("heartbeat_interval")
            try:
                interval_val = float(interval) if interval is not None else 0.0
            except (TypeError, ValueError):
                interval_val = 0.0
            if interval_val > 0:
                self._heartbeat_interval = interval_val
            logger.info(
                "[agentclub] authenticated as {} ({}), heartbeat={}s",
                self._display_name,
                self._agent_user_id,
                self._heartbeat_interval,
            )

        @sio.on("error")
        async def _on_error(data: dict[str, Any]) -> None:
            logger.warning("[agentclub] server error: {}", data)

        @sio.on("new_message")
        async def _on_new_message(data: dict[str, Any]) -> None:
            await self._process_inbound(data)

        @sio.on("offline_messages")
        async def _on_offline_messages(msgs: list[dict[str, Any]]) -> None:
            logger.info("[agentclub] received {} offline message(s)", len(msgs))
            for msg in msgs:
                await self._process_inbound(msg)

    # ----------------------------------------------------------------
    # Inbound pipeline
    # ----------------------------------------------------------------

    async def _process_inbound(self, msg: dict[str, Any]) -> None:
        """Filter + normalize a raw ``new_message`` payload and hand to the bus."""
        try:
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
            mentions_raw = msg.get("mentions") or []
            mentions: list[str] = [m for m in mentions_raw if isinstance(m, str)]

            # Skip the agent's own echo-back
            if sender_id and sender_id == self._agent_user_id:
                return

            # Dedup — second layer of defense on top of server-side
            # mark_read. OrderedDict keeps FIFO eviction O(1).
            if message_id:
                if message_id in self._seen_message_ids:
                    # Re-ACK in case the previous ACK was lost in flight.
                    await self._ack(message_id)
                    return
                self._seen_message_ids[message_id] = None
                while len(self._seen_message_ids) > _DEDUP_CAPACITY:
                    self._seen_message_ids.popitem(last=False)

            # Access control — default-deny, with role tokens layered on
            # top of explicit user-id matches (see `_is_sender_allowed`).
            if not self._is_sender_allowed(sender_id, sender_is_agent):
                logger.info(
                    "[agentclub] denied message from {} (not in allow_from)",
                    sender_name,
                )
                await self._ack(message_id)
                return

            # Group-chat @mention gate
            mentions_bot = (
                bool(self._agent_user_id) and self._agent_user_id in mentions
            ) or ("all" in mentions)
            if (
                chat_type == "group"
                and self.config.require_mention
                and not mentions_bot
            ):
                logger.debug(
                    "[agentclub] skipping group message from {} (no @mention)",
                    sender_name,
                )
                await self._ack(message_id)
                return

            # Attachments: download to a temp file so the agent can read them
            media_paths: list[str] = []
            if file_url and content_type != "text":
                local_path = await self._download_attachment(
                    file_url, file_name or message_id or "attachment"
                )
                if local_path:
                    media_paths.append(local_path)

            # Compose the text surface. For file-only payloads we still
            # emit a description so the LLM knows *something* arrived.
            text = content
            if file_url and content_type != "text":
                label = file_name or file_url
                bracket = f"[{content_type}: {label}]"
                text = f"{text}\n{bracket}" if text else bracket

            if not text.strip() and not media_paths:
                await self._ack(message_id)
                return

            # System hint: teach the LLM about the @mention wire format
            # and (for groups) the current roster. Only injected when
            # there's something to gain (roster available or message
            # already contains tags).
            roster: list[dict[str, Any]] = []
            if chat_type == "group" and chat_id:
                roster = await self._list_group_members(chat_id)
            hint = _build_roster_hint(
                roster=roster,
                inbound_has_at_tags=_has_mention_tag(text),
                agent_user_id=self._agent_user_id,
            )
            prompt = f"{text}\n\n[System: {hint}]" if hint else text

            # Log AFTER all filter decisions so grepping logs gives an
            # honest "these are the messages that actually reached the
            # agent" answer.
            logger.info(
                "[agentclub] inbound [{}:{}] from {}: {}",
                chat_type,
                chat_id,
                sender_name,
                text[:80],
            )

            # ACK immediately on accept — "plugin has taken
            # responsibility". Matches the semantics used by the
            # OpenClaw channel and prevents reply storms when the
            # socket reconnects mid-run.
            await self._ack(message_id)

            # Stamp a chat-type prefix onto the bus-facing chat_id.
            # MessageTool inherits this as its ``default_chat_id``, and
            # it's what the LLM sees echoed back in Nanobot's Runtime-
            # Context block — so ``send()`` can recover the chat_type
            # from the id alone, statelessly, even if the LLM echoes it
            # verbatim in a tool call. Using ``gr_`` / ``pr_`` (not
            # ``group:`` / ``direct:``) keeps the form looking like an
            # opaque identifier instead of a ``key:value`` structure
            # the model might "clean up" before calling the tool.
            encoded_chat_id = _encode_chat_id(chat_type, chat_id)

            await self._handle_message(
                sender_id=sender_id,
                chat_id=encoded_chat_id,
                content=prompt,
                media=media_paths,
                metadata={
                    "message_id": message_id,
                    "chat_type": chat_type,
                    "chat_id": chat_id,
                    "sender_name": sender_name,
                    "content_type": content_type,
                    "inbound_mentions": mentions,
                    "mentioned_bot": chat_type == "direct" or mentions_bot,
                },
            )
        except Exception as exc:  # defensive: one bad message must not kill the loop
            logger.exception("[agentclub] error processing inbound: {}", exc)

    def _is_sender_allowed(self, sender_id: str, sender_is_agent: bool) -> bool:
        """Evaluate `allow_from` against a concrete sender.

        Supported tokens (may be mixed with explicit user_ids):
          - ``"*"``     → anyone
          - ``"human"`` → any non-agent sender
          - ``"agent"`` → any agent sender
          - anything else → a specific user_id

        An empty list denies everyone (default-deny, consistent with
        feishu/openclaw). Token matching is O(n) over a small list so
        we don't bother with a set cache."""
        allow_from = list(self.config.allow_from or [])
        if "*" in allow_from:
            return True
        if sender_is_agent and "agent" in allow_from:
            return True
        if not sender_is_agent and "human" in allow_from:
            return True
        return bool(sender_id) and sender_id in allow_from

    async def _ack(self, message_id: str) -> None:
        """Advance the server-side read cursor for ``message_id``.

        No-op when the id is empty or we're disconnected — the server
        will just re-deliver via ``offline_messages`` on reconnect,
        which is the desired at-least-once fallback.
        """
        if not message_id or self._sio is None or not self._sio.connected:
            return
        try:
            await self._sio.emit("mark_read", {"message_ids": [message_id]})
        except Exception as exc:
            logger.warning("[agentclub] mark_read failed for {}: {}", message_id, exc)

    # ----------------------------------------------------------------
    # Outbound pipeline
    # ----------------------------------------------------------------

    async def send(self, msg: OutboundMessage) -> None:
        """Dispatch one outbound agent message to the IM server."""
        if self._sio is None or not self._sio.connected:
            logger.warning("[agentclub] not connected; dropping outbound")
            return

        meta = msg.metadata or {}

        # We don't implement streaming yet — collapse progress / tool
        # hints / stream events to no-ops so the channel manager's
        # dispatcher doesn't spam the IM with partial text.
        if (
            meta.get("_progress")
            or meta.get("_tool_hint")
            or meta.get("_stream_delta")
            or meta.get("_stream_end")
        ):
            return

        chat_type, chat_id = self._resolve_chat_target(msg, meta)
        if not chat_id:
            logger.warning("[agentclub] outbound missing chat_id; dropping")
            return

        # Upload any attachments first. Each one becomes its own
        # ``send_message`` call so the IM UI renders file bubbles
        # separately from the reply text.
        media_paths: list[str] = list(getattr(msg, "media", None) or [])
        for path in media_paths:
            uploaded = await self._upload_attachment(path)
            if not uploaded:
                continue
            await self._emit_send_message(
                {
                    "chat_type": chat_type,
                    "chat_id": chat_id,
                    "content": "",
                    "content_type": self._guess_content_bucket(uploaded["content_type"]),
                    "file_url": uploaded["url"],
                    "file_name": uploaded["filename"],
                }
            )

        content = (msg.content or "").strip()
        if not content:
            return

        # Extract @mention user_ids from the reply text so the IM
        # server can push unread-badge updates to the mentioned users
        # without re-parsing the text itself.
        payload: dict[str, Any] = {
            "chat_type": chat_type,
            "chat_id": chat_id,
            "content": content,
            "content_type": "text",
        }
        mentions = _extract_mention_user_ids(content)
        if mentions:
            payload["mentions"] = mentions
        await self._emit_send_message(payload)

    def _resolve_chat_target(
        self, msg: OutboundMessage, meta: dict[str, Any]
    ) -> tuple[str, str]:
        """Figure out ``(chat_type, chat_id)`` for the outbound envelope.

        Resolution order:

        1. ``metadata["chat_type"]`` + ``metadata["chat_id"]`` — the
           only source ``_process_inbound`` can fully vouch for. In
           practice Nanobot's ``MessageTool`` strips metadata when
           constructing the outbound, so this path rarely hits in the
           normal LLM flow; still useful for channel-native helpers
           or hand-written call sites.
        2. ``gr_<id>`` / ``pr_<id>`` prefix on the chat_id itself. This
           is the stateless happy path: ``_process_inbound`` stamps
           every bus-facing chat_id with a prefix, so whenever the
           LLM echoes that id back via ``MessageTool`` we can recover
           the type from the id alone — no cache, no state, no worry
           about the agent replying to a chat it hasn't seen via
           inbound in this process's lifetime.
        3. Bare id — last-resort default, treated as a direct chat.
           We hit this only if something upstream constructed an
           OutboundMessage by hand without metadata or a prefix.
        """
        if meta.get("chat_type") and meta.get("chat_id"):
            return str(meta["chat_type"]), str(meta["chat_id"])

        raw = msg.chat_id or ""
        decoded = _decode_chat_id(raw)
        if decoded is not None:
            return decoded

        return "direct", raw

    async def _emit_send_message(self, payload: dict[str, Any]) -> None:
        if self._sio is None or not self._sio.connected:
            logger.warning("[agentclub] send_message skipped: not connected")
            return
        await self._sio.emit("send_message", payload)

    @staticmethod
    def _guess_content_bucket(mime: str | None) -> str:
        """Map an upload mime type to the IM ``content_type`` bucket."""
        if not mime:
            return "file"
        mime = mime.lower()
        if mime.startswith("image/"):
            return "image"
        if mime.startswith("audio/"):
            return "audio"
        if mime.startswith("video/"):
            return "video"
        return "file"

    # ----------------------------------------------------------------
    # HTTP helpers (upload / download / roster)
    # ----------------------------------------------------------------

    async def _upload_attachment(self, local_path: str) -> dict[str, Any] | None:
        """POST ``file`` to ``/api/agent/upload``; return ``{url, filename, content_type}``."""
        if self._http is None:
            return None
        path = Path(local_path)
        if not path.is_file():
            logger.warning("[agentclub] upload skipped; not a file: {}", local_path)
            return None
        url = urljoin(self._server_url + "/", "api/agent/upload")
        try:
            with path.open("rb") as fh:
                data = aiohttp.FormData()
                data.add_field(
                    "file", fh, filename=path.name, content_type="application/octet-stream"
                )
                async with self._http.post(url, data=data) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(
                            "[agentclub] upload failed HTTP {}: {}", resp.status, body[:200]
                        )
                        return None
                    return await resp.json()
        except Exception as exc:
            logger.warning("[agentclub] upload error for {}: {}", local_path, exc)
            return None

    async def _download_attachment(
        self, file_url: str, file_name: str
    ) -> str | None:
        """GET an inbound attachment URL and save it under the plugin's temp dir."""
        if not self._tmp_dir or self._http is None:
            return None
        absolute_url = (
            file_url if re.match(r"^https?://", file_url) else urljoin(self._server_url + "/", file_url.lstrip("/"))
        )
        # Sanitize filename: strip any directory component.
        safe_name = Path(file_name).name or "attachment"
        local_path = os.path.join(self._tmp_dir, safe_name)
        try:
            async with self._http.get(absolute_url) as resp:
                if resp.status != 200:
                    logger.warning(
                        "[agentclub] download failed HTTP {}: {}", resp.status, absolute_url
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
        """GET the roster for ``group_id``; empty list on any failure."""
        if self._http is None or not group_id:
            return []
        if group_id in self._roster_cache:
            return self._roster_cache[group_id]
        url = urljoin(
            self._server_url + "/", f"api/agent/groups/{group_id}/members"
        )
        try:
            async with self._http.get(url) as resp:
                if resp.status != 200:
                    logger.debug(
                        "[agentclub] listGroupMembers({}) → HTTP {}",
                        group_id,
                        resp.status,
                    )
                    return []
                data = await resp.json()
                roster = data if isinstance(data, list) else []
                self._roster_cache[group_id] = roster
                return roster
        except Exception as exc:
            logger.debug("[agentclub] listGroupMembers({}) error: {}", group_id, exc)
            return []
