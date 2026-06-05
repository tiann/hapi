---
phase: plan
verdict: pass
---

# Plan Phase Retrospect — hapi-pi-agent-backend

## Phase Execution Quality

### 做得好的

1. **L1/L2 复杂度判断准确。** 5 个维度全部为 L1，直接产出单文件 plan.md，避免了 L2 的子文档拆分开销。对于 ~500 行新建 + ~9 行修改的规模，L1 判断正确。

2. **Interface Contracts 先行。** 在写 Task 之前先定义了 PiTransport/PiEventConverter 的方法签名和数据类型。这帮助 review subagent 在第一轮就发现了 response 事件处理链断裂——如果不写接口契约，这个问题可能到 dev 阶段才暴露。

3. **Wave 编排采纳了 review 建议。** v1 review 指出 Task 1→Task 2 依赖不必要，修正为并行执行。虽然 Execution Flow 文本未完全同步（review v2 指出的残留问题），但 Dependency Graph 和 Wave Schedule 已正确反映并行关系。

4. **5 个交付物齐全且质量过关。** plan.md、e2e-test-plan.md、test_cases_template.json、use-cases.md、non-functional-design.md 全部一次通过 gate。

### 需要改进的

1. **2 条 MUST_FIX 都是自审应该拦截的问题。**
   - `parseRemoteAgentCommandOptions` 矛盾是明显的文本冲突，self-review 的 placeholder scan 应该发现。
   - response 事件处理链断裂是设计遗漏——在写 Interface Contracts 时就定义了 converter 对 response 返回 `[]`，但没有追问"那谁来处理 response？"。self-review checklist 应该包含"每个被丢弃的事件类型，谁负责处理"。

2. **Execution Flow 文本与 Wave Schedule 不一致。** 修正了 Wave Schedule 但忘记同步 Execution Flow 中的 "depends on Task 1" 标注。虽然不影响 gate，但给执行 subagent 留下歧义。

3. **Runner 无专属单元测试被标记为 LOW 但实际风险不低。** `runPi.ts` 是最复杂的集成点（信号处理、双轨事件分发、keep-alive），仅靠 typecheck + 已有测试覆盖不够。应该在 plan 中明确标注"runner 核心路径由 mock 集成测试覆盖"或拆出一个 `runPi.test.ts`。

## Harness Usability

1. **Review subagent 再次证明价值。** 两轮 plan review 的 MUST_FIX 全部是真实问题（response 事件链断裂、参数解析矛盾），零误报。累计两轮 review 的 false positive rate = 0/6。这比自行 self-check 可靠得多。

2. **SKILL 文档的 L1/L2 分级设计合理。** 5 维度评估表清晰，判断过程可追溯。对于这个 spec，所有 5 个维度都是 L1，决策过程不到 1 分钟。

3. **Execution Flow 模板与实际 Wave 编排脱节。** SKILL 模板中 Execution Flow 是按串行写的（"Task 1 → Task 2 → Task 3"），当 Wave Schedule 改为并行时，Execution Flow 的文本需要手动同步。建议：Execution Flow 直接引用 Wave Schedule，避免两处维护。

4. **use-cases.md 和 non-functional-design.md 对纯技术需求来说有点仪式化。** 这两个文档对纯技术性功能接入（无业务用例、无存储变更）产出价值不高。non-functional-design.md 中 3 个维度标注"不适用"。建议：对于纯技术 spec，允许合并到 plan.md 的子章节而非独立文件。
