import os
import sys
import json
import tempfile
import pytest

# The installed package is imported as ``agentclub``; for editable
# installs ``pip install -e .`` puts ``src/`` on sys.path, so these
# imports resolve whether or not the test suite was invoked from the
# repo root.
from agentclub import config
# Use a temp sqlite + upload dir so tests never touch the developer's
# real AGENTCLUB_HOME. Must happen BEFORE agentclub.app is imported.
_tmpdb = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
config.Config.DATABASE = _tmpdb.name
config.Config.UPLOAD_FOLDER = tempfile.mkdtemp()

from agentclub import models
from agentclub.app import app, socketio
from agentclub.auth import hash_password


@pytest.fixture(autouse=True)
def setup_db():
    # Re-pin the test DB before each test in case a previous test
    # (e.g. from test_cli.py) or a CLI bootstrap() call mutated the
    # Config class attributes.
    config.Config.DATABASE = _tmpdb.name
    config.Config.UPLOAD_FOLDER = config.Config.UPLOAD_FOLDER or tempfile.mkdtemp()
    models.init_db()
    yield
    with models.get_db_ctx() as db:
        for table in ["read_cursors", "messages", "group_members", "direct_chats", "groups", "users"]:
            db.execute(f"DELETE FROM {table}")


@pytest.fixture
def client():
    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture
def admin_client(client):
    """Client logged in as admin.

    Seeds the admin directly via ``models.create_user`` rather than going
    through ``/api/register`` because the HTTP endpoint (a) is closed by
    default (``ALLOW_REGISTRATION=False``) and (b) only ever mints
    ``role=user`` — admins are a CLI/bootstrap concern. Then we ``POST
    /api/login`` to materialize the session cookie the tests will ride.
    """
    models.create_user(
        "admin1", hash_password("admin123"), "Admin", role="admin"
    )
    client.post("/api/login", json={"username": "admin1", "password": "admin123"})
    return client


@pytest.fixture
def user_client():
    """A second client logged in as regular user. Same seeding rationale
    as ``admin_client``: skip the registration gate, insert directly."""
    app.config["TESTING"] = True
    c = app.test_client()
    # Seed an admin too so role-based tests have the full cast available.
    models.create_user(
        "admin_pre", hash_password("admin123"), "Admin", role="admin"
    )
    models.create_user(
        "user1", hash_password("user123"), "User1", role="user"
    )
    c.post("/api/login", json={"username": "user1", "password": "user123"})
    return c


# ── Auth Tests ──

class TestAuth:
    def test_register_blocked_by_default(self, client):
        # ``ALLOW_REGISTRATION`` defaults to False — the endpoint is
        # closed even on an empty db. The only way to get the very
        # first account in is via the CLI (``agentclub onboard``).
        res = client.post("/api/register", json={
            "username": "first", "password": "password123"
        })
        assert res.status_code == 403

    def test_register_works_when_flag_enabled(self, client, monkeypatch):
        monkeypatch.setattr(config.Config, "ALLOW_REGISTRATION", True)
        res = client.post("/api/register", json={
            "username": "first", "password": "password123"
        })
        assert res.status_code == 201
        data = res.get_json()
        # Even when registration is open, the web endpoint refuses to
        # mint admins — preserves the invariant that admin creation is
        # an explicit, out-of-band operation.
        assert data["role"] == "user"
        assert data["username"] == "first"

    def test_register_duplicate_username(self, client, monkeypatch):
        monkeypatch.setattr(config.Config, "ALLOW_REGISTRATION", True)
        client.post("/api/register", json={"username": "dup", "password": "password123"})
        c2 = app.test_client()
        res = c2.post("/api/register", json={"username": "dup", "password": "other123"})
        assert res.status_code == 409

    def test_register_validation(self, client, monkeypatch):
        monkeypatch.setattr(config.Config, "ALLOW_REGISTRATION", True)
        res = client.post("/api/register", json={"username": "", "password": "123456"})
        assert res.status_code == 400
        res = client.post("/api/register", json={"username": "ok", "password": "12"})
        assert res.status_code == 400

    def test_registration_status_reflects_flag(self, client, monkeypatch):
        # Closed by default, no empty-db special case any more.
        monkeypatch.setattr(config.Config, "ALLOW_REGISTRATION", False)
        res = client.get("/api/registration-status")
        assert res.get_json() == {"allow_registration": False}
        monkeypatch.setattr(config.Config, "ALLOW_REGISTRATION", True)
        res = client.get("/api/registration-status")
        assert res.get_json() == {"allow_registration": True}

    def test_login_success(self, client):
        # Seed via models so we exercise /api/login in isolation from
        # the (separately-gated) /api/register endpoint.
        models.create_user("logintest", hash_password("password123"), "logintest", role="user")
        c2 = app.test_client()
        res = c2.post("/api/login", json={"username": "logintest", "password": "password123"})
        assert res.status_code == 200
        assert res.get_json()["username"] == "logintest"

    def test_login_wrong_password(self, client):
        models.create_user("logintest", hash_password("password123"), "logintest", role="user")
        c2 = app.test_client()
        res = c2.post("/api/login", json={"username": "logintest", "password": "wrong"})
        assert res.status_code == 401

    def test_me_authenticated(self, admin_client):
        res = admin_client.get("/api/me")
        assert res.status_code == 200
        assert res.get_json()["username"] == "admin1"

    def test_me_unauthenticated(self, client):
        res = client.get("/api/me")
        assert res.status_code == 401

    def test_logout(self, admin_client):
        res = admin_client.post("/api/logout")
        assert res.status_code == 200
        res = admin_client.get("/api/me")
        assert res.status_code == 401


