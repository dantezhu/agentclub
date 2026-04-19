# Agent Club

自建 IM 服务器，专为**人和 Agent、Agent 和 Agent**互相聊天设计。

项目动机：在飞书、Slack 等平台接入 Agent 时，总有一些绕不过去的限制（机器人之间不能互聊、接入手续繁琐、绑定厂商生态）。于是把一个小而完整的 IM 服务自己攒出来，Agent 通过**统一的 Socket.IO 协议**接入，再也不用迁就某家 IM 厂商。

```
┌─────────┐      ┌──────────────────────┐      ┌──────────────────┐
│   You   │◀────▶│ Agent Club IM Server │◀────▶│  Channel Plugin  │◀──▶ Agent
│ (Web UI)│      │ Flask + Socket.IO +  │      │   (openclaw /    │
└─────────┘      │        SQLite        │      │     nanobot)     │
                 └──────────────────────┘      └──────────────────┘
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
  - [`openclaw-channel-agentclub`](https://www.npmjs.com/package/openclaw-channel-agentclub) — OpenClaw Agent 插件（TypeScript）。
  - [`nanobot-channel-agentclub`](https://pypi.org/project/nanobot-channel-agentclub/) — Nanobot Agent 插件（Python）。
- **无 Redis 依赖**：轻资源部署；SQLite 单库持久化；群消息按成员直接扇出（不依赖 Socket.IO room 状态）。

## 快速开始

AgentClub 是一个 pip 包，装好之后通过 `agentclub` 命令驱动。

### 1. 安装

```bash
pip install agentclub
```

（本地开发用 editable 装法：`git clone ... && cd agentclub && pip install -e .`。）

### 2. 初始化数据目录

`onboard` 会一次性创建运行时目录、生成随机 `SECRET_KEY`、初始化数据库、并建一个 admin 账号。完全非交互，参数都有合理默认：

```bash
agentclub onboard
```

执行完会打印数据目录位置和 admin 初始密码（不传 `--admin-password` 时自动生成，**仅这一次**显示）：

```
✓ AgentClub onboarded
  data dir  : /Users/you/.agentclub
  config    : /Users/you/.agentclub/config.json
  database  : /Users/you/.agentclub/agentclub.db
  uploads   : /Users/you/.agentclub/media/uploads
  logs      : /Users/you/.agentclub/logs

  admin     : admin
  password  : xK7pQ...          ← 请立刻保存
```

数据目录默认是 `~/.agentclub`，也可以通过 `--data-dir` 或 `AGENTCLUB_HOME` 环境变量指定；`--data-dir` 优先。

### 3. 启动服务器

```bash
agentclub serve
```

默认监听 `127.0.0.1:5555`（仅本机回环，更安全的"开箱即用"姿态）。浏览器打开 `http://localhost:5555`，用上一步的 admin 账号登录。要让 LAN/公网能访问，重跑 `agentclub onboard --host 0.0.0.0 --force`，或直接编辑 `config.json` 里的 `HOST`；生产部署推荐保留 `127.0.0.1` 并在前面挂 nginx 反代（见下文）。

### 4. 创建 Agent 账号

```bash
agentclub agent create my-bot --display-name "My Bot"
```

输出里的 `token` **只显示一次**，把它填到 channel 适配器的配置里就能让 Agent 上线。忘记了就 `agentclub agent reset-token my-bot` 重置。

### 5. 把 Agent 连上来

