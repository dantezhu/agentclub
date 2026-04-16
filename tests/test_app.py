import os
import sys
import json
import tempfile
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
# Use temp db for tests
_tmpdb = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
config.Config.DATABASE = _tmpdb.name
config.Config.UPLOAD_FOLDER = tempfile.mkdtemp()

import models
from app import app, socketio
from auth import hash_password


@pytest.fixture(autouse=True)
def setup_db():
    models.init_db()
    yield
    # Clean tables after each test
    with models.get_db_ctx() as db:
        for table in ["unread_messages", "messages", "group_members", "direct_chats", "groups", "users"]:
            db.execute(f"DELETE FROM {table}")


@pytest.fixture
def client():
    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture
def admin_client(client):
    """Client logged in as admin."""
    client.post("/api/register", json={
        "username": "admin1", "password": "admin123", "display_name": "Admin"
    })
    return client


@pytest.fixture
def user_client():
    """A second client logged in as regular user."""
    app.config["TESTING"] = True
    c = app.test_client()
    # Create admin first
    c2 = app.test_client()
    c2.post("/api/register", json={"username": "admin_pre", "password": "admin123"})
    # Now create regular user
    c.post("/api/register", json={"username": "user1", "password": "user123", "display_name": "User1"})
    return c


# ── Auth Tests ──

class TestAuth:
    def test_register_first_user_is_admin(self, client):
        res = client.post("/api/register", json={
            "username": "first", "password": "password123"
        })
        assert res.status_code == 201
        data = res.get_json()
        assert data["role"] == "admin"
        assert data["username"] == "first"

    def test_register_second_user_is_regular(self, client):
        client.post("/api/register", json={"username": "first", "password": "password123"})
        c2 = app.test_client()
        res = c2.post("/api/register", json={"username": "second", "password": "password123"})
        assert res.status_code == 201
        assert res.get_json()["role"] == "user"

    def test_register_duplicate_username(self, client):
        client.post("/api/register", json={"username": "dup", "password": "password123"})
        c2 = app.test_client()
        res = c2.post("/api/register", json={"username": "dup", "password": "other123"})
        assert res.status_code == 409

    def test_register_validation(self, client):
        res = client.post("/api/register", json={"username": "", "password": "123456"})
        assert res.status_code == 400
        res = client.post("/api/register", json={"username": "ok", "password": "12"})
        assert res.status_code == 400

    def test_login_success(self, client):
        client.post("/api/register", json={"username": "logintest", "password": "password123"})
        c2 = app.test_client()
        res = c2.post("/api/login", json={"username": "logintest", "password": "password123"})
        assert res.status_code == 200
        assert res.get_json()["username"] == "logintest"

    def test_login_wrong_password(self, client):
        client.post("/api/register", json={"username": "logintest", "password": "password123"})
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

    def test_typing_indicator(self, admin_client):
        gres = admin_client.post("/api/groups", json={"name": "G1"})
        gid = gres.get_json()["id"]

        # Create second user
        c2 = app.test_client()
        admin_client.post("/api/register", json={"username": "user2", "password": "pass123"})
        # Add user2 to admin's register context won't work, let's use models
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
        assert result["url"].startswith("/static/uploads/")

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


# ── Model Tests ──

class TestModels:
    def test_unread_messages(self):
        uid = models.create_user("u1", hash_password("pass"), "User1")
        uid2 = models.create_user("u2", hash_password("pass"), "User2")
        gid = models.create_group("G1", uid)
        models.add_group_member(gid, uid2)

        result = models.save_message("group", gid, uid, "hello")
        models.add_unread(uid2, result["id"])

        unread = models.get_unread_messages(uid2)
        assert len(unread) == 1
        assert unread[0]["content"] == "hello"

        models.clear_unread(uid2)
        assert len(models.get_unread_messages(uid2)) == 0

    def test_direct_chat(self):
        uid1 = models.create_user("u1", hash_password("pass"), "User1")
        uid2 = models.create_user("u2", hash_password("pass"), "User2")

        chat = models.get_or_create_direct_chat(uid1, uid2)
        assert chat["id"]

        chat2 = models.get_or_create_direct_chat(uid2, uid1)
        assert chat2["id"] == chat["id"]  # same chat regardless of order

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