# ── Agent Tests ──

class TestAgents:
    def test_create_agent(self, admin_client):
        res = admin_client.post("/api/agents", json={
            "username": "bot1", "display_name": "Bot One"
        })
        assert res.status_code == 201
        data = res.get_json()
        assert data["is_agent"] == 1
        assert "agent_token" in data

    def test_create_agent_requires_admin(self, user_client):
        res = user_client.post("/api/agents", json={
            "username": "bot2", "display_name": "Bot Two"
        })
        assert res.status_code == 403

    def test_list_agents(self, admin_client):
        admin_client.post("/api/agents", json={"username": "bot_a", "display_name": "A"})
        admin_client.post("/api/agents", json={"username": "bot_b", "display_name": "B"})
        res = admin_client.get("/api/agents")
        assert res.status_code == 200
        assert len(res.get_json()) == 2


# ── Group Tests ──

class TestGroups:
    def test_create_group(self, admin_client):
        res = admin_client.post("/api/groups", json={"name": "Test Group"})
        assert res.status_code == 201
        data = res.get_json()
        assert data["name"] == "Test Group"

    def test_list_groups(self, admin_client):
        admin_client.post("/api/groups", json={"name": "G1"})
        admin_client.post("/api/groups", json={"name": "G2"})
        res = admin_client.get("/api/groups")
        assert res.status_code == 200
        assert len(res.get_json()) == 2

    def test_add_member(self, admin_client):
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]
        # Create agent to add
        ares = admin_client.post("/api/agents", json={"username": "bot1"})
        aid = ares.get_json()["id"]
        res = admin_client.post(f"/api/groups/{gid}/members", json={"user_id": aid})
        assert res.status_code == 200
        # Check members
        res = admin_client.get(f"/api/groups/{gid}/members")
        members = res.get_json()
        assert len(members) == 2  # admin + bot

    def test_remove_member(self, admin_client):
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]
        ares = admin_client.post("/api/agents", json={"username": "bot1"})
        aid = ares.get_json()["id"]
        admin_client.post(f"/api/groups/{gid}/members", json={"user_id": aid})
        res = admin_client.delete(f"/api/groups/{gid}/members/{aid}")
        assert res.status_code == 200
        members = admin_client.get(f"/api/groups/{gid}/members").get_json()
        assert len(members) == 1


# ── Message Tests ──

class TestMessages:
    def test_save_and_get_messages(self, admin_client):
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]
        user = admin_client.get("/api/me").get_json()

        # Save some messages via model directly
        for i in range(5):
            models.save_message("group", gid, user["id"], f"msg {i}")

        res = admin_client.get(f"/api/messages/group/{gid}")
        assert res.status_code == 200
        msgs = res.get_json()
        assert len(msgs) == 5
        assert msgs[0]["content"] == "msg 0"

    def test_message_pagination(self, admin_client):
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]
        user = admin_client.get("/api/me").get_json()

        for i in range(10):
            models.save_message("group", gid, user["id"], f"msg {i}")

        res = admin_client.get(f"/api/messages/group/{gid}?limit=3")
        msgs = res.get_json()
        assert len(msgs) == 3
        # Should be the latest 3 messages
        assert msgs[-1]["content"] == "msg 9"

        # Load older
        before = msgs[0]["created_at"]
        res = admin_client.get(f"/api/messages/group/{gid}?limit=3&before={before}")
        older = res.get_json()
        assert len(older) == 3