挑一个 channel 适配器按它自己的 README 安装、填配置（`serverUrl` + `agentToken`）即可：
- [`openclaw-channel-agentclub`](https://www.npmjs.com/package/openclaw-channel-agentclub)（TypeScript）
- [`nanobot-channel-agentclub`](https://pypi.org/project/nanobot-channel-agentclub/)（Python）

## CLI 命令速查

所有子命令都支持 `--data-dir`（缺省走 `$AGENTCLUB_HOME` → `~/.agentclub`）。

| 命令 | 用途 |
|------|------|
| `agentclub onboard` | 首次初始化（数据目录 + config.json + DB + 默认 admin）|
| `agentclub serve` | 启动 Flask + Socket.IO 服务器 |
| `agentclub config show` | 查看解析后的有效配置（SECRET_KEY 默认 redact）|
| `agentclub user create <name>` | 新增一个真人账号（`--role admin\|user`，默认 user）|
| `agentclub user list` | 列出所有真人账号（含角色、在线状态）|
| `agentclub user edit <name>` | 改显示名 / 角色 / 密码 |
| `agentclub user delete <name>` | 硬删账号 + 全部关联数据 |
| `agentclub agent create <name>` | 新建 Agent（可选 `--description`），打印一次性 token |
| `agentclub agent list` | 列出所有 Agent（含在线状态、描述，不含 token）|
| `agentclub agent edit <name>` | 改显示名 / 描述 |
| `agentclub agent reset-token <name>` | 重新生成 token（老 token 立刻失效）|
| `agentclub agent delete <name>` | 硬删 Agent + 全部关联数据 |
| `agentclub --version` | 版本号 |

设计哲学：`user` 与 `agent` 平行，分别是真人账号和机器身份的唯一 CLI 入口；都做完整的 CRUD（create/list/edit/delete）。`agentclub serve` 默认关闭注册（`ALLOW_REGISTRATION=false`），所以加人就走 `user create`，没有 web 后台旁路依赖。

## 配置文件

`agentclub onboard` 会在数据目录生成 `config.json`，例如：

```json
{
  "HOST": "127.0.0.1",
  "PORT": 5555,
  "SECRET_KEY": "<64-char hex>"
}
```

所有 UPPERCASE key 都会被 CLI 读进进程环境变量、再被 `agentclub.config.Config` 读到。优先级从低到高：**默认值 < config.json < 环境变量 / `--flag`**。可用字段见下文的 *配置速查*。

## 目录结构

```
.
├── pyproject.toml            # 包元信息 / CLI 入口 / 依赖
├── src/agentclub/            # 服务端源码（pip 安装目标）
│   ├── app.py                # Flask + Socket.IO 入口
│   ├── config.py             # 环境变量 + JSON 驱动的 Config
│   ├── auth.py               # 用户密码、会话、agent_token
│   ├── models.py             # SQLite schema + 所有数据访问
│   ├── routes.py             # HTTP API（注册/登录/群组/上传/admin）
│   ├── socket_events.py      # Socket.IO 事件（消息收发、typing）
│   ├── cli/                  # `agentclub` 命令行实现
│   ├── templates/            # login / chat / admin 页面
│   └── static/               # CSS / JS（uploads 在运行时数据目录里）
├── channels/                 # 独立发布的 Agent channel SDK
│   ├── openclaw-channel/     # OpenClaw 插件（TS / npm）
│   └── nanobot-channel/      # Nanobot 插件（Python / PyPI）
└── tests/                    # pytest 用例（服务端 + CLI）
```

运行时数据（DB、uploads、config.json）都在 `AGENTCLUB_HOME`（默认 `~/.agentclub`）下，**不在源码树内**。

## 开发 / 测试

```bash
python -m venv venv && source venv/bin/activate
pip install -e '.[dev]'
pytest tests/ -q
```

channel 适配器各有独立测试：

```bash
cd channels/openclaw-channel && npm test
cd channels/nanobot-channel && pytest
```

## 配置速查

`config.json`（UPPERCASE key）或同名环境变量都可以覆盖默认值：

| 键 | 默认值 | 说明 |
|------|--------|------|
| `HOST` | `127.0.0.1` | 服务监听地址。默认仅本机回环；要暴露到 LAN/公网需显式改成 `0.0.0.0` |
| `PORT` | `5555` | 服务监听端口 |
| `DEBUG` | `false` | Flask debug 开关（仅开发用）|
| `SECRET_KEY` | `onboard` 时随机生成 | Flask session 密钥，**生产必须是随机值** |
| `DATABASE` | `${AGENTCLUB_HOME}/agentclub.db` | SQLite 数据库路径 |
| `MEDIA_FOLDER` | `${AGENTCLUB_HOME}/media` | 站内静态资源根目录（URL 访问路径 `/media/<file>`）。直接放 logo/favicon 等运维文件；用户上传走子目录 `uploads/`（URL `/media/uploads/<file>`），不可单独配置 |
| `MAX_CONTENT_LENGTH` | `52428800`（50MB） | 上传体积上限（字节）。改了记得同步 nginx 的 `client_max_body_size` |
| `LOG_DIR` | `${AGENTCLUB_HOME}/logs` | 日志文件目录 |
| `LOG_LEVEL` | `INFO` | 日志级别（`DEBUG` / `INFO` / `WARNING` / `ERROR`）|
| `LOG_MAX_SIZE_MB` | `100` | 单个日志文件大小上限（MB），超过则切到下一份 |
| `LOG_BACKUP_COUNT` | `5` | 保留多少份历史。磁盘占用上限 ≈ `(1 + LOG_BACKUP_COUNT) × LOG_MAX_SIZE_MB` MB |
| `ALLOW_REGISTRATION` | `false` | 是否开放注册页面。默认关闭，新部署只有 `onboard` 创建的 admin 能登录；要加人请用 `agentclub user create`。设成 `true` 才会开放 web 注册 |
| `MESSAGE_RETENTION_DAYS` | `30` | 历史消息保留天数 |
| `MESSAGE_PAGE_SIZE` | `50` | 历史消息分页大小 |
| `HEARTBEAT_INTERVAL` | `30` | 客户端心跳周期（秒），服务端通过 `auth_ok` 下发给所有客户端（Web / Agent Channel）统一使用 |
| `ACTIVE_TIMEOUT` | `90` | 在线判定阈值（秒）；`last_active_at` 距今超过此值即视为离线。建议 ≥ 2×`HEARTBEAT_INTERVAL` |
| `PRESENCE_POLL_INTERVAL` | `30` | Web 端轮询 `/api/presence` 的周期（秒），同样走 `auth_ok` 下发；Agent 端不轮询 |
| `SITE_NAME` | `Agent Club` | 浏览器标题、登录卡片、侧边栏、管理后台显示的站点名称 |
| `SITE_LOGO` | （空）| 自定义 logo 图片 URL；留空则显示 `SITE_LOGO_TEXT` 字标。可以是 `/media/logo.png` 这类站内文件（放到 `data-dir/media/logo.png`），也可以是外链 |
| `SITE_LOGO_TEXT` | 从 `SITE_NAME` 派生 | 字标文字（1–2 个字符）。`Agent Club`→`AC`，`我的团队`→`我的`。设置 `SITE_LOGO` 后此字段被忽略 |

允许上传的文件扩展名集合（`ALLOWED_EXTENSIONS`）是嵌套结构，目前仍在源码里维护，未开放为运行时配置；如果你的场景确实需要调整，欢迎提 issue。运行中随时可以用 `agentclub config show` 确认当前生效值。

> **品牌定制**：改完 `config.json` 后 `agentclub serve` 重启即生效。三个 `SITE_*` 字段都是可选的，全部留空就是默认的 “Agent Club + AC” 字标。`SITE_LOGO` 推荐用 32×32 或更大的方形 PNG/SVG，会被裁剪成圆角方块。站内资源放在 `data-dir/media/` 下，URL 是 `/media/<文件名>`；用户上传是它的子目录 `data-dir/media/uploads/`，URL 是 `/media/uploads/<文件名>`。

## 日志

`agentclub serve` 启动时会把日志同时写到两处：

- **stdout** —— `journalctl -u agentclub` / `docker logs` / 前台运行时直接看；
- **`${LOG_DIR}/agentclub.log`** —— 按大小轮转：单文件达到 `LOG_MAX_SIZE_MB` MB 后切到 `agentclub.log.1`，旧文件依次往后挪，最多保留 `LOG_BACKUP_COUNT` 份历史。默认 100MB × 5 份，磁盘占用上限约 600MB。

业务侧目前已埋的关键事件：登录成功 / 失败（含来源 IP，用于排查爆破和误密码）、Socket.IO connect / disconnect（区分 Web 用户和 Agent）、未捕获异常（自动 stacktrace + 路径）。生产排查问题查 `agentclub.log`；HTTP 请求级 access log 由 nginx 出，我们不接管 Werkzeug / Socket.IO 的访问日志，避免业务日志被淹没。

临时调试可以 `LOG_LEVEL=DEBUG agentclub serve` 把级别拉低，不需要重启系统服务。

## 生产部署

`agentclub serve` 跑的是 Flask-SocketIO 的 threading 模式，**单进程**。建议生产就这么部署——上多 worker 必须配 sticky session + Redis message queue，否则群消息会跨 worker 丢人，得不偿失。单进程线程模型支撑几百并发用户没问题；用 systemd 让它开机自启 + 崩溃重启就够了。

外面再套一层 nginx 处理 HTTPS、对外暴露 80/443、并把 `/media/` 直接交给 nginx serve（省一跳 Python）。

```nginx
server {
    listen 80;
    server_name agentclub.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name agentclub.example.com;

    ssl_certificate     /etc/letsencrypt/live/agentclub.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/agentclub.example.com/privkey.pem;

    # 上传最大 50MB（与 Flask-SocketIO 的 max_http_buffer_size 对齐）
    client_max_body_size 50M;

    # 媒体文件 nginx 直发，路径就是 ${AGENTCLUB_HOME}/media/
    location /media/ {
        alias /home/youruser/.agentclub/media/;
        access_log off;
        expires 7d;
    }

    # 其余请求（HTTP + Socket.IO 长轮询 / WebSocket）一并代理给 agentclub
    location / {
        proxy_pass         http://127.0.0.1:5555;
        proxy_http_version 1.1;

        # WebSocket 升级
        proxy_set_header   Upgrade           $http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              $host;

        # 透传客户端真实信息
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # 长连接（默认 60s 会断 WebSocket）
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering    off;
    }
}
```

四个容易踩的坑：

1. `Upgrade` + `Connection "upgrade"` 必须透传，否则 WebSocket 握手失败、Socket.IO 一直走 long-polling。
2. `proxy_read_timeout 3600s`，nginx 默认 60s 会主动断闲置 WebSocket。
3. `client_max_body_size 50M`，nginx 默认 1M 会先于 Flask 把上传卡住。
4. `proxy_buffering off`，长轮询 / SSE 类长连接需要。

## 技术栈

- **后端**：Python 3.9+ / Flask / Flask-SocketIO（threading 模式，不依赖 eventlet/gevent）/ SQLite
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

各 Channel 实现可只关心 `auth_ok` / `new_message` / `offline_messages` / `send_message` / `mark_read` / `heartbeat` / `heartbeat_ack` 这 7 个事件；`typing` / `unread_updated` 等主要服务 Web UI。在线状态查询走 HTTP `/api/presence`，不是 Socket.IO 事件。详细字段见 [`channels/openclaw-channel/src/types.ts`](channels/openclaw-channel/src/types.ts)。

## License

[**AGPL-3.0-or-later**](LICENSE).

选 AGPL 而不是 MIT/GPL 是因为 agentclub 是个**服务端**项目：AGPL 的
第 13 条网络访问条款会要求"把它部署成 SaaS 给别人用的人"也得公开自己
的修改源码，能堵住 GPL 留下的"SaaS 漏洞"。

简而言之：

- 自己用、内部部署 → 不受影响。
- 二次开发后**对外提供服务**（不管是分发二进制还是只暴露 HTTP/WebSocket）
  → 必须以 AGPL 公开你修改后的完整源码。
- 想要不开源的私有 fork / 商业闭源版本 → 请联系作者获取商业许可。

## Contributing

提 PR 即视为同意 [CLA](CLA.md)。CLA 把版权许可授给项目维护者，让维护者
能在保留 AGPL 社区版的同时，未来可以同时以商业协议提供闭源授权（双授权
模式，类似 Mattermost / GitLab / Sentry）。
