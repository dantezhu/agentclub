"""Unit tests for the Agent Club nanobot channel.

The tests deliberately avoid spinning up a real Socket.IO connection;
every seam that reaches the network (``_sio`` + ``_http``) is replaced
with an ``AsyncMock`` so the behaviours we care about — filtering,
ACK semantics, @mention wiring — can be asserted deterministically.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanobot.bus.events import OutboundMessage

from nanobot_channel_agentclub.channel import (
    AgentClubChannel,
    AgentClubConfig,
    _build_roster_hint,
    _extract_mention_user_ids,
    _has_mention_tag,
)


# ---------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------


class TestMentionHelpers:
    def test_extract_ids_returns_unique_user_ids_in_order(self):
        text = (
            'hello <at user_id="u1">Alice</at> and '
            '<at user_id="u2">Bob</at> and again '
            '<at user_id="u1">Alice</at>'
        )
        assert _extract_mention_user_ids(text) == ["u1", "u2"]

    def test_extract_ids_empty_on_no_tags(self):
        assert _extract_mention_user_ids("plain text") == []
        assert _extract_mention_user_ids("") == []

    def test_extract_ids_supports_at_all(self):
        assert _extract_mention_user_ids('<at user_id="all">room</at>') == ["all"]

    def test_has_mention_tag(self):
        assert _has_mention_tag('<at user_id="u1">a</at>') is True
        assert _has_mention_tag("nope") is False


class TestRosterHint:
    def test_no_hint_when_nothing_to_teach(self):
        assert _build_roster_hint([], inbound_has_at_tags=False, agent_user_id="u1") is None

    def test_hint_includes_self_marker(self):
        roster = [
            {"id": "u1", "display_name": "Me", "is_agent": True},
            {"id": "u2", "display_name": "Bob", "is_agent": False},
        ]
        hint = _build_roster_hint(roster, inbound_has_at_tags=False, agent_user_id="u1")
        assert hint is not None
        assert "(you)" in hint
        assert 'user_id="u1"' in hint
        assert 'user_id="u2"' in hint

    def test_hint_emitted_when_inbound_has_tags_even_without_roster(self):
        hint = _build_roster_hint([], inbound_has_at_tags=True, agent_user_id="u1")
        assert hint is not None
        assert "mention tags" in hint.lower()


# ---------------------------------------------------------------------
# Channel fixture
# ---------------------------------------------------------------------


@pytest.fixture
def channel(monkeypatch):
    """Return an ``AgentClubChannel`` ready for behaviour tests.

    The socket is pre-connected (``_sio.connected = True``) with an
    ``emit`` spy so tests can assert what was sent, and the HTTP
    session + dedup cache start empty. ``bus.publish_inbound`` is also
    spied so we can assert whether a message was forwarded.
    """
    monkeypatch.delenv("AGENTCLUB_SERVER_URL", raising=False)
    monkeypatch.delenv("AGENTCLUB_AGENT_TOKEN", raising=False)

    cfg = AgentClubConfig(
        enabled=True,
        server_url="http://localhost:5555",
        agent_token="tok",
        allow_from=["*"],
        allow_from_kind=["*"],
        require_mention=True,
    )
    bus = MagicMock()
    bus.publish_inbound = AsyncMock()

    ch = AgentClubChannel(cfg, bus)
    ch._agent_user_id = "agent-self"
    ch._display_name = "Agent"

    sio = MagicMock()
    sio.connected = True
    sio.emit = AsyncMock()
    ch._sio = sio

    ch._http = MagicMock()
    return ch


def _inbound(**overrides):
    """Build a minimal ``new_message`` payload matching the IM server protocol."""
    msg = {
        "id": "m1",
        "chat_type": "direct",
        "chat_id": "chat-x",
        "sender_id": "user-a",
        "sender_name": "Alice",
        "content": "hello",
        "content_type": "text",
        "file_url": "",
        "file_name": "",
        "mentions": [],
        "created_at": 1700000000,
    }
    msg.update(overrides)
    return msg


# ---------------------------------------------------------------------
# Inbound behaviour
# ---------------------------------------------------------------------


class TestInboundFiltering:
    @pytest.mark.asyncio
    async def test_forwards_direct_message_to_bus(self, channel):
        await channel._process_inbound(_inbound())
        channel.bus.publish_inbound.assert_awaited_once()
        envelope = channel.bus.publish_inbound.await_args.args[0]
        assert envelope.channel == "agentclub"
        assert envelope.sender_id == "user-a"
        # Direct chats get a ``pr_`` prefix so the LLM sees an opaque
        # identifier in Runtime-Context (not a ``key:value`` it might
        # rewrite). ``send()`` strips the prefix before hitting the wire.
        assert envelope.chat_id == "pr_chat-x"

    @pytest.mark.asyncio
    async def test_group_inbound_uses_gr_prefix(self, channel):
        """Regression: a bare UUID chat_id left the LLM with no way to
        distinguish group from direct, and a ``group:`` prefix was
        actively rewritten to a bare UUID by the model when it saw
        ``<at user_id="...">`` and tried to "clean up" structured ids.
        ``gr_<id>`` looks like an opaque identifier so the model leaves
        it alone — matching Feishu's ``oc_``/``ou_`` convention."""
        channel._list_group_members = AsyncMock(return_value=[])
        await channel._process_inbound(
            _inbound(chat_type="group", chat_id="grp-42", mentions=["all"])
        )
        envelope = channel.bus.publish_inbound.await_args.args[0]
        assert envelope.chat_id == "gr_grp-42"

    @pytest.mark.asyncio
    async def test_direct_messages_bypass_require_mention(self, channel):
        """require_mention is a group-only filter — DMs always pass."""
        channel.config.require_mention = True
        await channel._process_inbound(_inbound(chat_type="direct"))
        channel.bus.publish_inbound.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_self_messages_ignored(self, channel):
        """Agent's own echo-back from the server must not re-trigger the agent."""
        await channel._process_inbound(_inbound(sender_id="agent-self"))
        channel.bus.publish_inbound.assert_not_awaited()
        # No ACK either — the server won't have marked it as unread for us.
        channel._sio.emit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_duplicate_message_id_deduped_and_reacked(self, channel):
        first = _inbound(id="dup")
        await channel._process_inbound(first)
        channel.bus.publish_inbound.reset_mock()
        channel._sio.emit.reset_mock()

        # Second delivery of same id → consumed silently but ACK resent
        await channel._process_inbound(_inbound(id="dup"))
        channel.bus.publish_inbound.assert_not_awaited()
        emits = [c.args for c in channel._sio.emit.await_args_list]
        assert ("mark_read", {"message_ids": ["dup"]}) in emits

    @pytest.mark.asyncio
    async def test_allow_from_denies_unknown_sender(self, channel):
        channel.config.allow_from = ["user-b"]
        await channel._process_inbound(_inbound(sender_id="user-a"))
        channel.bus.publish_inbound.assert_not_awaited()
        channel._sio.emit.assert_awaited_with("mark_read", {"message_ids": ["m1"]})

    @pytest.mark.asyncio
    async def test_empty_allow_from_denies_everyone(self, channel):
        """Default-deny: an empty allow_from rejects all senders (security default)."""
        channel.config.allow_from = []
        await channel._process_inbound(_inbound(sender_id="user-a"))
        channel.bus.publish_inbound.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_allow_from_kind_denies_everyone(self, channel):
        """Default-deny for the role filter: `[]` rejects every kind."""
        channel.config.allow_from = ["*"]
        channel.config.allow_from_kind = []
        await channel._process_inbound(
            _inbound(sender_id="user-a", sender_is_agent=False)
        )
        channel.bus.publish_inbound.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_allow_from_kind_human_accepts_only_humans(self, channel):
        channel.config.allow_from = ["*"]
        channel.config.allow_from_kind = ["human"]

        await channel._process_inbound(
            _inbound(id="m-h", sender_id="user-a", sender_is_agent=False)
        )
        channel.bus.publish_inbound.assert_awaited_once()
        channel.bus.publish_inbound.reset_mock()

        await channel._process_inbound(
            _inbound(id="m-a", sender_id="bot-x", sender_is_agent=True)
        )
        channel.bus.publish_inbound.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_allow_from_kind_agent_accepts_only_agents(self, channel):
        channel.config.allow_from = ["*"]
        channel.config.allow_from_kind = ["agent"]

        await channel._process_inbound(
            _inbound(id="m-a", sender_id="bot-x", sender_is_agent=True)
        )
        channel.bus.publish_inbound.assert_awaited_once()
        channel.bus.publish_inbound.reset_mock()

        await channel._process_inbound(
            _inbound(id="m-h", sender_id="user-a", sender_is_agent=False)
        )
        channel.bus.publish_inbound.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_allow_from_intersects_with_allow_from_kind(self, channel):
        """Both filters must pass — intersection, not union."""
        # Whitelist two ids; limit kind to agents only. Only the agent
        # id should get through; the human id is vetoed by kind filter.
        channel.config.allow_from = ["user-a", "bot-allowed"]
        channel.config.allow_from_kind = ["agent"]

        await channel._process_inbound(
            _inbound(id="h1", sender_id="user-a", sender_is_agent=False)
        )
        channel.bus.publish_inbound.assert_not_awaited()

        await channel._process_inbound(
            _inbound(id="a1", sender_id="bot-allowed", sender_is_agent=True)
        )
        channel.bus.publish_inbound.assert_awaited_once()

        channel.bus.publish_inbound.reset_mock()
        # Agent not in allow_from — id filter vetoes even though kind passes.
        await channel._process_inbound(
            _inbound(id="a2", sender_id="bot-other", sender_is_agent=True)
        )
        channel.bus.publish_inbound.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_group_requires_mention_by_default(self, channel):
        """In groups, messages without @agent and without @all are dropped."""
        await channel._process_inbound(
            _inbound(chat_type="group", chat_id="grp-1", mentions=[])
        )
        channel.bus.publish_inbound.assert_not_awaited()
        channel._sio.emit.assert_awaited_with("mark_read", {"message_ids": ["m1"]})

    @pytest.mark.asyncio
    async def test_group_mention_of_bot_passes(self, channel):
        channel._list_group_members = AsyncMock(return_value=[])
        await channel._process_inbound(
            _inbound(chat_type="group", chat_id="grp-1", mentions=["agent-self"])
        )
        channel.bus.publish_inbound.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_group_mention_all_passes(self, channel):
        channel._list_group_members = AsyncMock(return_value=[])
        await channel._process_inbound(
            _inbound(chat_type="group", chat_id="grp-1", mentions=["all"])
        )
        channel.bus.publish_inbound.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_require_mention_off_accepts_all_group_messages(self, channel):
        channel.config.require_mention = False
        channel._list_group_members = AsyncMock(return_value=[])
        await channel._process_inbound(
            _inbound(chat_type="group", chat_id="grp-1", mentions=[])
        )
        channel.bus.publish_inbound.assert_awaited_once()


