from __future__ import annotations

import asyncio
import sys
import types
import os
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


class Platform:
    def __init__(self, value: str):
        self.value = value

    def __hash__(self):
        return hash(self.value)

    def __eq__(self, other):
        return getattr(other, "value", other) == self.value


class MessageType(Enum):
    TEXT = "text"
    PHOTO = "photo"
    VIDEO = "video"
    AUDIO = "audio"
    DOCUMENT = "document"


@dataclass
class MessageEvent:
    text: str
    message_type: MessageType = MessageType.TEXT
    source: object | None = None
    raw_message: object | None = None
    message_id: str | None = None
    media_urls: list[str] = field(default_factory=list)
    media_types: list[str] = field(default_factory=list)
    timestamp: object | None = None


@dataclass
class SendResult:
    success: bool
    message_id: str | None = None
    error: str | None = None
    retryable: bool = False


class BasePlatformAdapter:
    def __init__(self, config, platform):
        self.config = config
        self.platform = platform
        self._running = False
        self.handled_events = []
        self._fatal_error = None

    def _mark_connected(self):
        self._running = True

    def _mark_disconnected(self):
        self._running = False

    def _set_fatal_error(self, code, message, *, retryable):
        self._fatal_error = (code, message, retryable)
        self._running = False

    @property
    def has_fatal_error(self):
        return self._fatal_error is not None

    def _acquire_platform_lock(self, scope, identity, resource_desc):
        return True

    def _release_platform_lock(self):
        return None

    def build_source(self, **kwargs):
        return SimpleNamespace(platform=self.platform, **kwargs)

    async def handle_message(self, event):
        self.handled_events.append(event)


gateway_mod = types.ModuleType("gateway")
config_mod = types.ModuleType("gateway.config")
config_mod.Platform = Platform
base_mod = types.ModuleType("gateway.platforms.base")
base_mod.BasePlatformAdapter = BasePlatformAdapter
base_mod.MessageEvent = MessageEvent
base_mod.MessageType = MessageType
base_mod.SendResult = SendResult
platforms_mod = types.ModuleType("gateway.platforms")
sys.modules.setdefault("gateway", gateway_mod)
sys.modules.setdefault("gateway.config", config_mod)
sys.modules.setdefault("gateway.platforms", platforms_mod)
sys.modules.setdefault("gateway.platforms.base", base_mod)


from hermes_channel_agentclub.adapter import (  # noqa: E402
    AgentClubAdapter,
    _apply_yaml_config,
    _decode_chat_id,
    _extract_mention_user_ids,
    _normalize_upload_content_type,
    register,
)
import hermes_channel_agentclub.adapter as adapter_mod  # noqa: E402
import hermes_channel_agentclub as pkg  # noqa: E402


def _config(**extra):
    defaults = {
        "server_url": "http://localhost:5555",
        "agent_token": "tok",
        "allow_from": ["*"],
        "allow_from_kind": ["*"],
        "require_mention": True,
    }
    defaults.update(extra)
    return SimpleNamespace(extra=defaults)


@pytest.fixture
def adapter(monkeypatch):
    for name in (
        "AGENTCLUB_SERVER_URL",
        "AGENTCLUB_AGENT_TOKEN",
        "AGENTCLUB_ALLOW_FROM",
    ):
        monkeypatch.delenv(name, raising=False)
    ad = AgentClubAdapter(_config())
    ad._agent_user_id = "agent-self"
    ad._sio = SimpleNamespace(connected=True, emit=AsyncMock())
    return ad


def _inbound(**overrides):
    msg = {
        "id": "msg-1",
        "chat_type": "direct",
        "chat_id": "dc_chat-1",
        "sender_id": "user-a",
        "sender_name": "Alice",
        "sender_is_agent": False,
        "content": "hello",
        "content_type": "text",
        "file_url": "",
        "file_name": "",
        "mentions": [],
        "created_at": 1700000000,
    }
    msg.update(overrides)
    return msg


def run(coro):
    return asyncio.run(coro)


class TestHelpers:
    def test_package_exposes_version(self):
        assert isinstance(pkg.__version__, str)
        assert pkg.__version__

    def test_decode_chat_id(self):
        assert _decode_chat_id("gc_room") == ("group", "gc_room")
        assert _decode_chat_id("dc_room") == ("direct", "dc_room")
        assert _decode_chat_id("room") is None

    def test_extract_mentions_unique_in_order(self):
        text = '<at user_id="u1">A</at> <at user_id="u2">B</at> <at user_id="u1">A</at>'
        assert _extract_mention_user_ids(text) == ["u1", "u2"]

    def test_normalize_upload_content_type(self):
        assert _normalize_upload_content_type("image/png") == "image"
        assert _normalize_upload_content_type("audio") == "audio"
        assert _normalize_upload_content_type("video/mp4") == "video"
        assert _normalize_upload_content_type("application/pdf") == "file"
        assert _normalize_upload_content_type(None) == "file"


