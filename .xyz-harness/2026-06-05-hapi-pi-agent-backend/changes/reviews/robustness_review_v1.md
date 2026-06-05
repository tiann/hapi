---
verdict: fail
must_fix: 3
review_metrics:
  files_reviewed: 4
  dimensions_checked: 6
  issues_found: 10
  must_fix_count: 3
  low_count: 7
  info_count: 0
  duration_estimate: "15"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-06-06 02:27
- 审查文件数：4
- 审查维度：D1-D6（全量）

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 11 | 5 | 4 | 5/10 |
| D2 异常处理 | 8 | 4 | 3 | 5/10 |
| D3 日志 | 9 | 5 | 3 | 6/10 |
| D4 Fail-fast | 7 | 1 | 5 | 4/10 |
| D5 测试友好性 | 7 | 2 | 4 | 3/10 |
| D6 调试友好性 | 7 | 3 | 3 | 5/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | MUST_FIX | D1,D2 | cleanupAndExit 被多次调用导致 double-cleanup 竞态 | runPi.ts | L75-89, L137-150 | 添加幂等守卫或去重逻辑，确保 cleanup 只执行一次 |
| 2 | MUST_FIX | D1,D4 | start() 无二次调用保护，重复 spawn 泄漏进程 | PiTransport.ts | L22-38 | 添加 `if (this.process) throw/log` 守卫 |
| 3 | MUST_FIX | D1,D2 | convertPiEvent 无顶层 try/catch，意外数据结构直接抛异常 | PiEventConverter.ts | L10-82 | 函数入口加 try/catch，catch 中 log + return [] |
| 4 | LOW | D3,D4 | send() 在 process 为 null/killed 时静默丢弃消息，无 debug 日志 | PiTransport.ts | L66-76 | 添加 `logger.debug('[pi] Dropping message: transport not running')` |
| 5 | LOW | D5 | PiTransport 构造函数直接依赖 spawn，不可注入 | PiTransport.ts | L19 | 通过构造函数/工厂方法注入 spawn 实现 |
| 6 | LOW | D5 | runPi 直接 new PiTransport + bootstrapSession，无 DI | runPi.ts | L25-33 | 通过参数注入 transport 工厂和 session 创建函数 |
| 7 | LOW | D3,D6 | convertPiEvent 的 default 分支静默丢弃未知事件类型 | PiEventConverter.ts | L79 | 添加 `logger.debug(\`[pi] Unknown event type: ${type}\`)` |
| 8 | LOW | D6 | runPi 日志无 session/correlation ID，多实例时无法区分 | runPi.ts | 全文件 | 在日志中加入 session.id 前缀 |
| 9 | LOW | D3 | PiTransport.start() 无入口日志 | PiTransport.ts | L22 | 添加 `logger.info('[pi] Starting Pi process...')` |
| 10 | LOW | D4,D2 | handleResponse 中 `response.command as string` 和 `response.success as boolean` 无运行时校验 | runPi.ts | L99-100 | 用 zod 或手动校验 response shape |

## 逐文件详情

### cli/src/pi/PiTransport.ts

**D1 错误处理:**
- ✅ L55-65: `spawn` 的 `error` 事件正确处理 ENOENT 和通用错误
- ✅ L68-76: `send()` 捕获 EPIPE 并优雅处理
- ✅ L109-112: JSON 解析错误被捕获并跳过
- ❌ L22-38: `start()` 无二次调用保护，重复调用会覆盖 `this.process`，泄漏旧进程

**D2 异常处理:**
- ✅ L55-65: 错误分类（ENOENT vs 通用），转换为用户友好消息
- ✅ L68-75: try/catch 精确区分 EPIPE 和其他错误
- ✅ L109-112: 空 catch 合理——JSONL 流中偶发格式错误可容忍，有 debug 日志

**D3 日志:**
- ✅ stderr/close/EPIPE/malformed JSON 均有 debug 级日志
- ✅ 无敏感数据泄露
- ⚠️ L22: `start()` 被调用时无日志——缺少生命周期关键节点
- ⚠️ L66-76: 消息被静默丢弃时无日志——调用方无法感知发送失败

**D4 Fail-fast:**
- ⚠️ L19: 构造函数不校验 command/args/cwd——可传入空字符串
- ❌ L22: 无 double-start 检查
- ⚠️ L66: `send()` 在 process 为 null 时静默返回——调用方无法知道消息丢失

**D5 测试友好性:**
- ❌ L22: `spawn` 硬编码在 `start()` 中，无法注入 mock
- ⚠️ `handleStdout`/`handleLine` 为 private——需通过集成测试覆盖

**D6 调试友好性:**
- ✅ ENOENT 错误消息清晰（"Pi was not found on PATH"）
- ✅ 日志统一使用 `[pi]` 前缀
- ⚠️ 无进程 PID 或 session ID，多实例场景难以区分

---

### cli/src/pi/PiEventConverter.ts

**D1 错误处理:**
- ✅ 纯函数，无 IO 操作，风险面小
- ✅ 使用 `?? ''` / `?? 0` 默认值保护
- ❌ 无顶层 try/catch 安全网——未来新增 case 分支时可能引入未捕获异常

**D2 异常处理:**
- ⚠️ `event.type as string` 无运行时校验——依赖调用方保证 event 结构
- ✅ `message_update` 分支检查 `if (!ame) return []`
- ✅ `turn_end` 分支用 optional chaining 访问嵌套结构

**D3 日志:**
- N/A: 纯函数不直接产生日志，由调用方（PiTransport）负责

**D4 Fail-fast:**
- ⚠️ 不校验 event 输入形状——`type` 字段缺失时走 default 分支（静默丢弃）
- ⚠️ `tool_execution_start`/`end` 的必填字段（toolCallId, toolName）无校验

