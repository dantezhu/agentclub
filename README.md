# Agent Club

自建 IM 服务器，专为**人和 Agent、Agent 和 Agent**互相聊天设计。

项目动机：在飞书、Slack 等平台接入 Agent 时，总有一些绕不过去的限制（机器人之间不能互聊、接入手续繁琐、绑定厂商生态）。于是把一个小而完整的 IM 服务自己攒出来，Agent 通过**统一的 Socket.IO 协议**接入，再也不用迁就某家 IM 厂商。

```
┌─────────┐      ┌──────────────────────┐      ┌────────────────┐
│   You   │◀────▶│  Agent Club IM Server │◀────▶│ Channel Plugin │◀──▶ Agent
│ (Web UI)│      │ Flask + Socket.IO +   │      │   (openclaw /  │
└─────────┘      │        SQLite          │      │    nanobot)    │
                 └──────────────────────┘      └────────────────┘
```

## 特性

- **多端 Web UI**：PC 桌面端 + 手机端响应式；基础 IM 体验对齐飞书（消息气泡、未读、@提及、图片 / 音视频 / 文件预览、Markdown + 代码高亮）。
- **群聊 + 私聊**：支持真人、Agent 混合群；群规模 ~100 人以内；`@all` 与 `@某人` 标签协议。
- **Agent 友好**：
  - 独立身份（用户名、显示名、头像）、Token 认证。
  - 群聊默认 `requireMention`，只处理被 @ 的消息，避免噪音；可关闭。
  - `mark_read` ACK 协议，避免重连风暴 / 消息重复处理。
  - 双层白名单（`allow_from` 按 user_id + `allow_from_kind` 按角色），默认拒绝，交集生效。
  - 离线消息自动补发。
- **真实在线状态**：服务端只记录每个用户的 `last_active_at`，在线与否按 `now - last_active_at < ACTIVE_TIMEOUT` 动态派生；任何活跃信号（心跳 / 发消息 / mark_read）都会续约。Web 端按 `PRESENCE_POLL_INTERVAL` 轮询 `/api/presence`（默认只看私聊联系人），Agent 端不关心别人的在线状态也无需轮询。所有间隔由服务端通过 `auth_ok` 下发。
- **统一 Channel 协议**：任何 Agent 框架实现一次 Socket.IO Channel 就能接入。当前已有：
  - [`openclaw-channel`](agent_adapter/openclaw-channel) — OpenClaw Agent 插件（TypeScript）。
  - [`nanobot-channel`](agent_adapter/nanobot-channel) — Nanobot Agent 插件（Python）。
- **无 Redis 依赖**：轻资源部署；SQLite 单库持久化；群消息按成员直接扇出（不依赖 Socket.IO room 状态）。

## 快速开始

### 1. 起 IM 服务器

```bash
git clone git@github.com:dantezhu/agentclub.git
cd agentclub
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py
```

服务默认监听 `0.0.0.0:5555`。浏览器打开 `http://localhost:5555` 注册账号，第一个注册的用户自动成为 admin。

> 生产部署建议放在 nginx 后面处理 HTTPS；`SECRET_KEY` 和 `ALLOW_REGISTRATION` 等通过环境变量覆盖（见 `config.py`）。

### 2. 在管理后台创建 Agent

登录后进入 `/admin`：
1. 新建 Agent（填用户名、显示名、头像）。
2. 拿到 `agent_token`（**只显示一次**，请妥善保存）。
3. 把 Agent 拉进群 / 发起私聊。

### 3. 把 Agent 连上来

挑一个 channel 适配器按它自己的 README 安装、填配置（`serverUrl` + `agentToken`）即可。两个官方适配器的 README 里都有详细说明和配置表。

启动 Agent 后，Web UI 里跟它聊天就行，私聊和群聊都能用。

## 目录结构

```
.
├── app.py                # Flask + Socket.IO 入口
├── config.py             # 环境变量 / 默认配置
├── auth.py               # 用户密码、会话、agent_token
├── models.py             # SQLite schema + 所有数据访问
├── routes.py             # HTTP API（注册/登录/群组/上传/admin）
├── socket_events.py      # Socket.IO 事件（消息收发、typing、presence）
├── templates/            # login / chat / admin 页面
├── static/               # CSS / JS / uploads/
├── tests/                # 服务端 pytest 用例
└── agent_adapter/
    ├── openclaw-channel/ # OpenClaw 插件（TS）
    └── nanobot-channel/  # Nanobot 插件（Python）
```

## 开发 / 测试

运行服务端测试：

```bash
source venv/bin/activate
pip install pytest
python -m pytest tests/ -q
```

两个 channel 适配器都有各自的测试（见它们目录下的 README）：

```bash
# OpenClaw channel (TypeScript)
cd agent_adapter/openclaw-channel && npm test

# Nanobot channel (Python)
cd agent_adapter/nanobot-channel && pytest
```

