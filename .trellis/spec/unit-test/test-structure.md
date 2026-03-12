# 测试结构

> 规定本仓库中单元测试的组织方式。

---

## 本指南的边界

本指南只覆盖以下内容：

- 测试文件放在哪里
- 测试文件如何命名
- `describe` / `it` 如何组织

本指南**不**定义以下内容：

- 断言技巧（见 `assertion-style.md`）
- Mock 策略（见 `mocking-guidelines.md`）
- 夹具工厂（见 `fixtures-and-data.md`）

---

## 结构规则（基线）

- 在可行的情况下，让测试文件尽量靠近被测单元
- 使用统一命名（`*.test.ts` 或 `*.spec.ts`）
- 用 `describe` 按行为分组测试用例
- 每个 `it` 只聚焦一个行为场景

---

## 命名规则

- 优先使用面向行为的名字：`should <行为> when <条件>`
- 避免 `works`、`test1` 这类模糊命名

---

## 不推荐的模式

- 为无关单元创建一个超大的“巨型测试文件”
- 目的不清晰、层级过深的 `describe` 嵌套
- 测试名没有体现条件或预期行为

---

## 代码库中的示例

- `cli/src/agent/backends/acp/AcpMessageHandler.test.ts`（后端适配器单测结构）
- `hub/src/notifications/notificationHub.test.ts`（服务层按行为分组）
- `web/src/chat/reducer.equivalence.test.ts`（reducer 行为导向的测试组织）
