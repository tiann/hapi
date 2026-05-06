# Web 会话大纲全量补全设计

- 日期：2026-05-06
- 范围：`web/`
- 背景版本：CLI `0.17.3`

## 目标

在不放大聊天线程渲染负担的前提下，恢复并增强 Web 会话大纲体验：

1. 打开大纲时，先立即展示当前线程已加载部分。
2. 后台独立扫描完整历史，逐步补全大纲直到全量。
3. 点击未加载到当前线程的老大纲项时，自动补拉历史消息并定位。
4. 会话切换后保留大纲缓存，避免重复全量扫描。

## 非目标

1. 不修改 hub / store / API 协议。
2. 不把聊天线程改成全量加载。
3. 不做 localStorage / IndexedDB 持久化。
4. 不改消息规范化主链路与现有分页协议。

## 现状问题

### 当前大纲来源

当前大纲完全依赖：

`messages -> normalize -> reduce/reconcile -> buildConversationOutline`

因此大纲只覆盖当前 thread window 中的消息；首屏只拿最新窗口，老历史不在窗口里，大纲天然不完整。

### 点击定位问题

现有点击行为假设目标消息已在当前 DOM 中；若目标消息未被当前线程加载，则无法定位。

### 缓存问题

消息窗口缓存已改成会话级内存保留；但 outline 仍然没有独立缓存，无法复用后台扫描结果。

## 方案概览

拆成三条独立数据流：

### 1. 线程流（保留现状）

- 继续使用 `useMessages` + `message-window-store`
- 负责聊天区渲染与轻量滚动窗口
- 不负责大纲完整性

### 2. 大纲流（新增）

- 新增独立 `outline-store`
- 打开大纲面板时启动后台分页扫描
- 直接从分页得到的 `DecryptedMessage[]` 中提取 user outline 项
- 逐页累加到 outline cache
- 扫描结束后标记 `complete=true`

### 3. 定位流（新增）

- 点击大纲项时先检查当前 thread 是否已包含目标消息
- 若已包含：直接滚动定位
- 若未包含：串行调用现有 `onLoadMore` 补拉旧消息，直到命中目标或历史耗尽
- 命中后等待 DOM 渲染完成，再执行滚动

## 状态设计

按 `sessionId` 维护独立 outline state：

- `items`: `ConversationOutlineItem[]`
- `status`: `idle | loading | ready | error`
- `complete`: boolean
- `hasMore`: boolean
- `cursorBeforeAt`: number | null
- `cursorBeforeSeq`: number | null
- `loadedMessageIds`: Set<string>
- `error`: string | null
- `isLocating`: boolean
- `locatingTargetMessageId`: string | null

补充约束：

- 仅采集可见 user 文本消息。
- 同一 message id 只提取一次，避免翻页重叠或 SSE 回补导致重复。
- `items` 按消息创建/调用顺序稳定追加，最终与会话时间线一致。

## 数据提取策略

新增一个更底层的 outline 提取纯函数，避免依赖完整 block/reconcile：

- 输入：`DecryptedMessage` 或 `NormalizedMessage`
- 输出：`ConversationOutlineItem | null`

规则：

1. 仅处理 `role === 'user'`
2. 仅处理可见文本内容
3. label 继续复用现有截断/折叠空白逻辑
4. `targetMessageId` 继续使用现有 anchor 规范，保证与 thread DOM 定位兼容

这样 outline 全量扫描不需要执行整套 reducer / timeline / tool tree 逻辑。

## 缓存策略

### 保留策略

- outline cache 存于内存，生命周期与页面一致
- 切出会话不清空
- 再次进入同一会话：
  - 立即展示缓存项
  - 若 `complete=false`，后台继续从上次 cursor 扫描

### 失效策略

- 收到 `messages-invalidated` 时，重置该会话 outline cache 为 `idle`
- 若当前会话正打开 outline 面板，自动重新开始扫描
- 收到新 `message-received` 且是新的 user 消息时：
  - 若 outline 已 complete，增量 append 新 outline 项
  - 若 outline 正在扫描，仍允许扫描链路继续，依靠 `loadedMessageIds` 去重

## 交互细节

### 打开 outline 面板

1. 先显示当前线程已生成的 outline 项
2. 若缓存为空或未 complete：显示“正在补全大纲…”
3. 每完成一页扫描，面板增量展示更多项
4. 扫描结束后显示“已完整”
5. 扫描失败时显示轻量错误与“重试补全”按钮

### 点击大纲项

#### 目标已在当前线程中
- 直接 `scrollIntoView`
- 关闭面板

#### 目标不在当前线程中
- 面板进入 `isLocating=true`
- 禁用重复点击
- 循环执行：
  1. 检查 `props.messages` 是否已含目标 id
  2. 若没有且 `hasMoreMessages=true`，调用 `onLoadMore()`
  3. 等待本轮消息渲染完成，再继续检查
- 命中后滚动定位并关闭面板
- 若 `hasMoreMessages=false` 仍未命中，给出“未能定位到该消息”提示

## 文件改动

### 新增

- `web/src/lib/outline-store.ts`
  - 独立 outline state / subscribe / hydrate / retry / locate 状态
- `web/src/hooks/queries/useConversationOutline.ts`
  - React hook 封装订阅与操作

### 修改

- `web/src/chat/outline.ts`
  - 增加 message/normalized-message 级 outline 提取函数
- `web/src/components/SessionChat.tsx`
  - 接入新 hook；outline 打开时触发 hydrate；点击时触发 locate
- `web/src/components/AssistantChat/HappyThread.tsx`
  - 面板展示 loading/complete/error/locating 状态；支持 async select
- `web/src/App.tsx` 或 `web/src/hooks/useSSE.ts`
  - 在消息失效/新增事件上驱动 outline cache 失效或增量更新

## 错误处理

1. 扫描分页失败：记录错误状态，不影响聊天线程。
2. 点击定位失败：恢复 `isLocating=false`，展示 toast 或面板内提示。
3. 会话切换中断：通过 sessionId guard 丢弃过期扫描结果。
4. 并发打开/重试：同一 session 只允许一个 hydrate promise 在飞。

## 验证方案

### 功能

1. 长会话打开 outline：立即看到部分项，随后逐步补全到全量。
2. 切换会话再回来：outline 直接复用缓存。
3. 点最新项：直接滚动定位。
4. 点很老的项：自动补拉数页后命中并定位。
5. 消息失效后再次打开：outline 重新补全。

### 回归

1. 聊天线程首屏加载速度无明显回退。
2. 现有向上加载历史能力不退化。
3. message-window 缓存与 outline 缓存不互相干扰。

## 风险与权衡

### 风险

- 超长会话首次补全 outline 仍需后台扫多页
- 点击极老项时，仍需串行补拉线程历史

### 权衡

- 这是最小侵入方案；只改 web，不碰 hub
- 后续若仍需进一步提速，可演进为 hub 侧独立 outline endpoint

## 决策结论

采用“线程轻量 + outline 独立全量补全 + 点击按需补拉定位”的 web 侧方案；先修体验，再决定是否演进 hub API。
