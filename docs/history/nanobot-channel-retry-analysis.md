# nanobot Channel 插件启动失败与重连策略分析

## 结论摘要

和 OpenClaw 相比，**nanobot 这份本地实现里，很多 channel 是插件自己做了进程内重连循环的。**

它更像：

- 每个 channel 自带 supervisor
- channel 自己负责连接恢复
- 发送链路和 provider 链路还有额外 retry
- 外部还有 LaunchAgent/重启脚本作为兜底

因此，如果问题是：

> channel 启动时连接失败，几小时后服务器恢复，是否能自动恢复？

那么在当前本机代码下，**nanobot 的很多 channel，尤其 Feishu / QQ，这方面明显比 OpenClaw 更主动、更强。**

---

## 一、代码来源确认

这次分析不是基于远程仓库猜测，而是直接读取了本机已安装 nanobot 包源码：

- `<local nanobot install>/site-packages/nanobot/`

并确认：

- venv 中存在 `nanobot` 包
- 本机有一个 `restart.sh`
- 本机存在一个 LaunchAgent plist 的重启路径引用

---

## 二、nanobot 的总体风格

nanobot 这套不是“框架统一做所有重连”，而是：

### 整体风格
**各 channel 各自把连接恢复逻辑写在 channel 实现内部。**

也就是说：

- 某个 channel 是否具备长期恢复能力
- 主要取决于该 channel 自己的 `start()` / `_run_*()` 实现

而不是某个统一框架层帮它兜底。

---

## 三、Feishu：明确存在进程内 reconnect loop

**Source:** `<local nanobot install>/site-packages/nanobot/channels/feishu.py`

在 `start()` 里，nanobot 的 Feishu 做了这些事：

1. 创建 Lark client
2. 创建 `lark.ws.Client`
3. 启动一个单独线程 `run_ws`
4. 在线程内部做永久循环

关键逻辑：

```python
while self._running:
    try:
        self._ws_client.start()
    except Exception as e:
        logger.warning("Feishu WebSocket error: {}", e)
    if self._running:
        time.sleep(5)
```

### 这段代码意味着什么

#### 情况 A，首次启动失败
如果 `self._ws_client.start()` 一上来就异常：

- 记录 warning
- sleep 5 秒
- 再尝试一次

#### 情况 B，中途断线
如果运行中 websocket 退出或报错：

- 同样会回到循环
- 继续下一轮

#### 最终判断
**只要 nanobot 主进程没死，Feishu channel 自身就具备“几小时后服务恢复还能自动连回去”的能力。**

这点非常明确，不是推测。

---

## 四、QQ：同样明确存在 auto-reconnect loop

**Source:** `<local nanobot install>/site-packages/nanobot/channels/qq.py`

关键逻辑：

```python
while self._running:
    try:
        await self._client.start(appid=self.config.app_id, secret=self.config.secret)
    except Exception as e:
        logger.warning("QQ bot error: {}", e)
    if self._running:
        logger.info("Reconnecting QQ bot in 5 seconds...")
        await asyncio.sleep(5)
```

### 结论
QQ channel 是标准 supervisor 模式：

- 连接挂了继续拉
- 首次失败也继续重试
- 临时网络问题不会导致整个 channel 生命周期终止

---

## 五、其他 channel 也能看到类似设计

通过本机源码扫描，可以看到以下 channel 也存在明确重连/退避特征：

### 1. DingTalk
**Source:** `nanobot/channels/dingtalk.py`

代码注释和日志里明确出现：

- reconnect loop
- `Reconnecting DingTalk stream in 5 seconds...`

### 2. WhatsApp
**Source:** `nanobot/channels/whatsapp.py`

存在 websocket connect / reconnect 逻辑，日志中有：

- `Reconnecting in 5 seconds...`

### 3. Slack
**Source:** `nanobot/channels/slack.py`

可以看到 `while True` 型运行循环。

### 4. Mochat
**Source:** `nanobot/channels/mochat.py`

存在显式 socket.io reconnect 配置：

- `socket_reconnect_delay_ms`
- `socket_max_reconnect_delay_ms`
- `max_retry_attempts`
- `reconnection=True`
- `reconnection_attempts=self.config.max_retry_attempts or None`