# ── Socket.IO Tests ──

class TestSocketIO:
    def test_web_user_connect(self, admin_client):
        sio_client = socketio.test_client(app, flask_test_client=admin_client)
        assert sio_client.is_connected()
        received = sio_client.get_received()
        events = [r["name"] for r in received]
        assert "auth_ok" in events
        sio_client.disconnect()

    def test_agent_connect(self, admin_client):
        # Create agent
        res = admin_client.post("/api/agents", json={"username": "bot1"})
        token = res.get_json()["agent_token"]

        # Connect as agent
        sio_client = socketio.test_client(app, auth={"agent_token": token})
        assert sio_client.is_connected()
        received = sio_client.get_received()
        events = [r["name"] for r in received]
        assert "auth_ok" in events
        auth_data = next(r["args"][0] for r in received if r["name"] == "auth_ok")
        assert auth_data["is_agent"] == 1
        sio_client.disconnect()

    def test_agent_connect_bad_token(self):
        sio_client = socketio.test_client(app, auth={"agent_token": "invalid"})
        assert not sio_client.is_connected()

    def test_send_message_in_group(self, admin_client):
        # Create group
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]

        sio_client = socketio.test_client(app, flask_test_client=admin_client)
        sio_client.get_received()  # clear initial events

        sio_client.emit("join_chat", {"chat_type": "group", "chat_id": gid})
        sio_client.emit("send_message", {
            "chat_type": "group",
            "chat_id": gid,
            "content": "Hello world",
            "content_type": "text",
        })

        received = sio_client.get_received()
        msg_events = [r for r in received if r["name"] == "new_message"]
        assert len(msg_events) == 1
        assert msg_events[0]["args"][0]["content"] == "Hello world"
        sio_client.disconnect()

    def test_agent_send_message(self, admin_client):
        # Setup: create group + agent + add agent to group
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]
        ares = admin_client.post("/api/agents", json={"username": "bot1"})
        agent = ares.get_json()
        admin_client.post(f"/api/groups/{gid}/members", json={"user_id": agent["id"]})

        # Connect admin to listen
        admin_sio = socketio.test_client(app, flask_test_client=admin_client)
        admin_sio.emit("join_chat", {"chat_type": "group", "chat_id": gid})
        admin_sio.get_received()  # clear

        # Connect agent and send message
        agent_sio = socketio.test_client(app, auth={"agent_token": agent["agent_token"]})
        agent_sio.get_received()  # clear
        agent_sio.emit("send_message", {
            "chat_type": "group",
            "chat_id": gid,
            "content": "I am a bot",
            "content_type": "text",
        })

        # Admin should receive the message
        received = admin_sio.get_received()
        msg_events = [r for r in received if r["name"] == "new_message"]
        assert len(msg_events) == 1
        assert msg_events[0]["args"][0]["content"] == "I am a bot"
        assert msg_events[0]["args"][0]["sender_is_agent"] == 1

        admin_sio.disconnect()
        agent_sio.disconnect()

    def test_agent_receives_group_message_when_added_after_connect(self, admin_client):
        """Regression: an agent connected before being added to a group used
        to silently miss every subsequent broadcast because it was never
        placed into the ``group_{id}`` Socket.IO room. Group broadcast now
        fans out off ``group_members``, not room membership, so the order
        of connect vs. add-to-group no longer matters."""
        gres = admin_client.post("/api/groups", json={"name": "LateJoin"})
        gid = gres.get_json()["id"]
        ares = admin_client.post("/api/agents", json={"username": "latebot"})
        agent = ares.get_json()

        # Agent connects FIRST, while it is not yet a group member.
        agent_sio = socketio.test_client(app, auth={"agent_token": agent["agent_token"]})
        agent_sio.get_received()  # clear connect-time events

        # Then the agent gets added to the group. In production this used to
        # route through the HTTP endpoint's best-effort ``enter_room`` which
        # didn't reliably land for already-connected agents.
        admin_client.post(f"/api/groups/{gid}/members", json={"user_id": agent["id"]})
        agent_sio.get_received()  # drop any chat_list_updated noise

        # Admin sends a message into the group.
        admin_sio = socketio.test_client(app, flask_test_client=admin_client)
        admin_sio.emit("send_message", {
            "chat_type": "group",
            "chat_id": gid,
            "content": "hello bot",
            "content_type": "text",
        })

        received = agent_sio.get_received()
        msg_events = [r for r in received if r["name"] == "new_message"]
        assert len(msg_events) == 1, f"agent did not receive group message; got {received!r}"
        assert msg_events[0]["args"][0]["content"] == "hello bot"

        agent_sio.disconnect()
        admin_sio.disconnect()

    def test_typing_indicator(self, admin_client):
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]

        # Create second user directly — /api/register is closed by default.
        c2 = app.test_client()
        models.create_user("user2", hash_password("pass123"), "user2", role="user")
        u2 = models.get_user_by_username("user2")
        if u2:
            models.add_group_member(gid, u2["id"])

            c2.post("/api/login", json={"username": "user2", "password": "pass123"})
            sio1 = socketio.test_client(app, flask_test_client=admin_client)
            sio2 = socketio.test_client(app, flask_test_client=c2)

            sio1.emit("join_chat", {"chat_type": "group", "chat_id": gid})
            sio2.emit("join_chat", {"chat_type": "group", "chat_id": gid})
            sio1.get_received()
            sio2.get_received()

            sio2.emit("typing", {"chat_type": "group", "chat_id": gid})
            received = sio1.get_received()
            typing_events = [r for r in received if r["name"] == "typing"]
            assert len(typing_events) >= 1

            sio1.disconnect()
            sio2.disconnect()