class TestInbound:
    def test_direct_message_forwards_and_acks(self, adapter):
        run(adapter._process_inbound(_inbound()))

        adapter._sio.emit.assert_any_await("mark_read", {"message_ids": ["msg-1"]})
        assert len(adapter.handled_events) == 1
        event = adapter.handled_events[0]
        assert event.text == "hello"
        assert event.source.chat_type == "dm"
        assert event.source.chat_id == "dc_chat-1"
        assert event.source.user_id == "user-a"

    def test_ack_failure_logs_warning(self, adapter, monkeypatch):
        warnings = []
        adapter._sio.emit = AsyncMock(side_effect=RuntimeError("boom"))
        monkeypatch.setattr(
            adapter_mod.logger,
            "warning",
            lambda *args, **kwargs: warnings.append((args, kwargs)),
        )

        run(adapter._ack("msg-1"))

        assert warnings
        assert warnings[0][0][:2] == (
            "[agentclub] mark_read failed for {}: {}",
            "msg-1",
        )

    def test_group_requires_mention(self, adapter):
        run(
            adapter._process_inbound(
                _inbound(chat_type="group", chat_id="gc_room", mentions=[])
            )
        )

        assert adapter.handled_events == []
        adapter._sio.emit.assert_awaited_with("mark_read", {"message_ids": ["msg-1"]})

    def test_group_mention_passes_with_roster_hint(self, adapter):
        adapter._list_group_members = AsyncMock(
            return_value=[
                {"id": "agent-self", "display_name": "Bot", "is_agent": True},
                {"id": "user-a", "display_name": "Alice", "is_agent": False},
            ]
        )

        run(
            adapter._process_inbound(
                _inbound(chat_type="group", chat_id="gc_room", mentions=["agent-self"])
            )
        )

        assert len(adapter.handled_events) == 1
        assert "[System:" in adapter.handled_events[0].text
        assert 'user_id="user-a"' in adapter.handled_events[0].text

    def test_duplicate_is_deduped_and_reacked(self, adapter):
        run(adapter._process_inbound(_inbound(id="dup")))
        adapter.handled_events.clear()
        adapter._sio.emit.reset_mock()

        run(adapter._process_inbound(_inbound(id="dup")))

        assert adapter.handled_events == []
        adapter._sio.emit.assert_awaited_once_with("mark_read", {"message_ids": ["dup"]})

    def test_allow_from_kind_denies_and_acks(self, adapter):
        adapter.allow_from_kind = ["human"]

        run(
            adapter._process_inbound(
                _inbound(sender_id="bot-a", sender_is_agent=True)
            )
        )

        assert adapter.handled_events == []
        adapter._sio.emit.assert_awaited_once_with("mark_read", {"message_ids": ["msg-1"]})


class TestOutbound:
    def test_send_text_extracts_mentions(self, adapter):
        result = run(
            adapter.send(
                "gc_room",
                '<at user_id="u1">Alice</at> hi',
            )
        )

        assert result.success is True
        adapter._sio.emit.assert_awaited_once_with(
            "send_message",
            {
                "chat_type": "group",
                "chat_id": "gc_room",
                "content": '<at user_id="u1">Alice</at> hi',
                "content_type": "text",
                "mentions": ["u1"],
            },
        )

    def test_send_rejects_unprefixed_chat_id(self, adapter):
        result = run(adapter.send("room", "hi"))

        assert result.success is False
        assert "gc_ or dc_" in result.error

    def test_send_document_uploads_file_message(self, adapter):
        adapter._upload_attachment = AsyncMock(
            return_value={
                "url": "/media/uploads/doc.txt",
                "filename": "doc.txt",
                "content_type": "file",
            }
        )

        result = run(
            adapter.send_document(
                "dc_chat-1",
                "/tmp/doc.txt",
                caption='<at user_id="u1">Alice</at> see file',
            )
        )

        assert result.success is True
        payload = adapter._sio.emit.await_args.args[1]
        assert payload["chat_type"] == "direct"
        assert payload["content_type"] == "file"
        assert payload["file_url"] == "/media/uploads/doc.txt"
        assert payload["mentions"] == ["u1"]


class TestConfigBridge:
    def test_apply_yaml_config_sets_env_for_hermes_auth(self, monkeypatch):
        for name in (
            "AGENTCLUB_SERVER_URL",
            "AGENTCLUB_AGENT_TOKEN",
            "AGENTCLUB_ALLOW_FROM",
        ):
            monkeypatch.delenv(name, raising=False)

        extra = _apply_yaml_config(
            {},
            {
                "enabled": True,
                "server_url": "http://server",
                "agent_token": "tok",
                "allow_from": ["*"],
                "allow_from_kind": ["human"],
                "require_mention": False,
            },
        )

        assert extra["server_url"] == "http://server"
        assert os.environ["AGENTCLUB_SERVER_URL"] == "http://server"
        assert os.environ["AGENTCLUB_AGENT_TOKEN"] == "tok"
        assert os.environ["AGENTCLUB_ALLOW_FROM"] == "*"
        assert "AGENTCLUB_ALLOW_FROM_KIND" not in os.environ
        assert "AGENTCLUB_REQUIRE_MENTION" not in os.environ

    def test_register_uses_platform_auth_env(self):
        class Ctx:
            def __init__(self):
                self.kwargs = None

            def register_platform(self, **kwargs):
                self.kwargs = kwargs

        ctx = Ctx()
        register(ctx)

        assert ctx.kwargs["name"] == "agentclub"
        assert ctx.kwargs["allowed_users_env"] == "AGENTCLUB_ALLOW_FROM"
        assert "allow_all_env" not in ctx.kwargs
