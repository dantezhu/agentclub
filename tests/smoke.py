"""Smoke test against running server: register, login, create group, agent connects, exchange messages."""
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

    print("\n=== 1. 用户注册 ===")
    r = s.post(f"{BASE}/api/register", json={"username": "smoke_admin", "password": "test1234", "display_name": "管理员"})
    check("注册第一个用户（管理员）", r.status_code == 201 and r.json()["role"] == "admin")

    print("\n=== 2. 获取当前用户 ===")
    r = s.get(f"{BASE}/api/me")
    check("获取当前用户信息", r.status_code == 200 and r.json()["username"] == "smoke_admin")
    admin_id = r.json()["id"]

    print("\n=== 3. 创建 Agent ===")
    r = s.post(f"{BASE}/api/agents", json={"username": "smoke_bot", "display_name": "测试机器人"})
    check("创建 Agent", r.status_code == 201)
    agent_token = r.json()["agent_token"]
    agent_id = r.json()["id"]
    print(f"       Agent Token: {agent_token[:16]}...")

    print("\n=== 4. 创建群组 ===")
    r = s.post(f"{BASE}/api/groups", json={"name": "测试群"})
    check("创建群组", r.status_code == 201)
    group_id = r.json()["id"]

    print("\n=== 5. 添加 Agent 到群组 ===")
    r = s.post(f"{BASE}/api/groups/{group_id}/members", json={"user_id": agent_id})
    check("添加 Agent 到群组", r.status_code == 200)

    r = s.get(f"{BASE}/api/groups/{group_id}/members")
    check("群组成员数量正确", len(r.json()) == 2)

    print("\n=== 6. Agent 文件上传 ===")
    r = requests.post(f"{BASE}/api/agent/upload",
                       files={"file": ("test.mp3", b"fake audio", "audio/mpeg")},
                       headers={"Authorization": f"Bearer {agent_token}"})
    check("Agent 上传音频文件", r.status_code == 200 and r.json()["content_type"] == "audio")
    audio_url = r.json()["url"]

    print("\n=== 7. Socket.IO - 管理员连接 ===")
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
    check("管理员 Socket.IO 连接", admin_connected[0])

    admin_sio.emit("join_chat", {"chat_type": "group", "chat_id": group_id})
    time.sleep(0.2)

    print("\n=== 8. Socket.IO - Agent 连接 ===")
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
    check("Agent Socket.IO 连接", agent_connected[0])

    agent_sio.emit("join_chat", {"chat_type": "group", "chat_id": group_id})
    time.sleep(0.2)

    print("\n=== 9. 管理员发送消息 ===")
    admin_sio.emit("send_message", {
        "chat_type": "group",
        "chat_id": group_id,
        "content": "你好，机器人！@smoke_bot",
        "content_type": "text",
        "mentions": ["smoke_bot"],
    })
    time.sleep(0.5)
    check("Agent 收到管理员消息", len(agent_messages) > 0 and "你好" in agent_messages[-1].get("content", ""))

    print("\n=== 10. Agent 发送消息 ===")
    agent_sio.emit("send_message", {
        "chat_type": "group",
        "chat_id": group_id,
        "content": "你好！我是测试机器人。",
        "content_type": "text",
    })
    time.sleep(0.5)
    check("管理员收到 Agent 消息", any("测试机器人" in m.get("content", "") for m in admin_messages))

    print("\n=== 11. Agent 发送语音消息 ===")
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
    check("管理员收到语音消息", len(audio_msgs) > 0)

    print("\n=== 12. 历史消息查询 ===")
    r = s.get(f"{BASE}/api/messages/group/{group_id}")
    check("查询历史消息", r.status_code == 200 and len(r.json()) >= 3)

    print("\n=== 13. 页面可访问 ===")
    r = requests.get(f"{BASE}/")
    check("登录页可访问", r.status_code == 200 and "Agent Club" in r.text)
    r = requests.get(f"{BASE}/chat")
    check("聊天页可访问", r.status_code == 200 and "chat.js" in r.text)

    # Cleanup
    admin_sio.disconnect()
    agent_sio.disconnect()

    print(f"\n{'='*40}")
    print(f"结果: {passed} 通过, {failed} 失败")
    print(f"{'='*40}\n")

    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