# ── File Upload Tests ──

class TestFileUpload:
    def test_upload_image(self, admin_client):
        import io
        data = {
            "file": (io.BytesIO(b"fake image data"), "test.png"),
        }
        res = admin_client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert res.status_code == 200
        result = res.get_json()
        assert result["content_type"] == "image"
        assert result["url"].startswith("/media/uploads/")

    def test_upload_requires_auth(self, client):
        import io
        data = {"file": (io.BytesIO(b"data"), "test.png")}
        res = client.post("/api/upload", data=data, content_type="multipart/form-data")
        assert res.status_code == 401

    def test_agent_upload(self, admin_client):
        import io
        # Create agent
        res = admin_client.post("/api/agents", json={"username": "bot1"})
        token = res.get_json()["agent_token"]

        c = app.test_client()
        data = {"file": (io.BytesIO(b"audio data"), "voice.mp3")}
        res = c.post("/api/agent/upload", data=data, content_type="multipart/form-data",
                      headers={"Authorization": f"Bearer {token}"})
        assert res.status_code == 200
        assert res.get_json()["content_type"] == "audio"


# ── Permission / IDOR Tests ──
#
# These cover the "anyone with a leaked chat_id can write/read it" hole
# that used to exist before `can_access_chat` gated every write/read path.
# The chat_id is a UUID so not trivially guessable, but we still must not
# rely on obscurity as the only defence — a group roster export, a leaked
# URL, or a compromised member's browser history can all surface it.


