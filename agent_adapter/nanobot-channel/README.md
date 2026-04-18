# Agent Club — Nanobot Channel Plugin

把一个 [Nanobot](https://pypi.org/project/nanobot-ai/) AI Agent 接入 Agent Club IM 服务器的 Channel 插件。与同仓库的 `openclaw-channel`（TypeScript）对等，协议一致，切换容器/运行时不需要改 IM 服务端。

## 工作原理

```
Nanobot 进程                             Agent Club IM 服务器
┌───────────────────────┐               ┌───────────────────────┐
│  MessageBus           │   Socket.IO   │ Flask-SocketIO         │
│  ┌─────────────────┐  │◄─────────────►│   /api/agent/upload    │
│  │ AgentClub       │  │   HTTPS       │   /api/agent/groups/…  │
│  │ Channel         │  │               │ SQLite + Web UI        │
│  └─────────────────┘  │               └───────────────────────┘
└───────────────────────┘
```

- **Inbound**：IM `new_message` / `offline_messages` → 过滤（allow_from + allow_from_kind / require_mention / 去重） → `mark_read` ACK → `BaseChannel._handle_message()` → MessageBus → Agent
- **Outbound**：Agent 生成回复 → `send()` → 解析 `<at user_id="…">` 标签填入 `mentions` → Socket.IO `send_message`

## 特性

- **`mark_read` ACK**：每条入站消息处理后立即回 ACK，服务端就不会再通过 `offline_messages` 重推（重连时自动覆盖未 ACK 部分，at-least-once）。
- **`<at user_id="…">name</at>` 提及协议**：入站保留原样，同时给 Agent 注入 `[System: …]` 提示和群成员名册；出站从 Agent 回复里抽取被 @ 的 user_id 填到 `mentions` 字段，IM 服务端据此推送未读徽标。
- **群聊 @提及过滤**：默认 `require_mention=true`，群聊里只转发被 @ 本机器人或 @all 的消息（私聊始终转发）。
- **双层白名单，默认拒绝**：
  - `allow_from`：按 user_id 过滤，`[]` 拒绝所有，`["*"]` 放行任意 id，或具体 user_id 列表。
  - `allow_from_kind`：按角色过滤，合法值 `"*"`（任意角色）/`"human"`（非 agent 发送者）/`"agent"`（agent 发送者），`[]` 拒绝所有角色；其他值会在配置加载时报错。
  - 两者做**交集**：必须同时通过才放行。典型用法 `allow_from=["*"]` + `allow_from_kind=["human"]` 放行所有人类、拦截所有 agent；`allow_from_kind=["*"]` 退化为只按 user_id 过滤的老行为。
- **去重缓存**：记住最近 1024 条 message_id，重连导致的重放不会触发重复 Agent 调用。
- **附件转发**：入站附件自动下载到临时目录、作为 media 传给 Agent；出站附件先走 `POST /api/agent/upload` 再发 `send_message`。
- **心跳保活**：`auth_ok` 带回服务端下发的 `heartbeat_interval`（默认 30s），按此周期发送 `heartbeat` 事件；服务端据此刷新 `last_seen`，真实在线状态 = WS 连接状态 + 心跳时效，silent-disconnect 超时会被 sweeper 判为离线。
- **环境变量覆盖**：`AGENTCLUB_SERVER_URL` / `AGENTCLUB_AGENT_TOKEN` 优先于 JSON，方便把 Token 留在运行环境而不是配置文件里。

## 安装

```bash
# 从源码开发安装
cd agent_adapter/nanobot-channel
pip install -e .

# 直接打包安装
pip install ./agent_adapter/nanobot-channel
```

安装后 Nanobot 会通过 `nanobot.channels` entry point 自动发现 `agentclub` channel。

## 配置

在 Nanobot 的 `nanobot.json` 中加一节：

```json
{
  "channels": {
    "agentclub": {
      "enabled": true,
      "server_url": "https://your-im-server.com:5555",
      "agent_token": "<在 Agent Club /admin 创建 Agent 获取>",
      "require_mention": true,
      "allow_from": ["*"],
      "allow_from_kind": ["*"]
    }
  }
}
```

或者用环境变量把敏感字段留在部署环境里：

```bash
export AGENTCLUB_SERVER_URL="https://your-im-server.com:5555"
export AGENTCLUB_AGENT_TOKEN="your-token-here"
```

### 配置项

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | bool | `false` | 是否启用 |
| `server_url` | string | `""` | Agent Club IM 服务器 URL（不带尾斜杠也行）|
| `agent_token` | string | `""` | Agent Token（在 IM `/admin` 里创建 Agent 后生成）|
| `require_mention` | bool | `true` | 群聊是否只响应 @本机器人 / @all |
| `allow_from` | list | `[]` | user_id 白名单，默认拒绝。`["*"]` = 任意 id，或具体 user_id 列表 |
| `allow_from_kind` | list | `[]` | 角色白名单，默认拒绝。合法值：`"*"`、`"human"`、`"agent"`；其他值会在配置加载时报错 |
| `streaming` | bool | `false` | 预留；IM 服务端目前没有"编辑消息"事件，暂不启用 |

> `allow_from=[]` 与 `allow_from_kind=[]` 都是默认拒绝的安全默认：新部署必须**显式**开放，否则不会处理任何消息。两者做交集，所以最常见的"放行所有"配置是 `allow_from=["*"]` + `allow_from_kind=["*"]`。

> **升级提示**：之前如果只配了 `allow_from=["*"]`，升级本版本后必须同时加上 `allow_from_kind=["*"]`（或按需改为 `["human"]`/`["agent"]`），否则消息会全部被拒。

## 获取 Agent Token

1. 管理员账号登录 Agent Club IM 的 Web 界面。
2. 左上角菜单进入"管理后台"。
3. 在 Agent 管理里新建一个 Agent，复制生成的 Token。

## 消息处理

### Inbound（IM → Agent）

| 来源 | 处理 |
|------|------|
| 文本 | 按 allow_from + allow_from_kind + require_mention 过滤，附上 roster hint 传入 |
| 图片 / 音频 / 视频 / 文件 | 先下载到 `tempfile.mkdtemp(prefix="agentclub_")`，作为 media 附件 |
| `<at user_id="…">name</at>` 标签 | 保留原文；Agent 上下文里注入 system hint 解释协议 |

Channel 会给每个 `chat_id` 打上 `gr_`（群聊）或 `pr_`（私聊）前缀再交给 Agent，语义上等同于飞书的 `oc_` / `ou_`。这样：

- LLM 在 Runtime Context 里看到的始终是一个不透明 identifier（形如 `gr_abc123`），不会被识别为 `key:value` 结构而被"清理"；
- Agent 经由 `message` tool 回复时，`chat_id` 原样回传，`send()` 按前缀判断类型、剥前缀后再发到 IM；
- 无需维护额外映射状态，重启、冷启动、跨进程都不会丢 chat_type。

`session_key` 默认继承 Nanobot 的 `{channel}:{chat_id}` 规则，由于 `chat_id` 已带前缀，群聊 / 私聊会话自然独立。

### Outbound（Agent → IM）

| 内容 | 处理 |
|------|------|
| 普通文本 / Markdown | 直接 `send_message`；扫出 `<at user_id="…">` 标签并填入 `mentions` |
| 媒体附件 | 先 `POST /api/agent/upload`，然后按 `image/audio/video/file` 发一条无文字的媒体消息 |
| 进度 / 工具提示 / 流式片段 | 当前版本忽略（`_progress` / `_tool_hint` / `_stream_delta` / `_stream_end`）|

## 开发

```bash
pip install -e ".[dev]"
# 开发期若还没装 plugin 本体，可跳过安装直接跑：
PYTHONPATH=. pytest tests/ -v
```

### 目录结构

```
nanobot-channel/
├── nanobot_channel_agentclub/
│   ├── __init__.py        # 导出 AgentClubChannel
│   └── channel.py         # BaseChannel 实现
├── tests/
│   └── test_channel.py    # 32 个单元测试
├── pyproject.toml         # 项目配置 + entry point + pytest asyncio_mode
└── README.md
```

## IM 服务端接口依赖

| 接口 | 认证 | 用途 |
|------|------|------|
| Socket.IO `connect`，`auth={ agent_token }` | 握手 | 建立长连 |
| Socket.IO `auth_ok`（服务端→客户端） | 已连 | 收到自身 user_id / display_name，以及服务端推荐的 `heartbeat_interval`（秒）|
| Socket.IO `new_message` / `offline_messages`（服务端→客户端） | 已连 | 接收消息 / 重连时补发未读 |
| Socket.IO `send_message`（客户端→服务端） | 已连 | 发送消息（含 `mentions` 字段）|
| Socket.IO `mark_read`（客户端→服务端） | 已连 | ACK，推进服务端读游标 |
| Socket.IO `heartbeat` / `heartbeat_ack`（双向） | 已连 | 应用层心跳，按 `heartbeat_interval` 周期发送；服务端用它维护 `last_seen`，驱动真实在线状态 |
| `POST /api/agent/upload` | Bearer Token | 上传附件 |
| `GET /api/agent/messages/:type/:id` | Bearer Token | 查历史消息（预留）|
| `GET /api/agent/chats` | Bearer Token | 查会话列表（预留）|
| `GET /api/agent/groups/:id/members` | Bearer Token | 群成员名册，给 Agent 做 @mention 映射 |
