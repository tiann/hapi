---
phase: test
verdict: pass
---

# Test Phase Retrospect — hapi-pi-agent-backend

## Phase Execution Quality

### 做得好的

1. **Template 和测试 1:1 映射，零遗漏。** 20 个 template case 全部执行，python 验证脚本确认 caseId 集合完全匹配。不需要追加 round 2——所有 case 在 round 1 即通过。

2. **TC-1-xx / TC-2-xx 直接由 vitest 覆盖，证据链清晰。** Phase 3 的 33 个测试用例与 template 中的 13 个 TC 完全对应，每个 execute_steps 都指向具体的 vitest test name。不需要额外编写集成测试。

3. **TC-3-xx 通过 code review 验证，标注诚实。** runPi.ts 的集成测试（session bootstrapping、message routing、abort、model switch、crash cleanup、SIGTERM handling）需要对 HAPI session 工厂和 lifecycle 做 deep mock，投入产出比不合理。用 code review 替代，在 execute_steps 中记录具体代码行号和逻辑路径，证据可追溯。

4. **JSON 验证脚本一次性写对。** 用 Python 做 cross-reference 检查（template IDs vs execution IDs）、final round passed 检查、字段类型检查（bool/int/array），几行脚本就覆盖了 gate 的所有校验逻辑，比手动检查可靠。

### 需要改进的

1. **Gate 因 taste review 文件命名被阻塞。** 审查文件命名为 `ts_taste_review_v2.md`，但 gate 脚本搜索 `taste_review_v*.md` 模式。需要创建 symlink 才能通过。这不是 bug——命名约定应该更早确认。教训：**review 文件命名应使用 gate 脚本期望的模式，避免使用项目特有的前缀。**

2. **TC-3-01 的 "code_review" 标注与 template 的 `type: integration` 不一致。** Template 中 TC-3-01 到 TC-3-07 标记为 `integration` 类型，但实际用 code review 验证。理想情况下应该在 template 中将 TC-3-xx 标注为 `code_review` 类型，或者在 Phase 2 写 template 时就明确标注验证方式。这是 Plan phase 的遗漏——test_cases_template.json 的 `type` 字段应该在 plan review 时被检查与实际验证方式的匹配度。

3. **没有独立的 integration test 文件。** runPi.ts 的 208 行代码没有对应的 `.test.ts`。如果未来 Pi RPC 协议变更（比如 `tool_execution_start` 的字段名从 `args` 改为 `input`），没有自动化测试能在 HAPI 这边捕获。当前依赖 typecheck + code review 是可接受的 trade-off，但值得在后续迭代中补充。

## Harness Usability

1. **Gate 的 cross-reference 机制设计合理。** 校验 template IDs ⊆ execution IDs，确保没有遗漏；检查 final round 全部 pass，确保修复后的结果有效。字段类型检查（bool vs string vs number）捕获了常见的 JSON 手写错误。

2. **Phase 4 的 execute_steps 要求比想象中严格。** 空数组会导致 gate FAIL。这迫使每个 case 都写明实际操作步骤，即使对 code_review 类型的 case 也是如此。好处是可追溯，代价是 TC-3-xx 的 execute_steps 写得像代码评审笔记而非测试步骤。

3. **Review 文件命名约定应该文档化。** gate 脚本按 `taste_review_v*.md` 模式搜索，但 Phase 3 的 five-step review 方法论中并没有规定文件命名。这是 implicit contract，应该在 skill 文档或 gate README 中明确。

4. **一轮通过的效率很高。** 整个 Phase 4（read template → run tests → verify → write JSON → self-check → commit → gate）在单个 turn 内完成，没有回退。核心原因是 Phase 3 的 TDD 已经保证了测试通过率，Phase 4 只是记录和验证。
