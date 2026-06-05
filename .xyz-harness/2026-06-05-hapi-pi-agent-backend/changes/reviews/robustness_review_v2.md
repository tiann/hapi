---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 4
  dimensions_checked: 6
  issues_found: 5
  must_fix_count: 0
  low_count: 5
  info_count: 0
  duration_estimate: "10"
---

# Robustness Review v2

## 审查记录
- 审查时间：2026-06-06 02:40
- 审查文件数：4
- 审查维度：D1-D6（全量）
- 基于：v1 审查结果的 3 条 MUST_FIX 修复验证 + 全量回归检查

## v1 MUST_FIX 修复验证

| # | 问题 | 修复方式 | 验证结果 |
|---|------|---------|---------|
| 1 | cleanupAndExit double-cleanup 竞态 | `cleanupInitiated` 布尔守卫 + `safeCleanup()` 包装函数 | ✅ 已修复 |
| 2 | start() 无二次调用保护 | `started` 标志 + warn 日志 | ✅ 已修复 |
| 3 | convertPiEvent 无顶层 try/catch | 整个 switch 包裹 try/catch + debug 日志 | ✅ 已修复 |

### 修复详情

**#1 safeCleanup 守卫** (`runPi.ts` L82-86)
- `cleanupInitiated` 局部布尔变量，确保 `lifecycle.cleanupAndExit()` 只执行一次
- error handler / close handler / finally 三条路径均通过 `safeCleanup()` 入口
- `void safeCleanup()` 在 handler 中正确使用（不 await、不泄漏），finally 中正确 `await`
- override 模式（`origCleanup`）与 guard 无冲突——guard 在 override 外层，先于 resolve 判断

**#2 started 标志** (`PiTransport.ts` L18, L23-26)
- `start()` 入口检查 `this.started`，为 true 时 warn + return
- 标志在 spawn 前设置，即使 spawn 失败也阻止重入（符合语义——transport 不设计为可重启）
- `kill()` / `exited` 不重置 `started`，正确——killed 后应创建新实例

**#3 try/catch 安全网** (`PiEventConverter.ts` L24-90)
- 整个 switch 语句在 try 块内
- catch 中记录 `event.type` 和原始错误，保留上下文
- 返回 `[]` 作为安全降级，不中断事件流
- catch 中 `event.type` 访问安全：调用方 `PiTransport.handleLine` 已保证 `parsed` 是非 null 对象

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 11 | 9 | 2 | 8/10 |
| D2 异常处理 | 8 | 7 | 1 | 8/10 |
| D3 日志 | 9 | 8 | 1 | 9/10 |
| D4 Fail-fast | 7 | 5 | 2 | 7/10 |
| D5 测试友好性 | 7 | 2 | 5 | 3/10 |
| D6 调试友好性 | 7 | 5 | 2 | 7/10 |

**与 v1 对比**：D1 5→8, D2 5→8, D3 6→9, D4 4→7, D6 5→7。D5 未变（不阻塞发布）。

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | LOW | D5 | PiTransport spawn 硬编码，不可注入 | PiTransport.ts | L28 | 通过构造函数参数注入 spawn 函数 |
| 2 | LOW | D5 | runPi 直接 new PiTransport + bootstrapSession，无 DI | runPi.ts | L33, L37 | 通过参数注入 transport 工厂和 session 创建函数 |
| 3 | LOW | D4,D2 | handleResponse 中 `response.command as string` 无运行时校验 | runPi.ts | L109-110 | 用 zod 或手动校验 response shape |
| 4 | LOW | D6 | 日志无 session ID，多实例场景无法区分 | runPi.ts | 全文件 | 在日志中加入 session.id 前缀 |
| 5 | LOW | D5 | 多个 registerXxx 函数直接导入调用，无法隔离测试 | runPi.ts | L55-58 | 将注册逻辑抽为可注入的 setup 函数 |

> 注：v1 的 LOW #4（send 静默丢弃无日志）、#7（default 分支无日志）、#9（start 无入口日志）已在本次修复中一并解决。

## 逐文件详情

### cli/src/pi/PiTransport.ts

