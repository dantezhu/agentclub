# Agent Club - Hermes Channel 决策记录

这个目录暂时只放决策记录，不放可运行代码。

记录时间：2026-04-27。

我们原本想给 Agent Club 增加一个 Hermes Agent channel，让 Hermes Agent 像
现在的 OpenClaw、Nanobot 一样接入 Agent Club IM。但调研后发现，Hermes
目前还不支持把 messaging platform 做成外部插件，所以这次先不实现。

## 这次原本想做什么

Agent Club 现在已经支持两个平台：

- `channels/openclaw-channel/`：OpenClaw 插件，TypeScript 实现。
- `channels/nanobot-channel/`：Nanobot channel，Python 实现。

这次想新增的是：

- `channels/hermes-channel/`
- 目标平台是 Hermes Agent。
- 目标不是改 Agent Club IM 服务端协议，而是让 Hermes Agent 适配现有的
  Agent Club IM Socket.IO 协议。
- 能力上要尽量和 `nanobot-channel` 对齐，而不是只实现一个最小可用的
  “收文本、发文本”版本。

## 已确认的实现边界

讨论过程中先确认了几个方向：

1. 代码不直接写进 Hermes 源码仓库。

   如果要做，也是在本仓库新增 `channels/hermes-channel/`，作为 Agent Club
   侧维护的一套实现或补丁包。

2. 优先目标是“插件化接入 Hermes”。

   不希望为了支持 Hermes 去 fork Hermes，也不希望要求用户手动长期维护一份
   修改过的 Hermes 源码。

3. 配置选项尽量沿用 Nanobot channel。

   也就是说，`allow_from`、`allow_from_kind`、`require_mention` 这些语义
   要保留，不额外设计一套和 Nanobot 不一致的配置模型。

4. 默认安全策略与 Nanobot 一致。

   Nanobot 当前是默认拒绝：`allow_from=[]` 拒绝所有 sender，
   `allow_from_kind=[]` 拒绝所有角色。Hermes 支持如果以后实现，也应保持
   这个行为。

5. 保留 Nanobot 的主动发消息能力。

   Nanobot channel 有 `list_chats()`，可以通过
   `GET /api/agent/chats` 查到当前 agent 参与过、并且有权限写入的群聊和私聊。
   Hermes 如果支持，也不应该丢掉这块能力。

6. 出站附件只支持本地文件。

   Nanobot channel 当前不会替 agent 下载远程 HTTP(S) URL。Hermes 支持如果
   以后实现，也按这个边界来：agent 要先把远程资源下载到本地，再把本地路径
   交给 channel 上传。

7. 会话 key 使用 Agent Club 的 `chat_id`。

   Nanobot 现在就是基于服务端下发的 `chat_id` 做会话身份。`gc_...` 和
   `dc_...` 都是服务端生成的不透明 id，channel 不剥前缀、不改写，出站时也
   原样发回。

8. 暂时不是为了给 Hermes upstream 提 PR。

   这次需求只是自己使用，不需要一开始就按 upstream PR 的完整文档、测试、
   兼容性要求来做。

经过这些确认后，唯一还需要认真确认的问题是：**Hermes 现在到底能不能通过
外部插件注册一个新的 messaging platform adapter。**

## Nanobot 能力清单

如果以后恢复 Hermes 支持，至少要对齐 Nanobot channel 的这些能力：

- 配置项沿用 Nanobot channel 的语义，包括 `enabled`、`server_url`、
  `agent_token`、`allow_from`、`allow_from_kind`、`require_mention`、
  `streaming`。
- `AGENTCLUB_SERVER_URL` 和 `AGENTCLUB_AGENT_TOKEN` 环境变量优先于配置文件，
  方便把服务地址和 token 留在运行环境里。
- Socket.IO 长连接，认证参数是 `auth={"agent_token": token}`。
- 连接恢复能力需要覆盖两类场景：

  1. 首次连接失败：

     插件启动阶段如果 Agent Club server 暂时不可达，要支持逐级退避的无限
     重试，不能因为第一次连接失败就让整个 channel 永久退出。Nanobot 当前
     实现是 `1s, 2s, 4s, 8s, 16s, 30s, 30s...`，上限 30s。

  2. 已连接后断线：

     成功连接之后如果发生断线，要启用 Socket.IO 客户端自己的无限重连机制。
     Nanobot 当前实现是 `reconnection=True`、`reconnection_attempts=0`、
     `reconnection_delay=1`、`reconnection_delay_max=30`；也就是说，断线后
     的重连策略由 `python-socketio` 负责，而不是 channel 自己再套一层
     `_retry_delay_seconds()` 循环。以后做 Hermes 支持时，可以根据 Hermes
     平台生命周期和所选 Socket.IO 客户端的能力，选择在 Socket.IO 客户端层、
     adapter 层或更外层的 runner/monitor 层实现重连；关键要求是断线后不要
     静默退出，要能持续恢复连接。
- 处理 `auth_ok`，记录当前 agent 的 `user_id`、`display_name` 和
  `heartbeat_interval`。
- 处理服务端 `error` 事件和 Socket.IO 断连事件，并留下可排查的日志。
- 处理实时消息 `new_message`。
- 处理重连后的 `offline_messages`。
- 按服务端下发的周期发送 `heartbeat`。
- 对已经消费的入站消息发送 `mark_read`，推进服务端读游标。这里的“消费”
  包括放行给 agent、被 allowlist 拒绝、群聊未 @ 被跳过、空消息被丢弃、
  重复消息被去重等情况；agent 自己的 echo 消息不 ACK，断线或没有
  message id 时也不会发 ACK。
