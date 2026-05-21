"""Smoke test against running server: login, create group, agent connects, exchange messages.

Assumes an admin account named ``smoke_admin`` / ``test1234`` already exists.
Seed it once via CLI before the first run::

    agentclub user create smoke_admin --role admin --password test1234

(the web ``/api/register`` endpoint is closed by default and never mints
admins — admin bootstrap is an out-of-band, CLI-only operation.)
"""
import sys
import time
import requests
import socketio

BASE = "http://127.0.0.1:5555"


def main():
    s = requests.Session()
    passed = 0
    failed = 0

    def check(name, condition):
        nonlocal passed, failed
        if condition:
            print(f"  ✅ {name}")
            passed += 1
        else:
            print(f"  ❌ {name}")
            failed += 1

    print("\n=== 1. Admin login ===")
    r = s.post(f"{BASE}/api/login", json={"username": "smoke_admin", "password": "test1234"})
    check("Admin account login", r.status_code == 200 and r.json()["role"] == "admin")

    print("\n=== 2. Get current user ===")
    r = s.get(f"{BASE}/api/me")
    check("Current user info", r.status_code == 200 and r.json()["username"] == "smoke_admin")
    admin_id = r.json()["id"]

    print("\n=== 3. Create agent ===")
    r = s.post(f"{BASE}/api/agents", json={"username": "smoke_bot", "display_name": "Test Bot"})
    check("Create agent", r.status_code == 201)
    agent_token = r.json()["agent_token"]
    agent_id = r.json()["id"]
    print(f"       Agent Token: {agent_token[:16]}...")

    print("\n=== 4. Create group ===")
    r = s.post(f"{BASE}/api/groups", json={"name": "Smoke Test Group"})
    check("Create group", r.status_code == 201)
    group_id = r.json()["id"]

    print("\n=== 5. Add agent to group ===")
    r = s.post(f"{BASE}/api/groups/{group_id}/members", json={"user_id": agent_id})
    check("Add agent to group", r.status_code == 200)

    r = s.get(f"{BASE}/api/groups/{group_id}/members")
    check("Group member count", len(r.json()) == 2)

    print("\n=== 6. Agent file upload ===")
    r = requests.post(f"{BASE}/api/agent/upload",
                       files={"file": ("test.mp3", b"fake audio", "audio/mpeg")},
                       headers={"Authorization": f"Bearer {agent_token}"})
    check("Agent audio file upload", r.status_code == 200 and r.json()["content_type"] == "audio")
    audio_url = r.json()["url"]

    print("\n=== 7. Socket.IO - admin connection ===")
    admin_sio = socketio.Client()
    admin_messages = []
    admin_connected = [False]

    @admin_sio.on("auth_ok")
    def on_auth(data):
        admin_connected[0] = True

    @admin_sio.on("new_message")
    def on_msg(data):
        admin_messages.append(data)

    # Extract session cookie
    cookies = s.cookies.get_dict()
    headers = {"Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items())}
    admin_sio.connect(BASE, headers=headers, transports=["websocket"])
    time.sleep(0.5)
    check("Admin Socket.IO connection", admin_connected[0])

    admin_sio.emit("join_chat", {"chat_type": "group", "chat_id": group_id})
    time.sleep(0.2)

    print("\n=== 8. Socket.IO - agent connection ===")
    agent_sio = socketio.Client()
    agent_connected = [False]
    agent_messages = []

    @agent_sio.on("auth_ok")
    def on_agent_auth(data):
        agent_connected[0] = True

    @agent_sio.on("new_message")
    def on_agent_msg(data):
        agent_messages.append(data)

    agent_sio.connect(BASE, auth={"agent_token": agent_token}, transports=["websocket"])
    time.sleep(0.5)
    check("Agent Socket.IO connection", agent_connected[0])

    agent_sio.emit("join_chat", {"chat_type": "group", "chat_id": group_id})
    time.sleep(0.2)

    print("\n=== 9. Admin sends a message ===")
    admin_sio.emit("send_message", {
        "chat_type": "group",
        "chat_id": group_id,
        "content": "Hello, bot! @smoke_bot",
        "content_type": "text",
        "mentions": ["smoke_bot"],
    })
    time.sleep(0.5)
    check("Agent receives admin message", len(agent_messages) > 0 and "Hello" in agent_messages[-1].get("content", ""))

    print("\n=== 10. Agent sends a message ===")
    agent_sio.emit("send_message", {
        "chat_type": "group",
        "chat_id": group_id,
        "content": "Hello! I am the test bot.",
        "content_type": "text",
    })
    time.sleep(0.5)
    check("Admin receives agent message", any("test bot" in m.get("content", "") for m in admin_messages))

    print("\n=== 11. Agent sends an audio message ===")
    agent_sio.emit("send_message", {
        "chat_type": "group",
        "chat_id": group_id,
        "content": "",
        "content_type": "audio",
        "file_url": audio_url,
        "file_name": "test.mp3",
    })
    time.sleep(0.5)
    audio_msgs = [m for m in admin_messages if m.get("content_type") == "audio"]
    check("Admin receives audio message", len(audio_msgs) > 0)

    print("\n=== 12. Message history query ===")
    r = s.get(f"{BASE}/api/messages/group/{group_id}")
    check("Query message history", r.status_code == 200 and len(r.json()) >= 3)

    print("\n=== 13. Pages are accessible ===")
    r = requests.get(f"{BASE}/")
    check("Login page is accessible", r.status_code == 200 and "Agent Club" in r.text)
    r = requests.get(f"{BASE}/chat")
    check("Chat page is accessible", r.status_code == 200 and "chat.js" in r.text)

    # Cleanup
    admin_sio.disconnect()
    agent_sio.disconnect()

    print(f"\n{'='*40}")
    print(f"Result: {passed} passed, {failed} failed")
    print(f"{'='*40}\n")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
