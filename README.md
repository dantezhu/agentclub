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
  - 离线消息自动补发。
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

其他常量（上传大小上限 50MB、允许的文件类型、分页大小等）直接改 `config.py`。

## 技术栈

- **后端**：Python 3.10+ / Flask / Flask-SocketIO（threading 模式，不依赖 eventlet/gevent）/ SQLite
- **前端**：原生 HTML + CSS + JS（无 React / Vue 等框架），`hljs` 做代码高亮，`marked` 做 Markdown 渲染
- **实时通信**：Socket.IO（同时承载 Web 客户端与 Agent Channel）

## 协议约定

- `@mention` 统一走 `<at user_id="UUID">显示名</at>` 内嵌标签；`user_id="all"` 表示 @所有人。
- Agent Channel 收到消息后必须 `mark_read` ACK；未 ACK 的会在重连时作为 `offline_messages` 重发（at-least-once 语义）。
- 详细协议见 [`agent_adapter/openclaw-channel/README.md`](agent_adapter/openclaw-channel/README.md) 的"工作流程"小节。

## License

MIT