class TestConfigValidation:
    """Pydantic-level validation on the config schema itself."""

    def test_allow_from_kind_defaults_to_empty_list(self):
        cfg = AgentClubConfig()
        assert cfg.allow_from_kind == []

    def test_allow_from_kind_accepts_valid_tokens(self):
        cfg = AgentClubConfig(allow_from_kind=["*", "human", "agent"])
        assert cfg.allow_from_kind == ["*", "human", "agent"]

    def test_allow_from_kind_rejects_invalid_token(self):
        """Typos / unknown roles must fail loud at load time."""
        import pydantic

        with pytest.raises(pydantic.ValidationError) as excinfo:
            AgentClubConfig(allow_from_kind=["human", "admin"])
        msg = str(excinfo.value)
        assert "allow_from_kind" in msg
        assert "admin" in msg


class TestInboundMarkRead:
    @pytest.mark.asyncio
    async def test_accepted_messages_are_marked_read(self, channel):
        await channel._process_inbound(_inbound(id="m-ok"))
        channel._sio.emit.assert_any_await("mark_read", {"message_ids": ["m-ok"]})

    @pytest.mark.asyncio
    async def test_ack_skipped_when_disconnected(self, channel):
        channel._sio.connected = False
        await channel._process_inbound(_inbound(id="m-ok"))
        channel._sio.emit.assert_not_awaited()


