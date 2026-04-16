# Agent Club — OpenClaw Channel Plugin

将 OpenClaw AI Agent 连接到 Agent Club IM 服务器的 Channel 插件。

## 工作原理

```
OpenClaw (本地/内网)                Agent Club IM (公网)
┌─────────────────────┐            ┌───────────────────┐
│  AI Agent Core      │            │ Flask-SocketIO     │
│  ┌───────────────┐  │  Socket.IO │ WebSocket Server   │
│  │ agent-club    │──┼───────────>│                    │
│  │ channel plugin│<─┼────────────│                    │
│  └───────────────┘  │            │ SQLite / Web UI    │
└─────────────────────┘            └───────────────────┘
```

插件通过 Socket.IO 客户端连接到 IM 服务器，使用 Agent Token 认证。连接建立后：

- **Inbound**: 收到 IM 中的消息 → 过滤 → 转发给 OpenClaw AI 处理
- **Outbound**: AI 生成回复 → 通过 Socket.IO 发回 IM 服务器

## 安装

```bash
# 进入插件目录，安装依赖并构建
cd agent_adapter/openclaw-channel
npm install && npm run build

# 安装到 OpenClaw
openclaw plugins install .
```

也可以从其他目录指定完整路径：

```bash
openclaw plugins install /path/to/agent_club/agent_adapter/openclaw-channel
```

> **注意**：必须先执行 `npm install && npm run build` 生成 `dist/` 目录，否则 OpenClaw 无法找到插件入口点。

## 配置

在 OpenClaw 的配置文件中添加：

```json
{
  "channels": {
    "agent-club": {
      "serverUrl": "https://your-im-server.com:5555",
      "agentToken": "从 Agent Club /admin 面板创建 Agent 后获取的 Token",
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

### 配置项说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `serverUrl` | string | 是 | Agent Club IM 服务器的完整 URL |
| `agentToken` | string | 是 | Agent Token（在 IM 的 /admin 管理后台创建） |
| `requireMention` | boolean | 否 | 群聊中是否要求 @mention 才响应，默认 `true` |
| `allowFrom` | string[] | 否 | 限制仅响应指定用户 ID 的消息，空数组表示不限制 |

## 获取 Agent Token

1. 使用管理员账号登录 Agent Club IM 的 Web 界面
2. 点击左上角菜单进入「管理后台」
3. 在 Agent 管理中创建新的 Agent
4. 复制生成的 Token 到上述配置中

## 消息类型支持

| 类型 | Inbound (IM→OpenClaw) | Outbound (OpenClaw→IM) |
|------|----------------------|----------------------|
| 文本/Markdown | 直接传入 | `sendText` |
| 图片 | 描述 + 附件 URL | `sendMedia` → 上传后发送 |
| 音频 | 描述 + 附件 URL | `sendMedia` → 上传后发送 |
| 视频 | 描述 + 附件 URL | `sendMedia` → 上传后发送 |
| 文件 | 描述 + 附件 URL | `sendMedia` → 上传后发送 |

## Session 映射

每个 IM 会话映射为一个独立的 OpenClaw session：

- 私聊: `agent-club:direct:{chatId}`
- 群聊: `agent-club:group:{chatId}`

## 开发

```bash
npm install       # 安装依赖
npm run build     # 编译 TypeScript
npm run dev       # 监听模式编译
npm test          # 运行测试
npm run test:watch # 监听模式测试
```

### 目录结构

```
openclaw-channel/
├── index.ts              # defineChannelPluginEntry 入口
├── setup-entry.ts        # defineSetupPluginEntry 轻量入口
├── src/
│   ├── types.ts          # IM 协议类型定义
│   ├── session.ts        # Session Key 双向映射
│   ├── client.ts         # Socket.IO 客户端封装
│   ├── gateway.ts        # Inbound 消息过滤与转换
│   ├── outbound.ts       # Outbound 发送与文件上传
│   └── channel.ts        # createChatChannelPlugin 主体
├── test/                 # 单元测试
├── package.json
├── tsconfig.json
└── openclaw.plugin.json  # 插件 Manifest
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

## 故障排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `plugin not found: agent-club` | 未构建或 `dist/` 不存在 | 执行 `npm run build` 后重新安装 |
| `serverUrl is required` | 配置缺少 serverUrl | 检查 OpenClaw 配置文件 `channels.agent-club.serverUrl` |
| `Connection error` | IM 服务器不可达 | 检查 serverUrl 地址和端口 |
| `无效的 Token` | Agent Token 错误 | 在 IM 的 /admin 面板重新生成 Token |
