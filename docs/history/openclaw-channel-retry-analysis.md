# OpenClaw Channel 插件启动失败与重连策略分析

## 结论摘要

一句话结论：**OpenClaw 框架层不会统一替所有 channel 插件做“启动失败后无限重连”。**

它负责的是：

1. 按账号启动 channel
2. 把 `abortSignal`、runtime、statusSink 传给插件
3. 把每个 channel 的生命周期和网关启动解耦，避免一个坏 channel 卡死整个 gateway
4. 给 outbound API 提供通用 retry 工具

但 **“连接断了怎么重连、启动时连不上过几个小时怎么恢复”这件事，核心责任在具体 channel 插件/其底层 SDK**。如果插件自己不做长期重连，OpenClaw 框架本身**不能保证**几小时后服务恢复时自动连上。

---

## 一、框架层面的确认

### 1. Channel 启动由插件自己的 `startAccount` 负责

OpenClaw 文档明确说明 channel plugin 自己拥有连接平台相关职责。

**Source:** `<local openclaw install>/docs/plugins/sdk-channel-plugins.md#L23-L37`

文档中列出 plugin own 的内容包括：

- Config
- Security
- Pairing
- Session grammar
- **Outbound**
- **Threading**

这意味着“怎么接平台、怎么维持连接”本来就是 plugin/runtime 侧职责，不是 core 统一包办。

---

### 2. 框架提供 lifecycle 容器，不是通用重连器

查看 `channel-lifecycle.core` 相关代码后可以确认，核心能力是：

- 等待 abort
- abort 时清理
- 维持被动任务活着

**Source:** `<local openclaw install>/dist/channel-lifecycle.core-DAu3C_0b.js#L31-L69`

其中 `runPassiveAccountLifecycle(...)` 的本质是“让任务挂着直到 abort”，**不是重连循环本身**。

所以框架提供的是：

- 生命周期托管
- abort 清理
- status sink

而不是：

- 自动无限重试连接
- 自动重建 websocket
- 自动周期性重新启动失败 monitor

---

### 3. 网关会隔离 channel 启动失败，但不会统一兜底长期重试

Changelog 中有关键描述：

> Gateway/channels: keep channel startup sequential while isolating per-channel boot failures, so one broken channel no longer blocks later channels from starting.

**Source:** `<local openclaw install>/CHANGELOG.md`

说明框架层做的是**失败隔离**，不是“失败后替你一直重连”。

也就是说：

- 一个 channel 启动炸了，不会把别的 channel 一起拖死
- 但这个炸掉的 channel 是否之后能自己恢复，要看插件实现

---

### 4. OpenClaw 有通用 retry 工具，但主要用于 API 请求

#### 通用 retry

**Source:** `<local openclaw install>/dist/retry-BQn5Qrea.js`

支持：

- attempts
- minDelayMs
- maxDelayMs
- exponential backoff
- jitter
- `shouldRetry`
- `retryAfterMs`

#### channel API retry policy

**Source:** `<local openclaw install>/dist/retry-policy-kLd2Xctb.js`

默认识别以下可重试错误：

- `429`
- `timeout`
- `connect`
- `reset`
- `closed`
- `unavailable`
- `temporarily`

但它主要适用于：

- 发送消息
- 调 API

它**不能自动替代**“主连接挂了，monitor 要自己再拉起来”这件事。

---

## 二、Feishu 实现的直接源码证据

### 1. Feishu 插件启动时只是把 monitor 拉起来

**Source:** `<local openclaw install>/dist/extensions/feishu/api.js#L1110-L1127`

这里的逻辑就是：

- `gateway.startAccount`
- log `starting feishu[...]`
- 调 `monitorFeishuProvider(...)`
- 把 `abortSignal` 传进去

说明框架层对 Feishu 的处理是：

**“我帮你启动 monitor，你自己负责 monitor 内部怎么活下去。”**

---

### 2. Feishu 当前会话绑定明确依赖 monitor 活着

**Source:** `<local openclaw install>/dist/extensions/feishu/api.js#L3593-L3596`

存在明确报错：

> Feishu current-conversation binding is unavailable because the Feishu account monitor is not active.

这进一步证明：

- monitor 是插件活性的核心
- monitor 不活，很多能力直接失效
- 框架不会额外兜底

---

### 3. Feishu `monitorFeishuProvider` 没有外层永久重试 supervisor

**Source:** `<local openclaw install>/dist/monitor-DKElYpoF.js#L4335-L4381`

关键逻辑：

- resolve account
- `return monitorSingleAccount(...)`
- 多账号时 `Promise.all(monitorPromises)`

这里**没有看到**类似下面这样的外层循环：

```ts
while (!abortSignal.aborted) {
  try {
    await monitorSingleAccount(...)
  } catch (err) {
    ...
  }
  await backoff()
}
```

这意味着：**monitor provider 本身没有实现长期 supervisor。**

---

### 4. `monitorSingleAccount` 直接 await 到 transport 层

**Source:** `<local openclaw install>/dist/monitor-DKElYpoF.js#L4276-L4328`

核心逻辑：

- webhook 模式 -> `await monitorWebhook(...)`
- websocket 模式 -> `await monitorWebSocket(...)`

同样**没有外层重试循环**。

---

### 5. `monitorWebSocket` 只是创建 ws client 然后 `start()`

**Source:** `<local openclaw install>/dist/monitor-DKElYpoF.js#L3579-L3618`