class TestRosterHintInjection:
    @pytest.mark.asyncio
    async def test_group_message_gets_roster_hint_appended(self, channel):
        channel.config.require_mention = False
        channel._list_group_members = AsyncMock(
            return_value=[
                {"id": "agent-self", "display_name": "Bot", "is_agent": True},
                {"id": "user-a", "display_name": "Alice", "is_agent": False},
            ]
        )
        await channel._process_inbound(
            _inbound(chat_type="group", chat_id="grp-1", content="hi team")
        )
        envelope = channel.bus.publish_inbound.await_args.args[0]
        assert "hi team" in envelope.content
        assert "[System:" in envelope.content
        assert "Alice" in envelope.content
        assert "(you)" in envelope.content

    @pytest.mark.asyncio
    async def test_direct_message_gets_no_hint_when_no_at_tags(self, channel):
        await channel._process_inbound(_inbound(content="plain hello"))
        envelope = channel.bus.publish_inbound.await_args.args[0]
        assert envelope.content == "plain hello"

    @pytest.mark.asyncio
    async def test_direct_message_with_at_tag_gets_hint(self, channel):
        await channel._process_inbound(
            _inbound(content='hi <at user_id="agent-self">Bot</at>')
        )
        envelope = channel.bus.publish_inbound.await_args.args[0]
        assert "[System:" in envelope.content


