# Mock 规范

> 定义何时以及如何替换依赖。

---

## 本指南的边界

本指南只覆盖依赖替换策略：

- Network / FS / process / clock / randomness 等外部边界
- Mock 的生命周期与隔离方式

本指南**不**定义以下内容：

- 夹具数据构建（见 `fixtures-and-data.md`）
- 断言细节（见 `assertion-style.md`）

---

## Mock 规则（基线）

- 在外部边界做 Mock，而不是在纯领域逻辑内部做 Mock
- 不要 Mock 被测函数本身
- 每个测试用例中的 Mock 应显式且最小化
- 每个测试之间都要 reset / restore Mock

---

## 推荐模式

- 语义清晰的测试替身（test doubles）
- 优先按测试用例单独 setup，而不是全局隐藏行为
- Mock 行为应与当前场景明确绑定

---

## 不推荐的模式

- 全局 Mock 泄漏到其他测试用例
- 过度 Mock，掩盖真实集成假设
- 多个测试共享可变的 Mock 状态

---

## 代码库中的示例

- `cli/src/claude/utils/startHookServer.test.ts`（进程 / 边界 Mock 场景）
- `cli/src/codex/codexRemoteLauncher.test.ts`（launcher 依赖隔离）
- `hub/src/socket/handlers/terminal.test.ts`（socket / handler 边界测试）