**D5 测试友好性:**
- ✅ 纯函数，输入→输出，无副作用——极易测试
- ✅ 无外部依赖

**D6 调试友好性:**
- ⚠️ default 分支静默丢弃未知事件——新增事件类型时无法发现遗漏
- ⚠️ 返回空数组时无区分原因（"未识别的事件" vs "识别但无需转换"）

---

### cli/src/pi/runPi.ts

**D1 错误处理:**
- ✅ L75-89: transport error/close 回调正确标记 crash 并触发 cleanup
- ✅ L137-143: 主 try/catch 捕获未预期异常
- ❌ L75-89 + L147-150: **cleanupAndExit 被多次调用**——error handler / close handler / finally 块均可触发，Promise override + finally 导致 `origCleanup()` 至少执行两次

**D2 异常处理:**
- ❌ Double cleanup 问题（同上 #1）
- ⚠️ L99-100: `response.command as string` / `response.success as boolean`——类型断言无运行时保障，若 Pi 返回非预期格式会静默走错分支
- ⚠️ `finally` 块中 `cleanupAndExit` 可能抛出——但被 Promise 吞掉（void 返回）

**D3 日志:**
- ✅ 统一 `[pi]` 前缀
- ✅ RPC 错误、状态变更均有 debug 日志
- ⚠️ 无 session ID 关联——多实例场景无法追踪

**D4 Fail-fast:**
- ⚠️ L16-19: `opts` 参数无校验——`workingDirectory` 可为空字符串
- ⚠️ L99-100: `handleResponse` 不校验 response 结构

**D5 测试友好性:**
- ❌ L33: `new PiTransport(...)` 直接构造——无法注入 mock transport
- ❌ L25: `bootstrapSession(...)` 直接调用——无法控制 session 创建
- ❌ 多个 `registerXxx` 函数直接导入调用——无法隔离测试

**D6 调试友好性:**
- ✅ 错误消息包含操作上下文（command、model）
- ✅ 日志格式一致
- ⚠️ 无 correlation ID / session ID

---

### cli/src/commands/pi.ts

**D1 错误处理:**
- ✅ L10-18: 顶层 try/catch 覆盖全部初始化和运行逻辑
- ✅ L17: `process.exit(1)` 确保错误时终止

**D2 异常处理:**
- ✅ L14: `instanceof Error` 区分错误类型
- ✅ L16: DEBUG 模式输出完整堆栈

**D3 日志:**
- ✅ chalk.red 区分错误输出
- ✅ DEBUG 环境变量控制详细程度
- ✅ 无敏感数据泄露

**D4 Fail-fast:**
- ✅ 初始化序列严格有序（token → server → auth → run）
- ✅ 任何步骤失败立即退出

**D5 测试友好性:**
- ✅ L13: 动态 `import()` 延迟加载——降低模块耦合
- ⚠️ 整体是副作用链——需 mock 全部依赖才能单测

**D6 调试友好性:**
- ✅ 用户看到清晰错误消息
- ✅ DEBUG 模式有完整堆栈
- ⚠️ 无错误码——用户上报时难以引用具体错误

## 关键问题详解

### #1: cleanupAndExit Double-Cleanup 竞态（MUST_FIX）

**位置**: `runPi.ts` L75-89（error/close handler）+ L137-150（finally block）

**问题链**：
1. Pi 进程退出时，Node.js child_process 同时触发 `error` 和 `close` 事件
2. 两个 handler 都调用 `lifecycle.cleanupAndExit()`
3. `finally` 块再次调用 `lifecycle.cleanupAndExit()`
4. Promise override 只 `resolve()` 一次（幂等），但 `origCleanup()` 被调用 2-3 次

**修复建议**：
```typescript
// 方案 A: 幂等守卫
private cleanupCalled = false;
async cleanupAndExit(codeOverride?: number) {
    if (this.cleanupCalled) return;
    this.cleanupCalled = true;
    // ... 原有逻辑
}

// 方案 B: finally 中不调用，只依赖 handler 触发
// finally 块仅做 setSessionEndReason，不调 cleanupAndExit
```

### #2: start() 无二次调用保护（MUST_FIX）

**位置**: `PiTransport.ts` L22-38

**问题**：`start()` 未检查 `this.process` 是否已存在。重复调用会导致：
- 旧进程的引用丢失（内存泄漏）
- 旧进程的事件 handler 不再被调用（状态不一致）
- 新进程的输出与旧 handler 混淆

**修复建议**：
```typescript
start(): void {
    if (this.process) {
        throw new Error('PiTransport already started');
        // 或 logger.warn + this.kill() 后重新创建
    }
    // ...
}
```

### #3: convertPiEvent 无顶层安全网（MUST_FIX）

**位置**: `PiEventConverter.ts` L10-82

**问题**：函数无 try/catch。虽然当前代码用 `??` 和 optional chaining 防御了大部分情况，但：
- 新增 case 分支时可能遗漏防御
- `event.someNewField.someProperty` 形式的访问会直接抛 TypeError
- 该函数在 PiTransport 的 `onEvent` 回调中调用——异常会导致整个事件流中断

**修复建议**：
```typescript
export function convertPiEvent(event: Record<string, unknown>): AgentMessage[] {
    try {
        const type = event.type as string;
        // ... 现有逻辑
    } catch (err) {
        logger.debug(`[pi] convertPiEvent failed: ${err}`);
        return [];
    }
}
```

## 结论

**需修改**。3 条 MUST FIX 问题影响生产环境稳定性：
1. double-cleanup 竞态可能导致清理逻辑异常
2. double-start 导致进程泄漏
3. converter 无安全网，新事件类型可中断事件流

D5（测试友好性）整体评分最低（3/10），但不阻塞发布，建议后续迭代通过 DI 改善。