### 5. WeCom
**Source:** `nanobot/channels/wecom.py`

存在明确 websocket reconnect 配置：

- `reconnect_interval`
- `max_reconnect_attempts = -1`（无限）

### 6. Weixin
**Source:** `nanobot/channels/weixin.py`

虽然不是 websocket 常驻模型，但可以看到大量 retry/backoff 设计，例如：

- `BACKOFF_DELAY_S = 30`
- `RETRY_DELAY_S = 2`
- `CONFIG_CACHE_INITIAL_RETRY_S = 2`
- `CONFIG_CACHE_MAX_RETRY_S = 60 * 60`

说明它也有较强的恢复/重试意识。

---

## 六、nanobot 不只是连接重试，发送链路也有统一 retry

**Source:** `<local nanobot install>/site-packages/nanobot/channels/manager.py`

其中存在：

- `_SEND_RETRY_DELAYS = (1, 2, 4)`
- `_send_with_retry(...)`

这说明 nanobot 在 outbound message 上也做了统一重试。

### 这类 retry 适用于

- 发送消息临时失败
- 网络波动
- 平台接口短暂不可用

但它和 channel listener/连接重连不是同一层。

---

## 七、nanobot 的 LLM provider 也有独立 retry 体系

**Source:**

- `nanobot/config/schema.py`
- `nanobot/providers/base.py`
- `nanobot/agent/runner.py`

可确认 nanobot 支持：

- `provider_retry_mode = "standard" | "persistent"`
- provider 侧重试、`retry_after` 提取
- 持久重试模式

但这部分是：

### LLM provider retry
不是 channel 连接重试。

不要混淆：

- channel reconnect
- send retry
- LLM provider retry

nanobot 三层都存在，但作用不同。

---

## 八、nanobot 还有进程外兜底

本机 `restart.sh` 内容：

**Source:** `<local nanobot checkout>/restart.sh`

逻辑是：

- `launchctl unload "$PLIST"`
- `launchctl load "$PLIST"`

对应的 plist 是：

- `<user LaunchAgents>/ai.nanobot.gateway.plist`

### 这意味着 nanobot 有两层恢复能力

#### 第一层，进程内
channel 自己 reconnect

#### 第二层，进程外
LaunchAgent / restart 脚本可以重拉整个进程

所以它的抗事故模式是：

- channel 自恢复为主
- 整体进程拉起为辅

---

## 九、与 OpenClaw 的直接对比

### OpenClaw
更偏：

- 框架托管生命周期
- 插件自己负责连接恢复
- core 不统一兜底启动失败后的长期重连
- Feishu 当前 monitor 外层没看到 supervisor loop

### nanobot
更偏：

- 很多 channel 直接在 `start()` / `_run_*()` 里写 `while self._running`
- channel 自身就是 reconnect supervisor
- manager 层做 send retry
- 进程外还有 LaunchAgent/重启脚本兜底

---

## 十、最关键的判断

如果问：

> “channel 启动时连接失败，过几个小时服务器恢复，谁更容易自己恢复？”

那在当前本机代码下：

## 当前结论
**nanobot > OpenClaw（至少在 Feishu 这条线上非常明确）**

原因不是 nanobot 框架更神，而是：

- **nanobot channel 实现里直接写了 reconnect loop**
- **OpenClaw 的 Feishu monitor 外层没看到这层 supervisor**

---

## 十一、最终结论

### nanobot 的 Feishu
**具备明确的进程内自动重连能力。**

只要：

- nanobot 主进程还活着
- `_running` 没被停掉

那么：

- 首次启动失败也会继续重试
- 中途断线也会继续重试
- 几小时后服务恢复，理论上能自己回来

### nanobot 的整体 channel 设计
也明显偏向：

- channel 自带 supervisor
- 连接失败不是生命周期终点
- 发送链路还有统一 retry
- 再加外部 LaunchAgent 兜底

---

## 十二、极简版结论

- **nanobot 不是靠框架统一兜底所有连接重试**
- **它是很多 channel 自己在实现里直接写了 reconnect loop**
- **至少 Feishu / QQ 这两条线，这点已经被本机源码明确证实**
- **就“几小时后恢复能不能自动连回去”这件事，当前代码下 nanobot 明显强于 OpenClaw**
