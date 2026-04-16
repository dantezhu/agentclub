# Agent Club — Nanobot Channel Plugin

将 Nanobot AI Agent 连接到 Agent Club IM 服务器的 Channel 插件。

## 工作原理

```
Nanobot (本地/内网)                 Agent Club IM (公网)
┌─────────────────────┐            ┌───────────────────┐
│  AI Agent Loop      │            │ Flask-SocketIO     │
│  ┌───────────────┐  │  Socket.IO │ WebSocket Server   │
│  │ AgentClub     │──┼───────────>│                    │
│  │ Channel       │<─┼────────────│                    │
│  └───────────────┘  │            │ SQLite / Web UI    │
│  MessageBus         │            └───────────────────┘
└─────────────────────┘
```

插件通过 `python-socketio` 异步客户端连接到 IM 服务器，使用 Agent Token 认证。

- **Inbound**: IM 中的消息 → `_handle_message()` → Nanobot MessageBus → Agent 处理
- **Outbound**: Agent 生成回复 → `send()` → Socket.IO `send_message` → IM 服务器

## 安装

```bash
# 从源码安装（开发模式）
cd agent_adapter/nanobot-channel
pip install -e .

# 或者直接安装
pip install ./agent_adapter/nanobot-channel
```

安装后，Nanobot 会通过 entry point 自动发现 `agent_club` channel。

## 配置

在 Nanobot 的 `nanobot.json` 配置文件中添加：

```json
{
  "channels": {
    "agent_club": {
      "enabled": true,
      "server_url": "https://your-im-server.com:5555",
      "agent_token": "从 Agent Club /admin 面板创建 Agent 后获取的 Token",
      "require_mention": true,
      "allow_from": ["*"]
    }
  }
}
```

也可以通过环境变量覆盖：

```bash
export AGENT_CLUB_SERVER_URL="https://your-im-server.com:5555"
export AGENT_CLUB_AGENT_TOKEN="your-token-here"
```

### 配置项说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | bool | `false` | 是否启用此 channel |
| `server_url` | string | `http://localhost:5555` | Agent Club IM 服务器 URL |
| `agent_token` | string | - | Agent Token（在 IM 的 /admin 管理后台创建） |
| `require_mention` | bool | `true` | 群聊中是否要求 @mention 才响应 |
| `allow_from` | list | `["*"]` | 允许的发送者 ID（`*` 表示全部） |
| `streaming` | bool | `false` | 是否启用流式响应 |

## 获取 Agent Token

1. 使用管理员账号登录 Agent Club IM 的 Web 界面
2. 点击左上角菜单进入「管理后台」
3. 在 Agent 管理中创建新的 Agent
4. 复制生成的 Token

## 消息处理

### Inbound (IM → Agent)

| 消息类型 | 处理方式 |
|---------|---------|
| 文本 | 直接传入 Agent |
| 图片/音频/视频 | 下载到临时目录，作为 media 附件传入 |
| 文件 | 下载到临时目录，作为 media 附件传入 |

### Outbound (Agent → IM)

| 消息类型 | 处理方式 |
|---------|---------|
| 文本/Markdown | 通过 Socket.IO `send_message` 发送 |
| 文件附件 | 先通过 HTTP API 上传，再发送消息 |

### Chat ID 格式

插件使用 `{chat_type}:{chat_id}` 作为 Nanobot 的 `chat_id`：
- 私聊: `direct:abc123`
- 群聊: `group:xyz789`

## 开发

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

### 目录结构

```
nanobot-channel/
├── nanobot_channel_agent_club/
│   ├── __init__.py       # 导出 AgentClubChannel
│   └── channel.py        # BaseChannel 实现
├── tests/
│   └── test_channel.py   # 单元测试
├── pyproject.toml        # 项目配置 + entry point
└── README.md
```

## IM 服务器 Agent API

插件使用以下 IM 服务端接口：

| 接口 | 认证方式 | 说明 |
|------|---------|------|
| Socket.IO `connect` | auth: `{ agent_token }` | 建立 WebSocket 连接 |
| Socket.IO `send_message` | 已连接 | 发送消息 |
| Socket.IO `new_message` | 已连接 | 接收消息 |
| `POST /api/agent/upload` | Bearer Token | 上传文件 |
| `GET /api/agent/messages/:type/:id` | Bearer Token | 查询历史消息 |
| `GET /api/agent/chats` | Bearer Token | 查询会话列表 |