# ---------------------------------------------------------------------
# Outbound behaviour
# ---------------------------------------------------------------------


class TestOutbound:
    @pytest.mark.asyncio
    async def test_send_uses_metadata_chat_target(self, channel):
        outbound = OutboundMessage(
            channel="agentclub",
            chat_id="ignored",
            content="hello back",
            metadata={"chat_type": "group", "chat_id": "grp-7"},
        )
        await channel.send(outbound)
        channel._sio.emit.assert_awaited_once_with(
            "send_message",
            {
                "chat_type": "group",
                "chat_id": "grp-7",
                "content": "hello back",
                "content_type": "text",
            },
        )

    @pytest.mark.asyncio
    async def test_send_decodes_gr_prefix(self, channel):
        """The common LLM path: MessageTool forwards ``default_chat_id``
        (already prefixed at inbound time) straight through. ``send()``
        must strip ``gr_`` and route to the right group — including
        when the reply carries an @-mention, the exact shape that broke
        in production with the old ``group:`` prefix."""
        outbound = OutboundMessage(
            channel="agentclub",
            chat_id="gr_grp-9",
            content='<at user_id="user-b">Bob</at> hi',
        )
        await channel.send(outbound)

        payload = channel._sio.emit.await_args.args[1]
        assert payload["chat_type"] == "group"
        assert payload["chat_id"] == "grp-9"
        assert payload["mentions"] == ["user-b"]

    @pytest.mark.asyncio
    async def test_send_decodes_pr_prefix(self, channel):
        """Same round-trip for direct chats: ``pr_<id>`` in, ``direct`` +
        bare id out."""
        outbound = OutboundMessage(
            channel="agentclub", chat_id="pr_chat-1", content="hi"
        )
        await channel.send(outbound)
        payload = channel._sio.emit.await_args.args[1]
        assert payload["chat_type"] == "direct"
        assert payload["chat_id"] == "chat-1"

    @pytest.mark.asyncio
    async def test_send_extracts_mentions_from_at_tags(self, channel):
        outbound = OutboundMessage(
            channel="agentclub",
            chat_id="grp-1",
            content='sure <at user_id="u-1">Alice</at> and <at user_id="u-2">Bob</at>',
            metadata={"chat_type": "group", "chat_id": "grp-1"},
        )
        await channel.send(outbound)
        payload = channel._sio.emit.await_args.args[1]
        assert payload["mentions"] == ["u-1", "u-2"]

    @pytest.mark.asyncio
    async def test_send_omits_mentions_field_when_no_tags(self, channel):
        outbound = OutboundMessage(
            channel="agentclub",
            chat_id="pr_chat-1",
            content="thanks!",
        )
        await channel.send(outbound)
        payload = channel._sio.emit.await_args.args[1]
        assert "mentions" not in payload

    @pytest.mark.asyncio
    async def test_send_skips_progress_and_tool_hints(self, channel):
        """Until streaming is implemented, progress chunks mustn't leak to IM."""
        for flag in ("_progress", "_tool_hint", "_stream_delta", "_stream_end"):
            channel._sio.emit.reset_mock()
            outbound = OutboundMessage(
                channel="agentclub",
                chat_id="pr_chat-1",
                content="partial",
                metadata={flag: True},
            )
            await channel.send(outbound)
            channel._sio.emit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_send_noop_when_disconnected(self, channel):
        channel._sio.connected = False
        outbound = OutboundMessage(
            channel="agentclub", chat_id="pr_chat-1", content="hi"
        )
        await channel.send(outbound)
        channel._sio.emit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_send_uploads_media_then_text(self, channel, tmp_path):
        """Attachments go first as file messages; reply text follows as a second message."""
        fpath = tmp_path / "note.txt"
        fpath.write_text("hi")

        channel._upload_attachment = AsyncMock(
            return_value={
                "url": "/media/uploads/abc_note.txt",
                "filename": "note.txt",
                "content_type": "text/plain",
            }
        )

        outbound = OutboundMessage(
            channel="agentclub",
            chat_id="pr_chat-1",
            content="see attached",
            media=[str(fpath)],
        )
        await channel.send(outbound)

        emits = [call.args for call in channel._sio.emit.await_args_list]
        assert len(emits) == 2
        # First: file bubble with URL + filename, no text
        assert emits[0][0] == "send_message"
        assert emits[0][1]["content"] == ""
        assert emits[0][1]["file_url"] == "/media/uploads/abc_note.txt"
        assert emits[0][1]["file_name"] == "note.txt"
        # Second: text bubble
        assert emits[1][1]["content"] == "see attached"

    def test_guess_content_bucket(self):
        assert AgentClubChannel._guess_content_bucket("image/png") == "image"
        assert AgentClubChannel._guess_content_bucket("audio/mpeg") == "audio"
        assert AgentClubChannel._guess_content_bucket("video/mp4") == "video"
        assert AgentClubChannel._guess_content_bucket("application/pdf") == "file"
        assert AgentClubChannel._guess_content_bucket("") == "file"


# ---------------------------------------------------------------------
# Config / defaults
# ---------------------------------------------------------------------


class TestConfig:
    def test_default_config_is_default_deny(self):
        defaults = AgentClubChannel.default_config()
        assert defaults["enabled"] is False
        # Empty allow_from → deny all. Matches feishu / openclaw defaults
        # so new deployments can't accidentally expose the agent.
        assert defaults["allow_from"] == []
        assert defaults["require_mention"] is True

    def test_env_vars_override_json(self, monkeypatch):
        monkeypatch.setenv("AGENTCLUB_SERVER_URL", "http://env-host:5555")
        monkeypatch.setenv("AGENTCLUB_AGENT_TOKEN", "env-tok")
        cfg = AgentClubConfig(server_url="http://file-host", agent_token="file-tok")
        bus = MagicMock()
        ch = AgentClubChannel(cfg, bus)
        assert ch._server_url == "http://env-host:5555"
        assert ch._agent_token == "env-tok"