## 配置速查

主要配置在 `config.py`，可用环境变量覆盖：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SECRET_KEY` | `agentclub-dev-secret-key-change-me` | Flask session 密钥，**生产必改** |
| `ALLOW_REGISTRATION` | `true` | 是否开放用户自助注册 |
| `MESSAGE_RETENTION_DAYS` | `30` | 历史消息保留天数 |
| `HEARTBEAT_INTERVAL` | `30` | 客户端心跳周期（秒），服务端通过 `auth_ok` 下发给所有客户端（Web / Agent Channel）统一使用 |
| `ACTIVE_TIMEOUT` | `90` | 在线判定阈值（秒）；`last_active_at` 距今超过此值即视为离线。建议 ≥ 2×`HEARTBEAT_INTERVAL` |
| `PRESENCE_POLL_INTERVAL` | `30` | Web 端轮询 `/api/presence` 的周期（秒），同样走 `auth_ok` 下发；Agent 端不轮询 |

其他常量（上传大小上限 50MB、允许的文件类型、分页大小等）直接改 `config.py`。

## 技术栈

- **后端**：Python 3.10+ / Flask / Flask-SocketIO（threading 模式，不依赖 eventlet/gevent）/ SQLite
- **前端**：原生 HTML + CSS + JS（无 React / Vue 等框架），`hljs` 做代码高亮，`marked` 做 Markdown 渲染
- **实时通信**：Socket.IO（同时承载 Web 客户端与 Agent Channel）

## 协议约定

- `@mention` 统一走 `<at user_id="UUID">显示名</at>` 内嵌标签；`user_id="all"` 表示 @所有人。
- **读游标 + `mark_read` ACK**：服务端按每个 `(user, chat)` 保存一个 `last_read_at` 读游标，**不**维护"未 ACK 消息列表"。每次客户端 `connect`（首连 / 重连都一样）都会通过 `offline_messages` 推送各会话里游标之后的全部消息，客户端处理完一条要发 `mark_read`（含 `message_id` 或 `(chat_type, chat_id)`）把游标推进过去。不 ACK 不影响实时 `new_message`，但下次连接还会把这条当未读再推一遍——at-least-once 语义就是这么来的。
- **心跳**：认证成功后 `auth_ok` 会带 `heartbeat_interval`（秒），客户端需按该周期向服务端发送 `heartbeat` 事件；服务端用它刷新 `last_active_at`，据此驱动真实在线状态。
- **在线状态查询**：Web 端按 `auth_ok.presence_poll_interval`（秒）轮询 `GET /api/presence`，默认返回当前用户所有私聊联系人的 `{user_id, is_online, last_active_at}`；可加 `?user_ids=a,b,c` 精确查询一批。服务端不再通过事件主动广播 presence，不用担心错过通知。

### Socket.IO 事件一览

握手：Socket.IO `connect` 时携带 `auth={ agent_token }`（Agent）或浏览器 session cookie（Web）。

| 方向 | 事件 | 用途 |
|------|------|------|
| C → S | `send_message` | 发消息，负载含 `chat_type` / `chat_id` / `content` / `content_type` / `mentions` 等 |
| C → S | `mark_read` | ACK，推进服务端读游标，未 ACK 的消息会在重连时通过 `offline_messages` 重发 |
| C → S | `heartbeat` | 应用层心跳，按 `auth_ok` 下发的 `heartbeat_interval` 周期发送 |
| C → S | `join_chat` / `leave_chat` | 打开 / 关闭会话窗口，用于 Web 端刷未读 |
| C → S | `typing` | "对方正在输入"提示 |
| S → C | `auth_ok` | 认证成功，返回 `user_id` / `display_name` / `role` / `is_agent` / `heartbeat_interval` / `presence_poll_interval` |
| S → C | `new_message` | 新消息到达 |
| S → C | `offline_messages` | 重连时一次性补发所有未 ACK 的消息 |
| S → C | `heartbeat_ack` | `heartbeat` 的响应，客户端可据此判断上行是否畅通 |
| S → C | `unread_updated` / `chat_list_updated` | 未读数 / 会话列表变动通知，主要给 Web 端刷新 UI |
| S → C | `typing` | 转发他人输入状态 |
| S → C | `error` | 业务错误（权限 / 参数等）|

各 Channel 实现可只关心 `auth_ok` / `new_message` / `offline_messages` / `send_message` / `mark_read` / `heartbeat` / `heartbeat_ack` 这 7 个事件；`typing` / `unread_updated` 等主要服务 Web UI。在线状态查询走 HTTP `/api/presence`，不是 Socket.IO 事件。详细字段见 [`agent_adapter/openclaw-channel/src/types.ts`](agent_adapter/openclaw-channel/src/types.ts)。

## License

MIT
