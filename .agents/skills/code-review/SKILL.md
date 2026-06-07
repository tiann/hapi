---
name: code-review
description: >-
  审查 HAPI 项目的代码变更。触发词：code review、代码审查、review 变更、
  审查代码。审查当前 worktree 相对于 main 分支的变更。
---

# Code Review

## 审查范围

```bash
git diff main...HEAD --stat
git diff main...HEAD
```

如有未提交变更，先 `git diff` 查看暂存区。

## 审查维度

### 1. 业务逻辑

- CLI/Hub/Web 三端数据流是否一致（Socket.IO event → sync engine → SSE broadcast）
- Session 状态机转换是否合法（local ↔ remote 模式切换）
- RPC 调用链路完整性（CLI 注册 → hub rpcGateway → CLI handler）
- Message 解析逻辑（shared/messages.ts 的边界处理）

### 2. 架构影响

- **shared 包变更**：shared 被 cli/hub/web 三方消费，任何 breaking change 必须三端同步更新
- **Socket.IO event 变更**：shared/src/socket.ts 的 event 名/参数变更需同步 cli 和 hub
- **Zod schema 变更**：shared/src/schemas.ts 变更影响运行时校验和类型推导
- **模块边界**：cli 不应直接依赖 hub，hub 不应直接依赖 cli，shared 只放纯逻辑
- **workspace 依赖**：检查 package.json 的 workspace: 引用是否正确

### 3. 类型安全

- TypeScript strict 模式，禁止 `any`（用 `unknown` 或具体类型）
- Zod schema 与 TypeScript 类型的一致性
- Socket.IO event 类型的端到端对齐（shared/src/socket.ts）

### 4. 测试

- hub/cli 用 `bun test`，web 用 `vitest run`
- 变更涉及的包必须有对应测试
- 共享逻辑测试放在 shared
- E2E 测试变更需更新 playwright.config.ts

### 5. Bun 特定

- 使用 Bun API 而非 Node.js polyfill（如 `Bun.file()` 代替 `fs.readFile`）
- workspace 依赖用 `workspace:*` 协议
- 脚本用 `bun run` 而非 `npm run`

## 输出格式

```
## 总体评价
Pass / 需修改 / 阻塞

## 发现的问题
| 严重程度 | 包(cli/hub/web/shared) | 位置 | 问题 | 建议 |
|----------|----------------------|------|------|------|

## 亮点
...

## 受影响的包
- [ ] cli
- [ ] hub
- [ ] web
- [ ] shared
```

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 必须遵守 | 严格遵守 |
| `[OPTIONAL]` | 可选 | 可根据项目调整 |
