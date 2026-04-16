"""Unit tests for AgentClubChannel (no real nanobot dependency)."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Provide minimal stubs so channel.py can be imported without nanobot
import sys
from types import ModuleType


# -- Stub nanobot modules before importing the channel -----------------------

_bus_events = ModuleType("nanobot.bus.events")


@dataclass
class OutboundMessage:
    channel: str = ""
    chat_id: str = ""
    content: str = ""
    media: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


_bus_events.OutboundMessage = OutboundMessage  # type: ignore[attr-defined]
_bus_events.InboundMessage = type("InboundMessage", (), {})  # type: ignore[attr-defined]

_bus = ModuleType("nanobot.bus")
_nanobot = ModuleType("nanobot")
_channels = ModuleType("nanobot.channels")

sys.modules.setdefault("nanobot", _nanobot)
sys.modules.setdefault("nanobot.bus", _bus)
sys.modules.setdefault("nanobot.bus.events", _bus_events)
sys.modules.setdefault("nanobot.channels", _channels)


class _FakeBaseChannel:
    """Minimal BaseChannel stand-in for testing."""

    def __init__(self, config: dict[str, Any], bus: Any) -> None:
        self.config = config
        self.bus = bus
        self._running = False

    async def _handle_message(self, **kwargs: Any) -> None:
        self.bus._last_inbound = kwargs

    def is_allowed(self, sender_id: str) -> bool:
        allow = self.config.get("allow_from", [])
        if not allow:
            return False
        if "*" in allow:
            return True
        return sender_id in allow


_base_mod = ModuleType("nanobot.channels.base")
_base_mod.BaseChannel = _FakeBaseChannel  # type: ignore[attr-defined]
sys.modules.setdefault("nanobot.channels.base", _base_mod)

# Now import the channel implementation
from nanobot_channel_agent_club.channel import AgentClubChannel  # noqa: E402


# -- Helpers -----------------------------------------------------------------

def _make_channel(**config_overrides: Any) -> AgentClubChannel:
    cfg: dict[str, Any] = {
        "enabled": True,
        "server_url": "http://test-server:5555",
        "agent_token": "test-token-abc",
        "require_mention": True,
        "allow_from": ["*"],
    }
    cfg.update(config_overrides)
    bus = MagicMock()
    bus._last_inbound = None
    ch = AgentClubChannel(cfg, bus)
    ch._agent_user_id = "agent-42"
    ch._agent_display_name = "TestBot"
    return ch


def _make_msg(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "msg-1",
        "chat_type": "direct",
        "chat_id": "chat-1",
        "sender_id": "user-1",
        "sender_name": "Alice",
        "sender_avatar": "",
        "sender_is_agent": False,
        "content": "Hello bot",
        "content_type": "text",
        "file_url": "",
        "file_name": "",
        "mentions": [],
        "created_at": 1700000000.0,
    }
    base.update(overrides)
    return base


# -- Tests -------------------------------------------------------------------


class TestParseCompositeId:
    def test_direct(self) -> None:
        assert AgentClubChannel._parse_chat_id("direct:abc") == ("direct", "abc")

    def test_group(self) -> None:
        assert AgentClubChannel._parse_chat_id("group:xyz") == ("group", "xyz")

    def test_unknown_type_falls_back(self) -> None:
        assert AgentClubChannel._parse_chat_id("unknown:id") == ("direct", "unknown:id")

    def test_no_colon_falls_back(self) -> None:
        assert AgentClubChannel._parse_chat_id("plain-id") == ("direct", "plain-id")

    def test_id_with_colons(self) -> None:
        assert AgentClubChannel._parse_chat_id("group:id:with:colons") == (
            "group",
            "id:with:colons",
        )


class TestDefaultConfig:
    def test_has_required_keys(self) -> None:
        cfg = AgentClubChannel.default_config()
        assert "server_url" in cfg
        assert "agent_token" in cfg
        assert cfg["enabled"] is False


class TestProcessInbound:
    @pytest.mark.asyncio
    async def test_forwards_direct_message(self) -> None:
        ch = _make_channel()
        await ch._process_inbound(_make_msg())
        inbound = ch.bus._last_inbound
        assert inbound is not None
        assert inbound["content"] == "Hello bot"
        assert inbound["chat_id"] == "direct:chat-1"
        assert inbound["sender_id"] == "user-1"

    @pytest.mark.asyncio
    async def test_skips_own_message(self) -> None:
        ch = _make_channel()
        await ch._process_inbound(_make_msg(sender_id="agent-42"))
        assert ch.bus._last_inbound is None

    @pytest.mark.asyncio
    async def test_skips_group_without_mention(self) -> None:
        ch = _make_channel(require_mention=True)
        await ch._process_inbound(
            _make_msg(chat_type="group", mentions=[])
        )
        assert ch.bus._last_inbound is None

    @pytest.mark.asyncio
    async def test_forwards_group_with_mention(self) -> None:
        ch = _make_channel(require_mention=True)
        await ch._process_inbound(
            _make_msg(chat_type="group", mentions=["agent-42"])
        )
        inbound = ch.bus._last_inbound
        assert inbound is not None
        assert inbound["chat_id"] == "group:chat-1"

    @pytest.mark.asyncio
    async def test_forwards_group_without_mention_when_disabled(self) -> None:
        ch = _make_channel(require_mention=False)
        await ch._process_inbound(
            _make_msg(chat_type="group", mentions=[])
        )
        assert ch.bus._last_inbound is not None

    @pytest.mark.asyncio
    async def test_skips_empty_content(self) -> None:
        ch = _make_channel()
        await ch._process_inbound(_make_msg(content="", file_url=""))
        assert ch.bus._last_inbound is None

    @pytest.mark.asyncio
    async def test_image_adds_description(self) -> None:
        ch = _make_channel()
        await ch._process_inbound(
            _make_msg(
                content="",
                content_type="image",
                file_url="/static/uploads/photo.png",
                file_name="photo.png",
            )
        )
        inbound = ch.bus._last_inbound
        assert inbound is not None
        assert "[image: photo.png]" in inbound["content"]


class TestSend:
    @pytest.mark.asyncio
    async def test_send_text(self) -> None:
        ch = _make_channel()
        sio = AsyncMock()
        sio.connected = True
        ch._sio = sio

        msg = OutboundMessage(
            channel="agent_club",
            chat_id="group:chat-99",
            content="Hi there!",
        )
        await ch.send(msg)

        sio.emit.assert_called_once_with("send_message", {
            "chat_type": "group",
            "chat_id": "chat-99",
            "content": "Hi there!",
            "content_type": "text",
        })

    @pytest.mark.asyncio
    async def test_send_skips_when_disconnected(self) -> None:
        ch = _make_channel()
        ch._sio = None

        msg = OutboundMessage(
            channel="agent_club",
            chat_id="direct:chat-1",
            content="Should not send",
        )
        await ch.send(msg)  # should not raise

    @pytest.mark.asyncio
    async def test_send_skips_progress_metadata(self) -> None:
        ch = _make_channel()
        sio = AsyncMock()
        sio.connected = True
        ch._sio = sio

        msg = OutboundMessage(
            channel="agent_club",
            chat_id="direct:chat-1",
            content="typing...",
            metadata={"_progress": True},
        )
        await ch.send(msg)
        sio.emit.assert_not_called()

    @pytest.mark.asyncio
    async def test_send_no_chat_id(self) -> None:
        ch = _make_channel()
        sio = AsyncMock()
        sio.connected = True
        ch._sio = sio

        msg = OutboundMessage(channel="agent_club", content="no target")
        await ch.send(msg)
        sio.emit.assert_not_called()