逻辑很直白：

- `createFeishuWSClient(account)`
- `wsClient.start({ eventDispatcher })`
- abort 时 cleanup
- `start()` 抛错就 `reject(err)`

也就是说，从 OpenClaw Feishu monitor 这一层看：

**如果 `start()` 这一步失败，它就是直接往上抛，不会在 monitor 层自己重试。**

---

### 6. Feishu 底层 SDK 自己带 WebSocket 自动重连

从 OpenClaw 打包依赖中可确认底层 Feishu SDK 存在 websocket 自动重连参数，例如：

- `autoReconnect: true`
- `reconnectCount: -1`
- reconnect interval 等参数

因此：

#### 情况 A，启动成功后中途断线
如果 monitor 已成功启动，并且底层 websocket client 建立成功，后续断线恢复**主要依赖底层 SDK autoReconnect**。

#### 情况 B，启动阶段就失败
如果 `wsClient.start()` 在启动阶段就直接失败并向上抛出，那么从 OpenClaw monitor 外层代码来看，**没有看到通用长期重试 supervisor 来兜底。**

这是整个问题里最关键的分界线。

---

## 三、对 OpenClaw 的准确结论

### 框架层负责的

- 生命周期托管
- `abortSignal`
- 状态注入/status sink
- channel 启动失败隔离
- outbound API 通用 retry helper

### 框架层不负责的

- 所有 channel 的统一启动重连
- 启动失败后的长期后台恢复
- 连接断开后的通用自动重拨

---

## 四、最佳实践建议

如果要保证：

> channel 服务器挂了几小时，恢复后插件还能自己连回来

那么插件必须满足下面这些原则。

### 1. `startAccount` 不要把一次连接失败当成生命周期终点

错误模式：

```ts
async function startAccount(ctx) {
  await connectOnce(); // 失败直接 throw
}
```

正确模式：

```ts
while (!abortSignal.aborted) {
  try {
    await connectAndRunUntilDisconnected();
  } catch (err) {
    log(err);
  }
  await sleep(backoff);
}
```

也就是：

- 启动失败 ≠ 生命周期结束
- 启动失败只是一次连接尝试失败
- monitor 仍要活着，持续等恢复

---

### 2. 区分“致命配置错误”和“暂时连接错误”

#### 应立即失败并停住的
- token / secret 错
- 必填配置缺失
- schema/config 不合法
- 明确 401/403 且不会自行恢复
- 本地端口被永久占用且无 fallback

#### 应长期重试的
- DNS 失败
- `ECONNREFUSED`
- `ETIMEDOUT`
- socket closed
- upstream unavailable
- 429 / rate limit
- 服务端维护中

---

### 3. 重连循环必须有指数退避 + 抖动，但不要封顶后停止

推荐策略：

- 1s
- 2s
- 4s
- 8s
- 16s
- 30s
- 60s
- 120s
- 之后维持 120s 或 300s
- 加 10% 到 30% jitter

重点：

- 不要最多重试 10 次后彻底停
- 对暂时错误应长期重试

---

### 4. 连接成功后也要把“连接结束”当作可恢复事件

插件不能只处理 connect failure，还要处理：

- close
- end
- unexpected EOF
- heartbeat timeout
- stale socket
- websocket silent stale

也就是 `connectAndRunUntilDisconnected()` 返回后，外层必须继续下一轮，而不是直接结束 monitor。

---

### 5. 所有后台重连任务都要受 `abortSignal` 控制

OpenClaw lifecycle 明确是用 abort 管理生命周期的。

**Source:** `<local openclaw install>/dist/channel-lifecycle.core-DAu3C_0b.js#L31-L69`

所以插件的重连循环必须：

- 每次 sleep 可中断
- 每次发起连接前检查 abort
- 清理 socket/client/listener
- 避免 gateway reload/restart 时留下孤儿连接

---

### 6. 状态要显式上报

建议状态：

- `starting`
- `connecting`
- `connected`
- `degraded`
- `reconnecting`
- `auth_failed`
- `stopped`

---

### 7. 发送链路 retry 和主连接 retry 分开设计

不要混淆两种 retry：

#### A. API send retry
适用于：

- 429
- timeout
- temporary unavailable

OpenClaw 有现成通用 retry policy。

#### B. listener/monitor reconnect
适用于：

- websocket / long-poll / stream / gateway listener

这个必须由 monitor 自己负责。

---

## 五、最终结论

### 对 OpenClaw 框架层
**不能笼统保证**“channel 启动失败后几小时恢复还能自动连上”。

框架层本身没有看到统一的失败 account 后台永续重启器。

### 对 Feishu 当前实现
- 如果 monitor 已成功运行，后续只是 websocket 断开，恢复概率较高，主要依赖底层 SDK autoReconnect
- 如果启动阶段直接失败并退出 monitor，**从当前 monitor 外层实现看，不会自动长期重试直到恢复**

### 最重要的一句话
**要保证“channel 服务器几小时后恢复也能自动连上”，不能只依赖 OpenClaw 框架层。插件必须自己实现长期存活的连接恢复逻辑，或者至少依赖一个确实支持无限自动重连且不会在首次失败时退出的底层 SDK。**

---

## 六、极简版结论

- **框架层：提供生命周期容器，不兜底长期重连**
- **插件层：必须把 monitor 写成自恢复服务**
- **SDK 层：可以承担 websocket 重连，但不能完全替代插件的外层恢复循环**