**D1 错误处理:**
- ✅ L55-65: `error` 事件正确处理 ENOENT 和通用错误
- ✅ L68-76: `send()` 捕获 EPIPE 并优雅处理，**新增 debug 日志**（v1 #4 修复）
- ✅ L109-112: JSON 解析错误被捕获并跳过

**D2 异常处理:**
- ✅ 错误分类清晰，类型断言仅用于已知 ErrnoException
- ✅ try/catch 范围合理

**D3 日志:**
- ✅ **新增**: L26 start() 入口日志（v1 #9 修复）
- ✅ **新增**: L69 send() 丢弃消息日志（v1 #4 修复）
- ✅ stderr/close/EPIPE/malformed JSON 均有 debug 日志

**D4 Fail-fast:**
- ✅ L23-26: **新增** started 标志阻止 double-start（v1 #2 修复）
- ✅ send() 在 process 为 null 时 debug + return

**D5 测试友好性:**
- ⚠️ spawn 硬编码在 start() 中（与 v1 相同，不阻塞）
- ⚠️ handleStdout/handleLine 为 private（需集成测试覆盖）

**D6 调试友好性:**
- ✅ ENOENT 错误消息清晰
- ✅ `[pi]` 前缀统一
- ⚠️ 无 PID / session ID（与 v1 相同）

### cli/src/pi/PiEventConverter.ts

**D1 错误处理:**
- ✅ **新增**: 顶层 try/catch 安全网（v1 #3 修复）
- ✅ `?? ''` / `?? 0` 默认值保护
- ✅ `message_update` 分支 `if (!ame) return []`

**D2 异常处理:**
- ✅ try/catch 范围覆盖全部业务逻辑
- ✅ catch 中不吞异常——有 debug 日志

**D3 日志:**
- ✅ **新增**: default 分支记录未知事件类型（v1 #7 修复）
- ✅ catch 中记录失败事件类型和错误信息

**D4 Fail-fast:**
- ✅ switch 严格覆盖所有已知 type，default 有日志

**D5 测试友好性:**
- ✅ 纯函数，输入→输出，无副作用

**D6 调试友好性:**
- ✅ catch 日志包含 `event.type`，可定位失败分支
- ✅ unknown type 有 debug 输出

### cli/src/pi/runPi.ts

**D1 错误处理:**
- ✅ **新增**: `safeCleanup` 守卫阻止 double-cleanup（v1 #1 修复）
- ✅ transport error/close 回调正确标记 crash
- ✅ 主 try/catch 捕获未预期异常

**D2 异常处理:**
- ⚠️ `response.command as string` / `response.success as boolean` 类型断言无运行时保障（与 v1 相同）
- ✅ finally 块通过 safeCleanup 安全执行

**D3 日志:**
- ✅ 统一 `[pi]` 前缀
- ✅ RPC 错误、状态变更均有 debug 日志

**D4 Fail-fast:**
- ⚠️ `opts` 参数无校验——`workingDirectory` 可为空字符串（与 v1 相同）
- ⚠️ handleResponse 不校验 response 结构（与 v1 相同）

**D5 测试友好性:**
- ⚠️ 直接 new PiTransport（与 v1 相同）
- ⚠️ 直接调用 bootstrapSession（与 v1 相同）
- ⚠️ registerXxx 直接导入（与 v1 相同）

**D6 调试友好性:**
- ✅ 错误消息包含操作上下文
- ⚠️ 无 session ID（与 v1 相同）

### cli/src/pi/types.ts

**D1-D6**: 无变化，类型定义正确，discriminated union 设计合理。

## 结论

**通过**。v1 的 3 条 MUST_FIX 全部正确修复，修复实现干净无回归：

1. **safeCleanup guard** — 局部布尔守卫简单可靠，与 lifecycle override 模式无冲突
2. **started flag** — 阻止 double-start，warn 日志提供可观测性
3. **try/catch 安全网** — 覆盖完整，catch 日志保留上下文，返回 `[]` 不中断事件流

额外收益：v1 的 3 条 LOW 问题（#4 send 静默丢弃、#7 unknown type 无日志、#9 start 无入口日志）在修复过程中一并解决。

剩余 5 条 LOW 均为 D5（测试友好性）和 D4（参数校验）维度，不阻塞发布，建议后续迭代通过 DI 改善。