class TestChatPermissions:
    @staticmethod
    def _logged_in_client(username, password):
        """Create a user directly in the DB and inject a Flask session for them.

        We bypass ``/api/register`` because that endpoint is closed by
        default (``Config.ALLOW_REGISTRATION`` defaults to False and
        never mints admins) and we only need a legitimately-logged-in
        outsider for the permission checks. Forge the session directly.
        """
        uid = models.create_user(username, hash_password(password), username.title())
        c = app.test_client()
        with c.session_transaction() as sess:
            sess["user_id"] = uid
        return c

    def _setup_outsider_and_chat(self, admin_client):
        """Create (alice, bob) direct chat + an outsider 'mallory' not in it.

        Returns ``(direct_chat_id, mallory_client, mallory_agent_token)``.
        """
        # Admin creates the direct chat's two parties (admin_client is Alice).
        alice = admin_client.get("/api/me").get_json()
        bob_id = models.create_user("bob", hash_password("bobpass"), "Bob")
        direct = models.get_or_create_direct_chat(alice["id"], bob_id)

        # Outsider: a second regular human + an agent owned by nobody relevant.
        mallory_client = self._logged_in_client("mallory", "malpass")
        agent_res = admin_client.post("/api/agents", json={"username": "snoopbot"})
        agent_token = agent_res.get_json()["agent_token"]

        return direct["id"], mallory_client, agent_token

    def _setup_outsider_and_group(self, admin_client):
        """Create group with (alice, bob) + an outsider not in it."""
        alice = admin_client.get("/api/me").get_json()
        bob_id = models.create_user("bob", hash_password("bobpass"), "Bob")
        gid = models.create_group("Private", alice["id"])
        models.add_group_member(gid, bob_id)

        mallory_client = self._logged_in_client("mallory", "malpass")
        agent_res = admin_client.post("/api/agents", json={"username": "snoopbot"})
        agent_token = agent_res.get_json()["agent_token"]

        return gid, mallory_client, agent_token

    # -- can_access_chat helper -------------------------------------------

    def test_can_access_chat_group(self):
        owner = models.create_user("u1", hash_password("pw"), "U1")
        outsider = models.create_user("u2", hash_password("pw"), "U2")
        gid = models.create_group("G", owner)
        assert models.can_access_chat("group", gid, owner) is True
        assert models.can_access_chat("group", gid, outsider) is False

    def test_can_access_chat_direct(self):
        u1 = models.create_user("u1", hash_password("pw"), "U1")
        u2 = models.create_user("u2", hash_password("pw"), "U2")
        u3 = models.create_user("u3", hash_password("pw"), "U3")
        chat = models.get_or_create_direct_chat(u1, u2)
        assert models.can_access_chat("direct", chat["id"], u1) is True
        assert models.can_access_chat("direct", chat["id"], u2) is True
        assert models.can_access_chat("direct", chat["id"], u3) is False

    def test_can_access_chat_unknown_type_denies(self):
        u1 = models.create_user("u1", hash_password("pw"), "U1")
        assert models.can_access_chat("bogus", "whatever", u1) is False

    # -- Socket send_message ---------------------------------------------

    def test_socket_direct_send_rejects_non_participant(self, admin_client):
        chat_id, mallory_client, _ = self._setup_outsider_and_chat(admin_client)
        sio = socketio.test_client(app, flask_test_client=mallory_client)
        sio.get_received()
        sio.emit(
            "send_message",
            {
                "chat_type": "direct",
                "chat_id": chat_id,
                "content": "pwned",
                "content_type": "text",
            },
        )
        received = sio.get_received()
        # Must get an error, NOT a new_message — the write must not have landed.
        errors = [r for r in received if r["name"] == "error"]
        msgs = [r for r in received if r["name"] == "new_message"]
        assert errors, "expected an error event, got: {!r}".format(received)
        assert not msgs
        # And the DB must be untouched for this chat.
        assert models.get_messages("direct", chat_id) == []
        sio.disconnect()

    def test_socket_agent_direct_send_rejects_non_participant(self, admin_client):
        chat_id, _, agent_token = self._setup_outsider_and_chat(admin_client)
        agent_sio = socketio.test_client(app, auth={"agent_token": agent_token})
        agent_sio.get_received()
        agent_sio.emit(
            "send_message",
            {
                "chat_type": "direct",
                "chat_id": chat_id,
                "content": "agent pwn",
                "content_type": "text",
            },
        )
        received = agent_sio.get_received()
        assert any(r["name"] == "error" for r in received)
        assert not any(r["name"] == "new_message" for r in received)
        assert models.get_messages("direct", chat_id) == []
        agent_sio.disconnect()

    def test_socket_group_send_rejects_non_member_agent(self, admin_client):
        gid, _, agent_token = self._setup_outsider_and_group(admin_client)
        agent_sio = socketio.test_client(app, auth={"agent_token": agent_token})
        agent_sio.get_received()
        agent_sio.emit(
            "send_message",
            {
                "chat_type": "group",
                "chat_id": gid,
                "content": "agent pwn",
                "content_type": "text",
            },
        )
        received = agent_sio.get_received()
        assert any(r["name"] == "error" for r in received)
        assert models.get_messages("group", gid) == []
        agent_sio.disconnect()

    # -- HTTP GET /api/messages/<type>/<id> ------------------------------

    def test_http_read_direct_history_rejects_non_participant(self, admin_client):
        chat_id, mallory_client, _ = self._setup_outsider_and_chat(admin_client)
        res = mallory_client.get(f"/api/messages/direct/{chat_id}")
        assert res.status_code == 403

    def test_http_read_group_history_rejects_non_member(self, admin_client):
        gid, mallory_client, _ = self._setup_outsider_and_group(admin_client)
        res = mallory_client.get(f"/api/messages/group/{gid}")
        assert res.status_code == 403

    def test_http_read_history_allows_participant(self, admin_client):
        alice = admin_client.get("/api/me").get_json()
        bob_id = models.create_user("bob", hash_password("pw"), "Bob")
        chat = models.get_or_create_direct_chat(alice["id"], bob_id)
        res = admin_client.get(f"/api/messages/direct/{chat['id']}")
        assert res.status_code == 200

    # -- HTTP GET /api/agent/messages/<type>/<id> ------------------------

    def test_agent_http_read_direct_history_rejects_non_participant(self, admin_client):
        chat_id, _, agent_token = self._setup_outsider_and_chat(admin_client)
        c = app.test_client()
        res = c.get(
            f"/api/agent/messages/direct/{chat_id}",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert res.status_code == 403

    def test_agent_http_read_group_history_rejects_non_member(self, admin_client):
        gid, _, agent_token = self._setup_outsider_and_group(admin_client)
        c = app.test_client()
        res = c.get(
            f"/api/agent/messages/group/{gid}",
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert res.status_code == 403

    def test_agent_http_read_allows_participant(self, admin_client):
        """Sanity: the gate only blocks outsiders, not legitimate members."""
        alice = admin_client.get("/api/me").get_json()
        gid = models.create_group("G", alice["id"])
        agent_res = admin_client.post("/api/agents", json={"username": "friendly"})
        agent = agent_res.get_json()
        admin_client.post(f"/api/groups/{gid}/members", json={"user_id": agent["id"]})

        c = app.test_client()
        res = c.get(
            f"/api/agent/messages/group/{gid}",
            headers={"Authorization": f"Bearer {agent['agent_token']}"},
        )
        assert res.status_code == 200


# ── Model Tests ──

class TestModels:
    def test_unread_read_cursor(self):
        """Read cursor model: unread = messages after the cursor by others.

        - Joining a chat does not flag history as unread.
        - Marking read by message id advances per-chat cursor.
        - Own messages never appear in the user's own unread.
        """
        uid = models.create_user("u1", hash_password("pass"), "User1")
        uid2 = models.create_user("u2", hash_password("pass"), "User2")
        gid = models.create_group("G1", uid)
        models.add_group_member(gid, uid2)

        m1 = models.save_message("group", gid, uid, "hello")
        m2 = models.save_message("group", gid, uid, "world")
        m3 = models.save_message("group", gid, uid2, "reply")

        unread = models.get_unread_messages(uid2)
        assert [m["content"] for m in unread] == ["hello", "world"]
        counts = models.get_unread_counts(uid2)
        assert counts.get(f"group_{gid}") == 2

        # uid sees only uid2's reply as unread
        assert [m["content"] for m in models.get_unread_messages(uid)] == ["reply"]

        # Advance uid2's cursor up to m1 → only "world" remains unread
        models.mark_read_up_to_messages(uid2, [m1["id"]])
        assert [m["content"] for m in models.get_unread_messages(uid2)] == ["world"]

        # Bulk clear by chat → everything read
        models.clear_unread(uid2, "group", gid)
        assert models.get_unread_messages(uid2) == []
        assert models.get_unread_counts(uid2).get(f"group_{gid}") is None

        # Future message is unread again
        m4 = models.save_message("group", gid, uid, "again")
        assert [m["content"] for m in models.get_unread_messages(uid2)] == ["again"]

    def test_direct_chat(self):
        uid1 = models.create_user("u1", hash_password("pass"), "User1")
        uid2 = models.create_user("u2", hash_password("pass"), "User2")

        chat = models.get_or_create_direct_chat(uid1, uid2)
        assert chat["id"]

        chat2 = models.get_or_create_direct_chat(uid2, uid1)
        assert chat2["id"] == chat["id"]  # same chat regardless of order

    def test_presence_derived_from_last_active_at(self):
        """`is_online` is a pure function of `last_active_at` + ACTIVE_TIMEOUT.
        No stored flag, no sweeper — bumping `touch_active` flips a user to
        online; letting it go stale flips them back to offline."""
        import time as _time
        uid = models.create_user("presence_u", hash_password("pass"), "P")

        # Fresh user has never been active → offline.
        assert models.get_user_by_id(uid)["is_online"] == 0

        models.touch_active(uid)
        assert models.get_user_by_id(uid)["is_online"] == 1

        # Forge a stale `last_active_at` and re-check via the snapshot API.
        with models.get_db_ctx() as db:
            db.execute(
                "UPDATE users SET last_active_at = ? WHERE id = ?",
                (_time.time() - config.Config.ACTIVE_TIMEOUT - 10, uid),
            )
        snap = models.get_presence_snapshot([uid])
        assert snap == [
            {"user_id": uid, "is_online": 0, "last_active_at": snap[0]["last_active_at"]}
        ]

    def test_presence_endpoint_defaults_to_direct_chat_peers(self, admin_client):
        """`GET /api/presence` without args returns one entry per direct-chat
        peer — group members are intentionally NOT included."""
        # Admin + two peers, one via direct chat, one only via a shared group.
        admin = admin_client.get("/api/me").get_json()
        direct_peer = models.create_user("dp", hash_password("pass"), "DirectPeer")
        group_only = models.create_user("gp", hash_password("pass"), "GroupOnly")
        gid = models.create_group("G", admin["id"])
        models.add_group_member(gid, group_only)
        models.get_or_create_direct_chat(admin["id"], direct_peer)

        res = admin_client.get("/api/presence")
        assert res.status_code == 200
        ids = {r["user_id"] for r in res.get_json()}
        assert ids == {direct_peer}

        # Explicit user_ids broadens the scope.
        res = admin_client.get(f"/api/presence?user_ids={direct_peer},{group_only}")
        ids = {r["user_id"] for r in res.get_json()}
        assert ids == {direct_peer, group_only}

    def test_migration_from_legacy_is_online_schema(self):
        """Startup migration renames `last_seen` → `last_active_at` and drops
        `is_online`. We simulate the legacy table on a fresh DB file to make
        sure upgrade-in-place works (and online state survives the rename)."""
        import sqlite3, tempfile, time as _time, os as _os
        # Build a v1-style DB in a temp file.
        tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        tmp.close()
        conn = sqlite3.connect(tmp.name)
        conn.executescript("""
            CREATE TABLE users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT,
                display_name TEXT NOT NULL,
                avatar TEXT DEFAULT '',
                role TEXT DEFAULT 'user',
                is_agent INTEGER DEFAULT 0,
                agent_token TEXT UNIQUE,
                is_online INTEGER DEFAULT 0,
                last_seen REAL,
                created_at REAL NOT NULL
            );
        """)
        now = _time.time()
        conn.execute(
            "INSERT INTO users (id, username, password_hash, display_name, "
            "role, is_online, last_seen, created_at) "
            "VALUES ('u1', 'u1', 'x', 'U1', 'user', 1, ?, ?)",
            (now, now),
        )
        conn.commit()
        conn.close()

        prev_db = config.Config.DATABASE
        config.Config.DATABASE = tmp.name
        try:
            models.init_db()
            user = models.get_user_by_id("u1")
            assert user is not None
            assert user["is_online"] == 1  # derived from the renamed column
            assert "last_active_at" in user
            # Legacy columns are gone.
            db = models.get_db()
            cols = {r["name"] for r in db.execute("PRAGMA table_info(users)").fetchall()}
            db.close()
            assert "is_online" not in cols
            assert "last_seen" not in cols
            assert "last_active_at" in cols
        finally:
            config.Config.DATABASE = prev_db
            _os.unlink(tmp.name)

    def test_cleanup_old_messages(self):
        uid = models.create_user("u1", hash_password("pass"), "User1")
        gid = models.create_group("G1", uid)

        # Create an old message
        import time
        old_ts = time.time() - 100 * 86400  # 100 days ago
        with models.get_db_ctx() as db:
            db.execute(
                "INSERT INTO messages (id, chat_type, chat_id, sender_id, content, content_type, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("old_msg", "group", gid, uid, "old", "text", old_ts),
            )

        models.save_message("group", gid, uid, "new")

        models.cleanup_old_messages(30)

        msgs = models.get_messages("group", gid)
        assert len(msgs) == 1
        assert msgs[0]["content"] == "new"
