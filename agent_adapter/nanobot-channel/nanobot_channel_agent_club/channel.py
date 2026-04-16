"""
Nanobot channel plugin for Agent Club IM.

Connects to the Agent Club IM server over Socket.IO, receives messages
from users/groups, and sends AI-generated replies back.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import aiohttp
import socketio
from loguru import logger

try:
    from nanobot.channels.base import BaseChannel
    from nanobot.bus.events import OutboundMessage
except ImportError:
    # Allow importing outside nanobot for testing
    BaseChannel = object  # type: ignore[assignment,misc]
    OutboundMessage = None  # type: ignore[assignment,misc]


class AgentClubChannel(BaseChannel):  # type: ignore[misc]
    """Nanobot ↔ Agent Club IM bridge via Socket.IO."""

    name = "agent_club"
    display_name = "Agent Club"

    def __init__(self, config: dict[str, Any], bus: Any) -> None:
        super().__init__(config, bus)
        self._sio: socketio.AsyncClient | None = None
        self._agent_user_id: str | None = None
        self._agent_display_name: str | None = None
        self._http_session: aiohttp.ClientSession | None = None

    # -- Config --------------------------------------------------------------

    @classmethod
    def default_config(cls) -> dict[str, Any]:
        return {
            "enabled": False,
            "server_url": "http://localhost:5555",
            "agent_token": "",
            "require_mention": True,
            "allow_from": ["*"],
            "streaming": False,
        }

    @property
    def _server_url(self) -> str:
        return (
            self.config.get("server_url")
            or os.environ.get("AGENT_CLUB_SERVER_URL")
            or "http://localhost:5555"
        )

    @property
    def _agent_token(self) -> str:
        return (
            self.config.get("agent_token")
            or os.environ.get("AGENT_CLUB_AGENT_TOKEN")
            or ""
        )

    @property
    def _require_mention(self) -> bool:
        return self.config.get("require_mention", True)

    # -- Lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        """Connect to the IM server and block until stop() is called."""
        if not self._agent_token:
            logger.error("[agent_club] agent_token is not configured")
            return

        self._running = True
        self._sio = socketio.AsyncClient(
            reconnection=True,
            reconnection_delay=1,
            reconnection_delay_max=30,
        )
        self._register_handlers()

        logger.info("[agent_club] Connecting to {}", self._server_url)
        await self._sio.connect(
            self._server_url,
            auth={"agent_token": self._agent_token},
            transports=["websocket", "polling"],
        )

        while self._running:
            await asyncio.sleep(1)

        if self._sio and self._sio.connected:
            await self._sio.disconnect()
        if self._http_session and not self._http_session.closed:
            await self._http_session.close()

        logger.info("[agent_club] Channel stopped")

    async def stop(self) -> None:
        self._running = False

    # -- Outbound (AI → IM) --------------------------------------------------

    async def send(self, msg: Any) -> None:
        """Send an OutboundMessage to the Agent Club IM server."""
        if not self._sio or not self._sio.connected:
            logger.warning("[agent_club] Not connected, dropping outbound message")
            return

        # Skip progress/tool-hint metadata messages
        metadata = getattr(msg, "metadata", {}) or {}
        if metadata.get("_progress") or metadata.get("_tool_hint"):
            return

        chat_id = getattr(msg, "chat_id", None)
        content = getattr(msg, "content", "") or ""
        media_list: list[str] = getattr(msg, "media", []) or []

        if not chat_id:
            logger.warning("[agent_club] OutboundMessage has no chat_id")
            return

        chat_type, resolved_chat_id = self._parse_chat_id(chat_id)

        # Upload and send media files
        for file_path in media_list:
            try:
                upload = await self._upload_file(file_path)
                await self._sio.emit("send_message", {
                    "chat_type": chat_type,
                    "chat_id": resolved_chat_id,
                    "content": "",
                    "content_type": upload["content_type"],
                    "file_url": upload["url"],
                    "file_name": upload["filename"],
                })
            except Exception:
                logger.exception("[agent_club] Failed to upload {}", file_path)

        # Send text content
        if content.strip():
            await self._sio.emit("send_message", {
                "chat_type": chat_type,
                "chat_id": resolved_chat_id,
                "content": content,
                "content_type": "text",
            })
            logger.info(
                "[agent_club] Sent [{}:{}]: {}",
                chat_type,
                resolved_chat_id[:8],
                content[:80],
            )

    # -- Socket.IO event handlers --------------------------------------------

    def _register_handlers(self) -> None:
        sio = self._sio
        assert sio is not None

        @sio.on("auth_ok")
        async def on_auth_ok(data: dict[str, Any]) -> None:
            self._agent_user_id = data["user_id"]
            self._agent_display_name = data.get("display_name", "")
            logger.info(
                "[agent_club] Authenticated as {} ({})",
                self._agent_display_name,
                self._agent_user_id,
            )

        @sio.on("new_message")
        async def on_new_message(data: dict[str, Any]) -> None:
            await self._process_inbound(data)

        @sio.on("offline_messages")
        async def on_offline_messages(msgs: list[dict[str, Any]]) -> None:
            logger.info("[agent_club] Received {} offline message(s)", len(msgs))
            for msg in msgs:
                await self._process_inbound(msg)

        @sio.on("error")
        async def on_error(data: dict[str, Any]) -> None:
            logger.error("[agent_club] Server error: {}", data.get("message"))

        @sio.on("connect")
        async def on_connect() -> None:
            logger.info("[agent_club] Socket.IO connected")

        @sio.on("disconnect")
        async def on_disconnect() -> None:
            logger.warning("[agent_club] Socket.IO disconnected")

    # -- Inbound (IM → Agent) ------------------------------------------------

    async def _process_inbound(self, data: dict[str, Any]) -> None:
        """Filter and forward an incoming IM message to the nanobot agent."""
        sender_id = data.get("sender_id", "")

        # Never process our own messages
        if sender_id == self._agent_user_id:
            return

        chat_type = data.get("chat_type", "direct")
        chat_id = data.get("chat_id", "")
        content = data.get("content", "")
        content_type = data.get("content_type", "text")
        mentions: list[str] = data.get("mentions", [])

        # Group mention filter
        if chat_type == "group" and self._require_mention:
            if self._agent_user_id not in mentions:
                return

        # Build text for non-text content
        if content_type != "text" and data.get("file_url"):
            label = data.get("file_name") or data.get("file_url", "")
            file_desc = f"[{content_type}: {label}]"
            content = f"{content}\n{file_desc}" if content else file_desc

        if not content.strip():
            return

        # Compose the chat_id nanobot uses (includes type prefix for routing)
        composite_chat_id = f"{chat_type}:{chat_id}"

        sender_name = data.get("sender_name", sender_id)
        logger.info(
            "[agent_club] Inbound [{}:{}] from {}: {}",
            chat_type,
            chat_id[:8],
            sender_name,
            content[:80],
        )

        # Download media files for the agent
        media: list[str] = []
        if data.get("file_url") and content_type in ("image", "audio", "video", "file"):
            try:
                local_path = await self._download_file(data["file_url"])
                if local_path:
                    media.append(local_path)
            except Exception:
                logger.exception("[agent_club] Failed to download {}", data.get("file_url"))

        await self._handle_message(
            sender_id=sender_id,
            chat_id=composite_chat_id,
            content=content,
            media=media,
            metadata={
                "sender_name": sender_name,
                "chat_type": chat_type,
                "raw_chat_id": chat_id,
            },
        )

    # -- Helpers -------------------------------------------------------------

    @staticmethod
    def _parse_chat_id(composite: str) -> tuple[str, str]:
        """Split 'type:id' back into (chat_type, chat_id)."""
        if ":" in composite:
            chat_type, chat_id = composite.split(":", 1)
            if chat_type in ("group", "direct"):
                return chat_type, chat_id
        return "direct", composite

    async def _get_http_session(self) -> aiohttp.ClientSession:
        if self._http_session is None or self._http_session.closed:
            self._http_session = aiohttp.ClientSession()
        return self._http_session

    async def _upload_file(self, file_path: str) -> dict[str, str]:
        """Upload a local file to the IM server via agent upload API."""
        session = await self._get_http_session()
        url = f"{self._server_url}/api/agent/upload"
        headers = {"Authorization": f"Bearer {self._agent_token}"}

        data = aiohttp.FormData()
        data.add_field(
            "file",
            open(file_path, "rb"),  # noqa: SIM115
            filename=os.path.basename(file_path),
        )

        async with session.post(url, headers=headers, data=data) as resp:
            resp.raise_for_status()
            return await resp.json()

    async def _download_file(self, file_url: str) -> str | None:
        """Download a file from the IM server to a temp location."""
        if not file_url:
            return None

        # file_url is a relative path like /static/uploads/xxx
        full_url = f"{self._server_url}{file_url}"
        session = await self._get_http_session()

        async with session.get(full_url) as resp:
            if resp.status != 200:
                return None
            filename = file_url.rsplit("/", 1)[-1]
            import tempfile
            tmp_dir = tempfile.mkdtemp(prefix="agent_club_")
            tmp_path = os.path.join(tmp_dir, filename)
            with open(tmp_path, "wb") as f:
                f.write(await resp.read())
            return tmp_path