- 本地维护最近 1024 条 message id 的去重窗口，避免重连重放触发重复 agent
  调用。
- 忽略 agent 自己发出的 echo 消息。
- 入站先做 allowlist 过滤，再决定是否交给 agent。
- `allow_from` 和 `allow_from_kind` 做交集：
  - `allow_from=[]` 默认拒绝所有 user id。
  - `allow_from=["*"]` 放行任意 user id。
  - `allow_from_kind=[]` 默认拒绝所有发送者角色。
  - `allow_from_kind` 合法值为 `"*"`, `"human"`, `"agent"`。
- 群聊默认需要 @本 agent 或 @all 才触发。
- 私聊不要求 @，始终视为直接对 agent 说话。
- 保留 Agent Club mention 文本格式：
  - `<at user_id="...">name</at>`
  - 入站文本不把这个标签抹掉。
  - 出站文本里如果出现这个标签，要解析出 user id 并填入 `mentions` 字段。
- 群聊里可以通过 `GET /api/agent/groups/:id/members` 获取成员名册，并给
  agent 注入 roster hint，告诉它如何 @ 群成员。
- 入站附件下载到本地临时文件，再交给 agent。
- 出站本地附件通过 `POST /api/agent/upload` 上传，再用 `send_message` 发出；
  多个附件和文本回复按多条消息发送，附件气泡和文本气泡分开。
- 出站上传结果要按 Agent Club 服务端返回的 `content_type` 归一化为
  `image`、`audio`、`video` 或 `file`，避免图片被当成普通文件展示。
- 当前不实现流式消息。进度提示、工具提示、流式 delta 和 stream end 这类
  内部事件不要直接发到 IM，避免用户看到中间状态。
- 通过 `GET /api/agent/chats` 查询当前 agent 可写入的已有会话，支持主动给
  已有联系人或群聊发消息。

## 对 Hermes 插件能力的确认

我们查了 Hermes 官方文档：

https://hermes-agent.nousresearch.com/docs/developer-guide/adding-platform-adapters

这个文档说明了如何给 Hermes 新增一个 platform adapter，但它描述的是
**改 Hermes 源码内置平台** 的流程，不是外部插件流程。

也就是说，新增平台不是只写一个 `agentclub.py` adapter 就结束了，还要把这个
platform 接进 Hermes 的很多固定位置，例如：

- platform enum / config；
- gateway runner；
- webhook / event 分发；
- CLI setup / status / dump；
- toolsets；
- `send_message` 工具；
- cron job 投递；
- 文档和测试。

我们又查了 Hermes 当前的插件文档：

https://hermes-agent.nousresearch.com/docs/guides/build-a-hermes-plugin

当前 Hermes plugin 文档覆盖的是 tools、hooks、skills 等扩展点。它没有公开
的 `register_platform` 或 `register_adapter` 机制，也没有文档说明可以从
第三方包里注册 Gateway messaging platform。

另外还查到 Hermes 自己的相关 issue：

https://github.com/NousResearch/hermes-agent/issues/3823

这个 issue 讨论的正是未来要做 platform registry / entry-point plugin。
也就是说，Hermes 项目里已经有人在讨论 platform 接入插件化的问题，但相应
机制还没有落地。这里的核心判断不依赖 issue 里的具体数字；官方 platform
adapter 文档本身已经说明新增平台会触及 20+ 个代码、配置和文档文件。

## 结论

Hermes 目前不能像我们希望的那样，通过一个外部插件注册新的 messaging
platform adapter。

所以，如果现在强行做 Hermes 支持，只有两类方案：

1. **改 Hermes 源码或给 Hermes 打补丁。**

   这样可以做成一等公民的 Hermes Gateway platform，但这违背了“不要改
   Hermes 源码、尽量做插件”的目标。

2. **绕开 Hermes Gateway，做外部 bridge。**

   bridge 进程可以连接 Agent Club IM，再用 Hermes 的某些 CLI/API 调 Hermes。
   但这就不是 Hermes Gateway platform 了，会缺失或需要自己重做很多东西：

   - Hermes Gateway 的授权 / allowlist；
   - platform-aware toolset；
   - `send_message` 跨平台投递；
   - cron job 投递；
   - Hermes 原生 session / delivery metadata；
   - CLI setup / status 集成。

这两类方案都不是当前想要的形态。

因此这次决定：**暂时不做 Hermes channel 实现。**

## 以后如果要继续做

以后可以按下面顺序重新评估：

1. 先看 Hermes 是否已经支持 platform registry 或 entry-point 形式的第三方
   messaging platform adapter。

2. 如果 Hermes 已经支持，就把 Agent Club 做成真正的 Hermes platform plugin，
   并复用这里记录的 Nanobot 能力清单。

3. 如果 Hermes 仍然不支持，但我们愿意接受打补丁方案，可以在这个目录维护一套
   patchable bundle，例如：

   - `gateway/platforms/agentclub.py`
   - 配置补丁
   - CLI 补丁
   - toolset / send_message 补丁
   - 单元测试
   - 安装脚本

4. 如果只是临时自用，也可以考虑外部 bridge，但这不是和 Nanobot/OpenClaw
   完全对等的 channel，不建议作为长期方案。

## 当前状态

目前没有写 Hermes channel 代码。

这个目录只是为了留下记录：我们不是忘了做 Hermes，而是确认过 Hermes 当前
没有合适的外部 platform 插件机制，所以先暂停。
