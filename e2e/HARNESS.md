# E2E Harness

`e2e/harness.ts` 提供端到端测试的可复用 helpers。这些 helpers 来自
2026-06-09 的 TC-WEB-XX 测试（`.xyz-harness/2026-06-09-full-e2e-retest/`），
抽取了 4 个非显然的交互模式：

## 1. `longPress(selector)`

```ts
await longPress('button.session-card')  // 500ms mousedown + mouseup
```

`SessionActionMenu` 由 500ms 长按触发（不是 click）。直接 click 会
打开 session 而不是菜单。

## 2. `mockOffline(online)`

```ts
await mockOffline(false)  // override navigator.onLine + dispatch 'offline' event
```

CDP `Network.emulateNetworkConditions {offline: true}` **不会**触发
`useOnlineStatus` hook。必须直接操作 `navigator.onLine` 并 dispatch
`offline` window 事件。

## 3. `pollForText(match, { timeoutMs, intervalMs })`

```ts
const text = await pollForText(
    (t) => /Reasoning|Thinking/.test(t),
    { timeoutMs: 3000, intervalMs: 300 }
)
```

Thinking/Reasoning 标签 <1s 闪烁，单次 evaluate 抓不到。0.3s 间隔
轮询 3s 稳定捕获。

## 4. `isVisible(selector)`

```ts
isVisible('[role=dialog]')  // 任何 fixed-position dialog 都返回 true
```

`element.offsetParent` 对 `position: fixed` 元素永远返回 `null`
（即使 visible）。用 `getBoundingClientRect()` 替代。

---

## Chrome 生命周期

```ts
import { startChrome, stopChrome } from './harness'

test.beforeAll(async () => { await startChrome() })
test.afterAll(async () => { await stopChrome() })
```

`startChrome` 启动一个 headless Chrome @ 9222（用临时 user-data-dir）。
`stopChrome` 只 kill 自己启动的那个进程（`kill $PID`），不 `pkill chrome`。
如果 9222 已经有进程在跑，start 是 no-op。

## Hub API helpers

```ts
const jwt = await loginWithToken(process.env.HAPI_E2E_TOKEN!)
const sessions = await listSessions(jwt)
```

CLI 用 `CLI_API_TOKEN` 静态 token 经 Socket.IO；Web 用 JWT 经
`Authorization: Bearer`。`loginWithToken` 帮你做交换。

## 设计原则

- **不抢已有 Chrome** — `startChrome` 先 `lsof -i :9222`，已占用就跳过
- **不 `pkill chrome`** — 只 `kill $PID`，遵守 browser-automation 规则
- **shell 注入防护** — `evalInPage` 转义 `"` 和 `$`
- **类型优先** — 全 TypeScript，依赖项目已有的 `@playwright/test`

## 不包含

- 截图（用 `page.screenshot()` 直接调）
- 移动端 viewport（用 `setExtraHTTPHeaders` + `page.setViewportSize`）
- 网络拦截（用 `page.route()`）
- 上述以外的 helper 直接用 Playwright API
